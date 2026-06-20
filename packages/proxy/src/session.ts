import { randomUUID } from 'crypto';
import { EventEmitter } from 'events';
import { ProtocolHandler, createProtocolHandler } from './protocols/index.js';
import type { ProtocolType, ProtocolOptions, ScreenData } from './protocols/index.js';
import type { ConnectionStatus, FieldValue } from 'green-screen-types';
import { getSessionStore, sessionLifecycle } from './session-store.js';

export class Session extends EventEmitter {
  readonly id: string;
  readonly handler: ProtocolHandler;
  readonly protocol: ProtocolType;

  private _status: ConnectionStatus = { connected: false, status: 'disconnected' };
  private _host: string = '';
  private _port: number = 23;
  private _idleTimer: ReturnType<typeof setTimeout> | null = null;
  private _connectWatchdog: ReturnType<typeof setTimeout> | null = null;
  private _lastActivity: number = Date.now();
  /** The options the session was last connected with. Replayed verbatim on
   *  reconnect() so a stable display device name (DEVNAME), code page and
   *  terminal type survive a reconnect — otherwise the host would auto-assign a
   *  fresh QPADEVxxxx and the reattach-by-device-name guarantee would break. */
  private _connectOptions?: ProtocolOptions;
  /** When true (set via the ``autoReconnect`` connect option), the proxy itself
   *  re-establishes the TCP on an UNEXPECTED host drop — replaying the stable
   *  DEVNAME — and emits ``session.reconnected`` so the integrator re-drives only
   *  sign-on, instead of detecting staleness and opening a fresh session. Off by
   *  default (legacy: the integrator owns all recovery). */
  private _autoReconnect = false;
  /** Set on any caller-initiated teardown so the auto-reconnect path stands
   *  down — we only auto-recover from drops we did NOT ask for. */
  private _intentionalClose = false;
  /** Guards the auto-reconnect loop against re-entrancy. */
  private _reconnecting = false;
  /** Server-side single-writer lock. When non-null, an exclusive driver (e.g.
   *  ``agent:<id>`` set by the integrator for the duration of an automated run)
   *  owns input — the proxy rejects WS key/text/cursor commands from anyone else,
   *  so a dashboard operator can't type into a session mid-transaction even if a
   *  client-side guard fails. Null = unlocked (interactive clients may drive). */
  private _driveHolder: string | null = null;

  /** Timeout (ms) to wait for screen data after connect or key send (default 5000) */
  screenTimeout: number = 5000;

  /** Idle timeout (ms) — session auto-destroys if no REST/screen activity.
   *  Safety net for backend crashes; the backend's own keepalive handles
   *  IBM i QINACTITV separately. 30 min is long enough that hot-reload
   *  restarts and slow startup sequences don't race against this timer. */
  static IDLE_TIMEOUT = 30 * 60 * 1000;

  /** Default connect-watchdog deadline (ms) for a session pinned in
   *  'connecting'. The idle timer only arms AFTER a successful connect, so a
   *  connect that never completes — a TCP blackhole (SYN with no SYN-ACK/RST),
   *  or a reject the caller forgot to tear down — would otherwise leave the
   *  session in the store forever holding a half-open socket. This watchdog is
   *  the backstop: 30s default socket connectTimeout + the grace below. */
  static CONNECT_TIMEOUT = 45 * 1000;

  /** Grace (ms) added on top of the socket's own connectTimeout before the
   *  watchdog reaps. Keeps the watchdog strictly a backstop — the socket-level
   *  timeout/reject (and the caller's error handling) get first crack at a
   *  failed connect; the watchdog only fires when that path doesn't. */
  static CONNECT_WATCHDOG_GRACE = 15 * 1000;

  /** Backoff schedule (ms) for proxy-driven auto-reconnect after an unexpected
   *  host drop. Bounded + capped so a host that's truly down can't be stormed
   *  (respects IBM i QMAXSIGN); on exhaustion the session reports ``session.lost``
   *  and the integrator's own reconnect policy takes over. */
  static RECONNECT_BACKOFF_MS = [2000, 4000, 8000, 15000, 30000];

