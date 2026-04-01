import { randomUUID } from 'crypto';
import { EventEmitter } from 'events';
import { ProtocolHandler, createProtocolHandler } from './protocols/index.js';
import type { ProtocolType, ProtocolOptions, ScreenData } from './protocols/index.js';
import type { ConnectionStatus } from 'green-screen-types';

export class Session extends EventEmitter {
  readonly id: string;
  readonly handler: ProtocolHandler;
  readonly protocol: ProtocolType;

  private _status: ConnectionStatus = { connected: false, status: 'disconnected' };
  private _host: string = '';
  private _port: number = 23;
  private _idleTimer: ReturnType<typeof setTimeout> | null = null;
  private _lastActivity: number = Date.now();

  /** Timeout (ms) to wait for screen data after connect or key send (default 5000) */
  screenTimeout: number = 5000;

  /** Idle timeout (ms) — session auto-destroys if no activity. Default 5 min.
   *  Prevents stale TCP sessions when the backend crashes or misses a disconnect call. */
  static IDLE_TIMEOUT = 5 * 60 * 1000;

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
    });
    this.handler.on('error', (err: Error) => {
      this._status = { connected: false, status: 'error', protocol: this.protocol, host: this._host, error: err.message };
      this.emit('statusChange', this._status);
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
        console.log(`[Session ${this.id.slice(0, 8)}] Idle timeout (${Session.IDLE_TIMEOUT / 1000}s) — destroying`);
        destroySession(this.id);
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
    this._status = { connected: false, status: 'connecting', protocol: this.protocol, host };
    this.emit('statusChange', this._status);

    await this.handler.connect(host, port, options);

    this._status = { connected: true, status: 'connected', protocol: this.protocol, host };
    this.touch();
    this.startIdleTimer();
    this.emit('statusChange', this._status);
  }

  disconnect(): void {
    this.stopIdleTimer();
    this.handler.disconnect();
    this._status = { connected: false, status: 'disconnected', protocol: this.protocol, host: this._host };
    this.emit('statusChange', this._status);
  }

  async reconnect(): Promise<void> {
    this.disconnect();
    await this.connect(this._host, this._port);
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

  getScreenData() {
    return this.handler.getScreenData();
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
    this.handler.destroy();
    this.removeAllListeners();
  }
}

// Session manager
const sessions = new Map<string, Session>();

export function createSession(protocol: ProtocolType = 'tn5250'): Session {
  const session = new Session(protocol);
  sessions.set(session.id, session);
  return session;
}

export function getSession(id: string): Session | undefined {
  return sessions.get(id);
}

export function destroySession(id: string): void {
  const session = sessions.get(id);
  if (session) {
    session.destroy();
    sessions.delete(id);
  }
}

export function getDefaultSession(): Session | undefined {
  if (sessions.size === 1) {
    return sessions.values().next().value as Session;
  }
  return undefined;
}

export function getAllSessions(): Map<string, Session> {
  return sessions;
}
