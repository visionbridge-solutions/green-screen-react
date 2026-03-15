import type { TerminalAdapter, ScreenData, ConnectionStatus, SendResult, ConnectConfig } from './types';

export interface WebSocketAdapterOptions {
  /** URL of the green-screen proxy or worker. Auto-detected from env vars, defaults to http://localhost:3001 */
  workerUrl?: string;
}

/**
 * WebSocket adapter that connects to a green-screen proxy or Cloudflare Worker.
 * The backend holds the TCP connection to the legacy host and relays protocol data.
 *
 * Unlike RestAdapter (which polls over HTTP), this adapter receives real-time
 * screen updates via WebSocket push.
 *
 * workerUrl resolution order:
 *   1. Explicit `workerUrl` option
 *   2. VITE_GREEN_SCREEN_URL / VITE_WORKER_URL (Vite)
 *   3. NEXT_PUBLIC_GREEN_SCREEN_URL (Next.js)
 *   4. REACT_APP_GREEN_SCREEN_URL (CRA)
 *   5. http://localhost:3001
 */
export class WebSocketAdapter implements TerminalAdapter {
  private workerUrl: string;
  private ws: WebSocket | null = null;
  private screen: ScreenData | null = null;
  private status: ConnectionStatus = { connected: false, status: 'disconnected' };
  private pendingScreenResolver: ((value: ScreenData | null) => void) | null = null;
  private pendingConnectResolver: ((result: SendResult) => void) | null = null;
  private connectingPromise: Promise<void> | null = null;
  private screenListeners: Set<(screen: ScreenData) => void> = new Set();
  private statusListeners: Set<(status: ConnectionStatus) => void> = new Set();

  constructor(options: WebSocketAdapterOptions = {}) {
    this.workerUrl = (
      options.workerUrl
      || WebSocketAdapter.detectEnvUrl()
      || 'http://localhost:3001'
    ).replace(/\/+$/, '');
  }

  private static detectEnvUrl(): string | undefined {
    try {
      if (typeof import.meta !== 'undefined' && (import.meta as any).env) {
        const env = (import.meta as any).env;
        return env.VITE_GREEN_SCREEN_URL || env.VITE_WORKER_URL || undefined;
      }
    } catch { /* import.meta not available */ }
    try {
      // Use indirect eval to avoid static analysis picking up 'process' as a Node global
      const p = typeof globalThis !== 'undefined' && (globalThis as any).process;
      if (p && p.env) {
        return p.env.NEXT_PUBLIC_GREEN_SCREEN_URL
          || p.env.REACT_APP_GREEN_SCREEN_URL
          || undefined;
      }
    } catch { /* process not available */ }
    return undefined;
  }

  /** Subscribe to real-time screen updates */
  onScreen(listener: (screen: ScreenData) => void): () => void {
    this.screenListeners.add(listener);
    return () => this.screenListeners.delete(listener);
  }

  /** Subscribe to status changes */
  onStatus(listener: (status: ConnectionStatus) => void): () => void {
    this.statusListeners.add(listener);
    return () => this.statusListeners.delete(listener);
  }

  async getScreen(): Promise<ScreenData | null> {
    return this.screen;
  }

  async getStatus(): Promise<ConnectionStatus> {
    return this.status;
  }

  async sendText(text: string): Promise<SendResult> {
    return this.sendAndWaitForScreen({ type: 'text', text });
  }

  async sendKey(key: string): Promise<SendResult> {
    return this.sendAndWaitForScreen({ type: 'key', key });
  }

  async connect(config?: ConnectConfig): Promise<SendResult> {
    await this.ensureWebSocket();

    if (!config) {
      return { success: false, error: 'ConnectConfig required' };
    }

    return new Promise((resolve) => {
      const timeout = setTimeout(() => {
        this.pendingConnectResolver = null;
        resolve({ success: false, error: 'Connection timeout' });
      }, 30000);

      this.pendingConnectResolver = (result: SendResult) => {
        clearTimeout(timeout);
        resolve(result);
      };

      this.wsSend({
        type: 'connect',
        host: config.host,
        port: config.port,
        protocol: config.protocol,
        username: config.username,
        password: config.password,
      });
    });
  }