  constructor(protocol: ProtocolType = 'tn5250') {
    super();
    this.id = randomUUID();
    this.protocol = protocol;
    this.handler = createProtocolHandler(protocol);

    this.handler.on('screenChange', (screenData: ScreenData) => {
      this.touch();
      this.emit('screenChange', screenData);
    });
    this.handler.on('disconnected', () => {
      this._status = { connected: false, status: 'disconnected', protocol: this.protocol, host: this._host };
      this.stopIdleTimer();
      this.emit('statusChange', this._status);
      // Auto-reconnect path: an UNEXPECTED drop on an autoReconnect session is
      // recovered in place (proxy re-establishes the TCP on the same DEVNAME).
      // We do NOT emit session.lost here — that would unbind the connect-by-key
      // mapping and let a fresh session open. session.lost is emitted only if
      // auto-reconnect exhausts its attempts.
      if (this._autoReconnect && !this._intentionalClose) {
        this._attemptAutoReconnect().catch(() => { /* loop is self-contained */ });
        return;
      }
      sessionLifecycle.emit('session.lost', this.id, this._status);
    });
    this.handler.on('error', (err: Error) => {
      this._status = { connected: false, status: 'error', protocol: this.protocol, host: this._host, error: err.message };
      this.emit('statusChange', this._status);
      // For an autoReconnect session, let the ensuing disconnect drive recovery
      // (don't unbind the key via session.lost first).
      if (!(this._autoReconnect && !this._intentionalClose)) {
        sessionLifecycle.emit('session.lost', this.id, this._status);
      }
      // Close the upstream TCP socket on unrecoverable protocol errors.
      // Without this, a parser exception would leak the half-open 5250
      // session on the host until the 5-min idle timeout — and on IBM i
      // with LMTDEVSSN=*YES that counts against the user's session quota.
      try { this.handler.disconnect(); } catch { /* ignore */ }
    });
  }

  /** Reset idle timer — called on any API activity (screen read, key send, etc.) */
  touch(): void {
    this._lastActivity = Date.now();
  }

  /** Start the idle timer. Call after connection is established. */
  startIdleTimer(): void {
    this.stopIdleTimer();
    this._idleTimer = setInterval(() => {
      if (Date.now() - this._lastActivity > Session.IDLE_TIMEOUT) {
        console.log(`[Session ${this.id.slice(0, 8)}] Idle timeout (${Session.IDLE_TIMEOUT / 1000}s) — signing off`);
        // Graceful SIGNOFF + TCP close, not a bare destroy: a hard drop leaves
        // the IBM i QPADEV device hanging (it accumulates and, under churn,
        // trips QMAXSIGN/QAUTOVRT and gets disabled). Best-effort + non-blocking.
        void gracefullyDestroySession(this.id).catch(() => { /* best-effort */ });
      }
    }, 30_000); // Check every 30s
  }

  /** Stop the idle timer. */
  stopIdleTimer(): void {
    if (this._idleTimer) {
      clearInterval(this._idleTimer);
      this._idleTimer = null;
    }
  }

  /** Arm the connect watchdog. Called when the session enters 'connecting'.
   *  If it's still 'connecting' when the deadline elapses, the session never
   *  connected — destroy it so it can't leak in the store. A successful
   *  connect (or any teardown) clears it first. */
  private startConnectWatchdog(deadlineMs: number): void {
    this.stopConnectWatchdog();
    this._connectWatchdog = setTimeout(() => {
      this._connectWatchdog = null;
      // Reap only if the session never left 'connecting'. A successful
      // connect flips status to 'connected'/'authenticated' (and clears this
      // timer); a connect that hung — or rejected without the caller tearing
      // the session down — is still pinned here.
      if (this._status.status !== 'connecting') return;
      console.log(`[connect-reap] Session ${this.id.slice(0, 8)} stuck in 'connecting' for ${Math.round(deadlineMs / 1000)}s — destroying (never connected)`);
      // Bare destroy, not a graceful SIGNOFF: the TCP connect never
      // completed, so there is no signed-on host job to end. This closes any
      // half-open socket and drops the store entry.
      destroySession(this.id);
    }, deadlineMs);
  }

  /** Stop the connect watchdog. */
  private stopConnectWatchdog(): void {
    if (this._connectWatchdog) {
      clearTimeout(this._connectWatchdog);
      this._connectWatchdog = null;
    }
  }

  get status(): ConnectionStatus {
    return { ...this._status };
  }

  /** The current exclusive input owner, or null when unlocked. */
  get driveHolder(): string | null {
    return this._driveHolder;
  }

  /** Claim exclusive input for ``holder``. Idempotent for the same holder;
   *  refused (returns false) if a different holder already owns it. */
  acquireDrive(holder: string): boolean {
    if (this._driveHolder && this._driveHolder !== holder) return false;
    this._driveHolder = holder;
    return true;
  }

  /** Release the input lock. A ``holder`` mismatch is ignored (returns false)
   *  so a stale releaser can't free a lock it doesn't own; pass no holder to
   *  force-release (teardown). */
  releaseDrive(holder?: string): boolean {
    if (holder !== undefined && this._driveHolder && this._driveHolder !== holder) return false;
    this._driveHolder = null;
    return true;
  }

  /** Mark this session as authenticated after a successful auto-sign-in */
  markAuthenticated(username: string): void {
    this._status = {
      ...this._status,
      status: 'authenticated',
      username,
    };
    this.emit('statusChange', this._status);
  }

