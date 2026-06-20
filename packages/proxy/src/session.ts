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
  private _keepaliveTimer: ReturnType<typeof setInterval> | null = null;
  private _connectWatchdog: ReturnType<typeof setTimeout> | null = null;
  private _lastActivity: number = Date.now();
  /** The options the session was last connected with. Replayed verbatim on
   *  reconnect() so a stable display device name (DEVNAME), code page and
   *  terminal type survive a reconnect — otherwise the host would auto-assign a
   *  fresh QPADEVxxxx and the reattach-by-device-name guarantee would break. */
  private _connectOptions?: ProtocolOptions;

  /** Timeout (ms) to wait for screen data after connect or key send (default 5000) */
  screenTimeout: number = 5000;

  /** Absolute idle backstop (ms) — session auto-signs-off after this long with
   *  NO external (client) activity. This is purely an abandonment safety net:
   *  the proxy-owned keepalive ({@link startKeepalive}) keeps the host session
   *  warm independently, and the keepalive deliberately does NOT count as
   *  activity here — otherwise an abandoned session (backend crashed without an
   *  explicit /disconnect) would be kept alive forever and leak the host device.
   *  Hours-long so a merely-idle-but-live agent (no documents for a while) is
   *  never torn down; only genuine abandonment is. Override via
   *  GS_SESSION_IDLE_TIMEOUT_MS. */
  static IDLE_TIMEOUT = Number(process.env.GS_SESSION_IDLE_TIMEOUT_MS) || 4 * 60 * 60 * 1000;

  /** Idle keepalive cadence (ms). When the session has seen no external
   *  activity for this long, the proxy sends a benign below-app-layer keepalive
   *  (TN5250 TEST_REQUEST) to reset the host inactivity timer (IBM i QINACTITV),
   *  so the durable connection survives quiet periods longer than QINACTITV with
   *  NO dependency on a backend keepalive. Must stay comfortably below the host
   *  QINACTITV (IBM i default 10 min). Override via GS_KEEPALIVE_INTERVAL_MS. */
  static KEEPALIVE_INTERVAL = Number(process.env.GS_KEEPALIVE_INTERVAL_MS) || 4 * 60 * 1000;

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
      this.stopKeepalive();
      this.emit('statusChange', this._status);
      sessionLifecycle.emit('session.lost', this.id, this._status);
    });
    this.handler.on('error', (err: Error) => {
      this._status = { connected: false, status: 'error', protocol: this.protocol, host: this._host, error: err.message };
      this.emit('statusChange', this._status);
      sessionLifecycle.emit('session.lost', this.id, this._status);
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

  /** Start the proxy-owned idle keepalive. Call after a successful connect.
   *  Fires every KEEPALIVE_INTERVAL; on each tick, if no EXTERNAL activity has
   *  reset the host inactivity timer within the interval, sends a benign
   *  below-app-layer keepalive (TN5250 TEST_REQUEST). The idle-gate means the
   *  keepalive can only land after a full interval of silence — never
   *  mid-transaction — and it deliberately does NOT touch() the activity clock,
   *  so the absolute idle backstop still catches a genuinely abandoned session. */
  startKeepalive(): void {
    this.stopKeepalive();
    this._keepaliveTimer = setInterval(() => {
      if (!this._status.connected) return;
      // Real client input within the window already reset the host inactivity
      // timer — skip, so we never add redundant traffic or race a transaction.
      if (Date.now() - this._lastActivity < Session.KEEPALIVE_INTERVAL) return;
      try {
        if (this.handler.sendKeepAlive()) {
          console.log(`[keepalive] Session ${this.id.slice(0, 8)} idle ${Math.round((Date.now() - this._lastActivity) / 1000)}s — sent host keepalive`);
        }
      } catch {
        // best-effort — a transient send failure must not kill the timer
      }
    }, Session.KEEPALIVE_INTERVAL);
  }

  /** Stop the keepalive timer. */
  stopKeepalive(): void {
    if (this._keepaliveTimer) {
      clearInterval(this._keepaliveTimer);
      this._keepaliveTimer = null;
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
    this.startKeepalive();
    this.emit('statusChange', this._status);
  }

  disconnect(): void {
    this.stopIdleTimer();
    this.stopKeepalive();
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
    this.stopIdleTimer();
    this.stopKeepalive();
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
    this.stopIdleTimer();
    this.stopKeepalive();
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