  async disconnect(): Promise<SendResult> {
    this.wsSend({ type: 'disconnect' });
    this.status = { connected: false, status: 'disconnected' };
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
    return { success: true };
  }

  async reconnect(): Promise<SendResult> {
    return { success: false, error: 'Use disconnect() then connect() instead' };
  }

  /** Close the WebSocket without sending disconnect */
  dispose(): void {
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
  }

  private async ensureWebSocket(): Promise<void> {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) return;
    if (this.connectingPromise) return this.connectingPromise;

    this.connectingPromise = new Promise<void>((resolve, reject) => {
      const wsUrl = this.workerUrl.replace(/^http/, 'ws') + '/ws';
      this.ws = new WebSocket(wsUrl);

      this.ws.onopen = () => resolve();
      this.ws.onerror = () => reject(new Error('WebSocket connection failed'));

      this.ws.onmessage = (event) => {
        try {
          const msg = JSON.parse(event.data);
          this.handleMessage(msg);
        } catch { /* ignore non-JSON messages */ }
      };

      this.ws.onclose = () => {
        this.status = { connected: false, status: 'disconnected' };
        for (const listener of this.statusListeners) listener(this.status);
      };
    }).finally(() => {
      this.connectingPromise = null;
    });

    return this.connectingPromise;
  }

  private handleMessage(msg: any): void {
    switch (msg.type) {
      case 'screen': {
        this.screen = msg.data;
        for (const listener of this.screenListeners) listener(msg.data);
        if (this.pendingScreenResolver) {
          const resolver = this.pendingScreenResolver;
          this.pendingScreenResolver = null;
          resolver(msg.data);
        }
        break;
      }

      case 'status':
        this.status = msg.data;
        for (const listener of this.statusListeners) listener(msg.data);
        break;

      case 'connected':
        if (this.pendingConnectResolver) {
          const resolver = this.pendingConnectResolver;
          this.pendingConnectResolver = null;
          resolver({ success: true });
        }
        break;

      case 'error': {
        if (this.pendingConnectResolver) {
          const resolver = this.pendingConnectResolver;
          this.pendingConnectResolver = null;
          resolver({ success: false, error: msg.message });
        } else if (this.pendingScreenResolver) {
          const resolver = this.pendingScreenResolver;
          this.pendingScreenResolver = null;
          resolver(null);
        }
        break;
      }
    }
  }

  private sendAndWaitForScreen(msg: object): Promise<SendResult> {
    return new Promise((resolve) => {
      // Flush any existing pending resolver with current screen data
      if (this.pendingScreenResolver) {
        const old = this.pendingScreenResolver;
        this.pendingScreenResolver = null;
        old(this.screen);
      }

      const timeout = setTimeout(() => {
        this.pendingScreenResolver = null;
        resolve({ success: true, ...this.screenToResult() });
      }, 5000);

      this.pendingScreenResolver = (screen: ScreenData | null) => {
        clearTimeout(timeout);
        if (screen) {
          resolve({
            success: true,
            cursor_row: screen.cursor_row,
            cursor_col: screen.cursor_col,
            content: screen.content,
            screen_signature: screen.screen_signature,
          });
        } else {
          resolve({ success: false, error: 'No screen data received' });
        }
      };

      this.wsSend(msg);
    });
  }

  private screenToResult(): Partial<SendResult> {
    if (!this.screen) return {};
    return {
      cursor_row: this.screen.cursor_row,
      cursor_col: this.screen.cursor_col,
      content: this.screen.content,
      screen_signature: this.screen.screen_signature,
    };
  }

  private wsSend(data: object): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(data));
    }
  }
}