  async connect(host: string, port: number, options?: ProtocolOptions): Promise<void> {
    this._host = host;
    this._port = port;
    // Remember the options so reconnect() can replay them (esp. DEVNAME).
    this._connectOptions = options;
    // Opt-in proxy-driven recovery: when set, an unexpected host drop is
    // re-established in place rather than surfaced as a lost session.
    this._autoReconnect = !!(options as { autoReconnect?: boolean } | undefined)?.autoReconnect;
    this._intentionalClose = false;
    this._status = { connected: false, status: 'connecting', protocol: this.protocol, host };
    this.emit('statusChange', this._status);

    // Arm the connect watchdog before awaiting the handshake. Sit it beyond
    // the socket's own connectTimeout (default 30s) so it only fires when the
    // socket-level timeout/reject fails to. If handler.connect() hangs or
    // rejects without the caller cleaning up, the watchdog reaps the session.
    const socketConnectTimeout = options?.connectTimeout;
    const deadlineMs = typeof socketConnectTimeout === 'number' && socketConnectTimeout > 0
      ? socketConnectTimeout + Session.CONNECT_WATCHDOG_GRACE
      : Session.CONNECT_TIMEOUT;
    this.startConnectWatchdog(deadlineMs);

    await this.handler.connect(host, port, options);

    this.stopConnectWatchdog();
    this._status = { connected: true, status: 'connected', protocol: this.protocol, host };
    this.touch();
    this.startIdleTimer();
    this.emit('statusChange', this._status);
  }

  disconnect(): void {
    this._intentionalClose = true;
    this.stopIdleTimer();
    this.stopConnectWatchdog();
    this.handler.disconnect();
    this._status = { connected: false, status: 'disconnected', protocol: this.protocol, host: this._host };
    this.emit('statusChange', this._status);
  }

  async reconnect(): Promise<void> {
    this.disconnect();
    // Replay the original connect options so the reconnect keeps the same
    // stable device name / code page / terminal type — without them the host
    // auto-assigns a fresh QPADEVxxxx and the device-reattach guarantee breaks.
    await this.connect(this._host, this._port, this._connectOptions);
  }

  /**
   * Proxy-driven recovery from an UNEXPECTED host drop (autoReconnect sessions
   * only). Re-establishes the TCP with the original connect options (so the
   * stable DEVNAME makes IBM i reattach the disconnected job instead of minting
   * a fresh QPADEVxxxx), with bounded backoff. On success it emits
   * ``session.reconnected`` with ``needsSignOn`` so the integrator re-drives only
   * its sign-on cascade (the proxy holds no credentials). On exhaustion it emits
   * ``session.lost`` and the integrator's own reconnect policy takes over.
   */
  private async _attemptAutoReconnect(): Promise<void> {
    if (this._reconnecting || this._intentionalClose) return;
    this._reconnecting = true;
    // Tell watchers the proxy has taken ownership of recovery so an integrator
    // with its own stale-detection/watchdog stands down instead of racing us
    // into a second reconnect. We always conclude with session.reconnected
    // (success) or session.lost (exhaustion), so the integrator never defers
    // forever.
    sessionLifecycle.emit('session.reconnecting', this.id);
    const schedule = Session.RECONNECT_BACKOFF_MS;
    try {
      for (let attempt = 0; attempt < schedule.length; attempt++) {
        await new Promise((r) => setTimeout(r, schedule[attempt]));
        if (this._intentionalClose) return;
        this._status = { connected: false, status: 'connecting', protocol: this.protocol, host: this._host };
        this.emit('statusChange', this._status);
        try {
          await this.handler.connect(this._host, this._port, this._connectOptions);
        } catch (err) {
          console.warn(`[auto-reconnect] Session ${this.id.slice(0, 8)} attempt ${attempt + 1}/${schedule.length} failed: ${err instanceof Error ? err.message : String(err)}`);
          continue;
        }
        if (this._intentionalClose) { try { this.handler.disconnect(); } catch { /* ignore */ } return; }
        this._status = { connected: true, status: 'connected', protocol: this.protocol, host: this._host };
        this.touch();
        this.startIdleTimer();
        this.emit('statusChange', this._status);
        console.log(`[auto-reconnect] Session ${this.id.slice(0, 8)} re-established TCP on attempt ${attempt + 1} — signalling needsSignOn`);
        sessionLifecycle.emit('session.reconnected', this.id, { needsSignOn: true });
        return;
      }
      console.warn(`[auto-reconnect] Session ${this.id.slice(0, 8)} exhausted ${schedule.length} attempts — reporting lost`);
      sessionLifecycle.emit('session.lost', this.id, this._status);
    } finally {
      this._reconnecting = false;
    }
  }

