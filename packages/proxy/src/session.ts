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

  /** Timeout (ms) to wait for screen data after connect or key send (default 2000) */
  screenTimeout: number = 2000;

  constructor(protocol: ProtocolType = 'tn5250') {
    super();
    this.id = randomUUID();
    this.protocol = protocol;
    this.handler = createProtocolHandler(protocol);

    this.handler.on('screenChange', (screenData: ScreenData) => {
      this.emit('screenChange', screenData);
    });
    this.handler.on('disconnected', () => {
      this._status = { connected: false, status: 'disconnected', protocol: this.protocol, host: this._host };
      this.emit('statusChange', this._status);
    });
    this.handler.on('error', (err: Error) => {
      this._status = { connected: false, status: 'error', protocol: this.protocol, host: this._host, error: err.message };
      this.emit('statusChange', this._status);
    });
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
    this.emit('statusChange', this._status);
  }

  disconnect(): void {
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

  destroy(): void {
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
