import { randomUUID } from 'crypto';
import { EventEmitter } from 'events';
import { ProtocolHandler, ProtocolType, ScreenData, createProtocolHandler } from './protocols/index.js';

export interface SessionStatus {
  connected: boolean;
  status: 'disconnected' | 'connecting' | 'connected' | 'authenticated' | 'error';
  protocol?: ProtocolType;
  host?: string;
  username?: string;
  error?: string;
}

export class Session extends EventEmitter {
  readonly id: string;
  readonly handler: ProtocolHandler;
  readonly protocol: ProtocolType;

  private _status: SessionStatus = { connected: false, status: 'disconnected' };
  private _host: string = '';
  private _port: number = 23;

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

  get status(): SessionStatus {
    return { ...this._status };
  }

  async connect(host: string, port: number): Promise<void> {
    this._host = host;
    this._port = port;
    this._status = { connected: false, status: 'connecting', protocol: this.protocol, host };
    this.emit('statusChange', this._status);

    await this.handler.connect(host, port);

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

  getScreenData() {
    return this.handler.getScreenData();
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