  sendText(text: string): boolean {
    return this.handler.sendText(text);
  }

  sendKey(keyName: string): boolean {
    return this.handler.sendKey(keyName);
  }

  setCursor(row: number, col: number): boolean {
    return this.handler.setCursor(row, col);
  }

  eraseEOF(): boolean {
    return this.handler.eraseEOF();
  }

  getScreenData() {
    return this.handler.getScreenData();
  }

  /** Read input field values from the current screen.
   *  @param modifiedOnly — when true (default), only fields with MDT bit set. */
  readFieldValues(modifiedOnly: boolean = true): FieldValue[] {
    this.touch();
    return this.handler.readFieldValues(modifiedOnly);
  }

  /** Wait until the next screen has at least `minFields` input fields (or timeout). */
  waitForScreenWithFields(minFields: number, timeoutMs: number): Promise<ScreenData> {
    this.touch();
    return this.handler.waitForScreenWithFields(minFields, timeoutMs);
  }

  /** Wait for the next screenChange event, or return current screen after timeout */
  waitForScreen(timeoutMs: number): Promise<ScreenData> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => resolve(this.handler.getScreenData()), timeoutMs);
      this.handler.once('screenChange', (data: ScreenData) => {
        clearTimeout(timer);
        resolve(data);
      });
    });
  }

  /** Send a remote key and wait for the host response — race-free.
   *  Sets up the screenChange listener BEFORE sending the key so fast
   *  host responses are never missed. */
  sendKeyAndWait(keyName: string, timeoutMs: number): Promise<{ ok: boolean; screen: ScreenData }> {
    return new Promise((resolve) => {
      const onScreen = (data: ScreenData) => {
        clearTimeout(timer);
        resolve({ ok: true, screen: data });
      };

      const timer = setTimeout(() => {
        this.handler.removeListener('screenChange', onScreen);
        resolve({ ok: true, screen: this.handler.getScreenData() });
      }, timeoutMs);

      // Listener registered BEFORE sendKey to close the race window
      this.handler.once('screenChange', onScreen);

      const ok = this.handler.sendKey(keyName);
      if (!ok) {
        clearTimeout(timer);
        this.handler.removeListener('screenChange', onScreen);
        resolve({ ok: false, screen: this.handler.getScreenData() });
      }
    });
  }

  destroy(): void {
    this._intentionalClose = true;
    this.stopIdleTimer();
    this.stopConnectWatchdog();
    this.handler.destroy();
    this.removeAllListeners();
  }

  /**
   * Graceful teardown for user-initiated disconnects. When the session is
   * authenticated and the protocol supports SIGNOFF (TN5250), type SIGNOFF
   * into the command line and wait briefly for the host to end the
   * interactive job before dropping the TCP socket. Falls back to a plain
   * destroy() for non-authenticated sessions and other protocols. Callers
   * MUST still call destroySession() after awaiting this method — the
   * store entry is not removed here.
   */
  async gracefulDestroy(timeoutMs: number = 1500): Promise<void> {
    this._intentionalClose = true;
    this.stopIdleTimer();
    this.stopConnectWatchdog();
    const isAuth = this._status.status === 'authenticated';
    if (isAuth && typeof (this.handler as any).attemptSignOff === 'function') {
      try {
        await (this.handler as any).attemptSignOff(timeoutMs);
      } catch {
        // best-effort — fall through to hard disconnect
      }
    }
    this.handler.destroy();
    this.removeAllListeners();
  }
}

// Session manager — delegates to the active SessionStore (default
// in-memory). Integrators can swap the store via setSessionStore() before
// any routes/websockets are mounted.

export function createSession(protocol: ProtocolType = 'tn5250'): Session {
  const session = new Session(protocol);
  getSessionStore().set(session.id, session);
  return session;
}

export function getSession(id: string): Session | undefined {
  return getSessionStore().get(id);
}

export function destroySession(id: string): void {
  const store = getSessionStore();
  const session = store.get(id);
  if (session) {
    session.destroy();
    store.delete(id);
  }
}

/**
 * User-initiated graceful disconnect — tries to sign off at the host
 * before closing the TCP socket, then removes the store entry. Used by
 * the REST /disconnect endpoint and the WebSocket 'disconnect' message.
 */
export async function gracefullyDestroySession(id: string, timeoutMs: number = 1500): Promise<void> {
  const store = getSessionStore();
  const session = store.get(id);
  if (!session) return;
  try {
    await session.gracefulDestroy(timeoutMs);
  } finally {
    store.delete(id);
  }
}

export function getDefaultSession(): Session | undefined {
  const store = getSessionStore();
  if (store.size() === 1) {
    return store.values().next().value as Session;
  }
  return undefined;
}

export function getAllSessions(): Session[] {
  return Array.from(getSessionStore().values());
}
