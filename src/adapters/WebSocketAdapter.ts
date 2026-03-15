import type { TerminalAdapter, ScreenData, ConnectionStatus, SendResult, ConnectConfig } from './types';

export interface WebSocketAdapterOptions {
  /** URL of the green-screen proxy or worker. Defaults to http://localhost:3001 */
  workerUrl?: string;
}

/**
 * WebSocket adapter that connects to a Cloudflare Worker running green-screen-worker.
 * The Worker holds the TCP connection to the legacy host and relays protocol data.
 *
 * Unlike RestAdapter (which polls over HTTP), this adapter receives real-time
 * screen updates via WebSocket push.
 */
export class WebSocketAdapter implements TerminalAdapter {
  private workerUrl: string;
  private ws: WebSocket | null = null;
  private screen: ScreenData | null = null;
  private status: ConnectionStatus = { connected: false, status: 'disconnected' };
  private pendingResolvers: Map<string, (value: any) => void> = new Map();
  private screenListeners: Set<(screen: ScreenData) => void> = new Set();
  private statusListeners: Set<(status: ConnectionStatus) => void> = new Set();

  constructor(options: WebSocketAdapterOptions = {}) {
    this.workerUrl = (options.workerUrl || 'http://localhost:3001').replace(/\/+$/, '');
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
    // Ensure WebSocket is open
    await this.ensureWebSocket();

    if (!config) {
      return { success: false, error: 'ConnectConfig required' };
    }

    return new Promise((resolve) => {
      const timeout = setTimeout(() => {
        resolve({ success: false, error: 'Connection timeout' });
      }, 30000);

      // Listen for connected or error
      const onMessage = (event: MessageEvent) => {
        try {
          const msg = JSON.parse(event.data);
          if (msg.type === 'connected') {
            clearTimeout(timeout);
            this.ws?.removeEventListener('message', onMessage);
            resolve({ success: true });
          } else if (msg.type === 'error') {
            clearTimeout(timeout);
            this.ws?.removeEventListener('message', onMessage);
            resolve({ success: false, error: msg.message });
          }
        } catch {}
      };
      this.ws?.addEventListener('message', onMessage);

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
    // Not directly supported — caller should disconnect then connect again
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

    return new Promise((resolve, reject) => {
      const wsUrl = this.workerUrl.replace(/^http/, 'ws') + '/ws';
      this.ws = new WebSocket(wsUrl);

      this.ws.onopen = () => resolve();
      this.ws.onerror = () => reject(new Error('WebSocket connection failed'));

      this.ws.onmessage = (event) => {
        try {
          const msg = JSON.parse(event.data);
          this.handleMessage(msg);
        } catch {}
      };

      this.ws.onclose = () => {
        this.status = { connected: false, status: 'disconnected' };
        for (const listener of this.statusListeners) listener(this.status);
      };
    });
  }

  private handleMessage(msg: any): void {
    switch (msg.type) {
      case 'screen':
        this.screen = msg.data;
        for (const listener of this.screenListeners) listener(msg.data);
        // Resolve any pending screen waiter
        const screenResolver = this.pendingResolvers.get('screen');
        if (screenResolver) {
          this.pendingResolvers.delete('screen');
          screenResolver(msg.data);
        }
        break;

      case 'status':
        this.status = msg.data;
        for (const listener of this.statusListeners) listener(msg.data);
        break;

      case 'error':
        const errorResolver = this.pendingResolvers.get('screen');
        if (errorResolver) {
          this.pendingResolvers.delete('screen');
          errorResolver(null);
        }
        break;
    }
  }

  private sendAndWaitForScreen(msg: object): Promise<SendResult> {
    return new Promise((resolve) => {
      const timeout = setTimeout(() => {
        this.pendingResolvers.delete('screen');
        resolve({ success: true, ...this.screenToResult() });
      }, 5000);

      this.pendingResolvers.set('screen', (screen: ScreenData | null) => {
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
      });

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
