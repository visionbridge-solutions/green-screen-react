import { createProtocolHandler, ProtocolHandler, TN5250Handler } from './protocols/index.js';
import type { ProtocolType, ScreenData } from './protocols/index.js';

/**
 * Shared session controller that handles the WebSocket message protocol
 * (connect, text, key, disconnect) for a single terminal session.
 *
 * Used by both the local proxy (websocket.ts) and the Cloudflare Worker.
 * Platform-specific concerns (multi-session management, rate limiting,
 * idle timers, host validation) stay in each consumer.
 */
export class SessionController {
  handler: ProtocolHandler | null = null;
  connected: boolean = false;
  private send: (msg: object) => void;

  constructor(send: (msg: object) => void) {
    this.send = send;
  }

  /**
   * Connect to a host and optionally auto-sign-in.
   * Returns the session's ProtocolHandler for event binding by the caller.
   */
  async handleConnect(opts: {
    host: string;
    port?: number;
    protocol?: ProtocolType;
    username?: string;
    password?: string;
    sessionId: string;
    terminalType?: string;
  }): Promise<ProtocolHandler> {
    if (this.handler) {
      this.handler.destroy();
      this.handler = null;
      this.connected = false;
    }

    const { host, port = 23, protocol = 'tn5250', username, password, sessionId, terminalType } = opts;

    this.handler = createProtocolHandler(protocol);
    this.send({ type: 'status', data: { connected: false, status: 'connecting', protocol, host } });

    // Bind protocol events → WebSocket messages
    this.handler.on('screenChange', (data: ScreenData) => {
      this.send({ type: 'screen', data });
    });
    this.handler.on('disconnected', () => {
      this.connected = false;
      this.send({ type: 'status', data: { connected: false, status: 'disconnected', protocol, host } });
    });
    this.handler.on('error', (err: Error) => {
      this.send({ type: 'error', message: err.message });
      this.send({ type: 'status', data: { connected: false, status: 'error', protocol, host, error: err.message } });
    });

    await this.handler.connect(host, port, terminalType ? { terminalType } : undefined);
    this.connected = true;
    this.send({ type: 'status', data: { connected: true, status: 'connected', protocol, host } });

    // Auto-sign-in if credentials provided and handler supports it
    if (username && password && this.handler instanceof TN5250Handler) {
      const screen = await this.handler.performAutoSignIn(username, password);
      if (screen) {
        this.send({ type: 'screen', data: screen });
      }
    } else {
      const screen = await this.waitForScreen(5000);
      this.send({ type: 'screen', data: screen });
    }

    this.send({ type: 'connected', sessionId });
    return this.handler;
  }

  handleText(text: string): void {
    if (!this.handler || !this.connected) {
      this.send({ type: 'error', message: 'Not connected' });
      return;
    }
    this.handler.sendText(text);
    this.send({ type: 'screen', data: this.handler.getScreenData() });
  }

  async handleKey(key: string): Promise<void> {
    if (!this.handler || !this.connected) {
      this.send({ type: 'error', message: 'Not connected' });
      return;
    }

    const ok = this.handler.sendKey(key);
    if (!ok) {
      this.send({ type: 'error', message: `Unknown key: ${key}` });
      return;
    }

    // Local operations — respond immediately without waiting for host
    const localKeys = [
      'Tab', 'Backtab', 'TAB', 'BACKTAB',
      'ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown',
      'LEFT', 'RIGHT', 'UP', 'DOWN',
      'Home', 'HOME', 'End', 'END',
      'Backspace', 'BACKSPACE', 'Delete', 'DELETE',
      'Insert', 'INSERT',
      'Reset', 'RESET',
      'FieldExit', 'FIELD_EXIT', 'FIELDEXIT',
    ];
    if (localKeys.includes(key)) {
      // Local buffer-modifying ops need full screen; cursor-only ops don't
      const bufferOps = ['Backspace', 'BACKSPACE', 'Delete', 'DELETE',
        'Insert', 'INSERT',
        'Reset', 'RESET',
        'FieldExit', 'FIELD_EXIT', 'FIELDEXIT'];
      if (bufferOps.includes(key)) {
        this.send({ type: 'screen', data: this.handler.getScreenData() });
      } else {
        // Cursor-only movement — send lightweight response
        const sd = this.handler.getScreenData();
        this.send({ type: 'cursor', data: { cursor_row: sd.cursor_row, cursor_col: sd.cursor_col } });
      }
    } else {
      await this.waitForScreen(3000);
      this.send({ type: 'screen', data: this.handler.getScreenData() });
    }
  }

  handleDisconnect(): void {
    if (this.handler) {
      this.handler.destroy();
      this.handler = null;
    }
    this.connected = false;
    this.send({ type: 'status', data: { connected: false, status: 'disconnected' } });
  }

  getScreenData(): ScreenData | null {
    return this.handler?.getScreenData() ?? null;
  }

  private waitForScreen(timeoutMs: number): Promise<ScreenData> {
    return new Promise((resolve) => {
      if (!this.handler) { resolve(null as any); return; }
      const timer = setTimeout(() => resolve(this.handler!.getScreenData()), timeoutMs);
      this.handler.once('screenChange', (data: ScreenData) => {
        clearTimeout(timer);
        resolve(data);
      });
    });
  }
}
