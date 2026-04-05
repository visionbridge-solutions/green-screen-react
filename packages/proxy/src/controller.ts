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
    /** EBCDIC code page override (e.g. 'cp290' for Japanese Katakana). */
    codePage?: 'cp37' | 'cp290';
  }): Promise<ProtocolHandler> {
    if (this.handler) {
      this.handler.destroy();
      this.handler = null;
      this.connected = false;
    }

    const { host, port = 23, protocol = 'tn5250', username, password, sessionId, terminalType, codePage } = opts;

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

    const connectOpts = (terminalType || codePage)
      ? { ...(terminalType ? { terminalType } : {}), ...(codePage ? { codePage } : {}) }
      : undefined;
    await this.handler.connect(host, port, connectOpts);
    this.connected = true;
    this.send({ type: 'status', data: { connected: true, status: 'connected', protocol, host } });

    // Auto-sign-in if credentials provided and handler supports it
    if (username && password && this.handler instanceof TN5250Handler) {
      const result = await this.handler.performAutoSignIn(username, password);
      if (result) {
        this.send({ type: 'screen', data: result.screen });
        if (result.authenticated) {
          // Flip status so subsequent graceful-disconnect attempts will
          // try a SIGNOFF. Failed sign-in (still on sign-on screen with
          // CPF error) leaves status as 'connected'.
          this.send({ type: 'status', data: { connected: true, status: 'authenticated', protocol, host, username } });
        }
      }
    } else {
      const screen = await this.waitForScreen(5000);
      this.send({ type: 'screen', data: screen });
    }

    this.send({ type: 'connected', sessionId });
    return this.handler;
  }

  /**
   * Adopt an already-connected ProtocolHandler owned by another holder
   * (e.g. a REST-created Session). Wires this controller up to dispatch
   * key/text/setCursor commands against the existing handler without
   * re-binding connection-level event listeners — the owning Session
   * remains responsible for the handler lifecycle.
   *
   * Used by the WebSocket reattach path so WS clients can drive a session
   * that was originally created via REST.
   */
  adoptHandler(handler: ProtocolHandler): void {
    this.handler = handler;
    this.connected = true;
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

  handleSetCursor(row: number, col: number): void {
    if (!this.handler || !this.connected) {
      this.send({ type: 'error', message: 'Not connected' });
      return;
    }
    this.handler.setCursor(row, col);
    const sd = this.handler.getScreenData();
    this.send({ type: 'cursor', data: { cursor_row: sd.cursor_row, cursor_col: sd.cursor_col } });
  }

  handleDisconnect(): void {
    if (this.handler) {
      this.handler.destroy();
      this.handler = null;
    }
    this.connected = false;
    this.send({ type: 'status', data: { connected: false, status: 'disconnected' } });
  }

  /**
   * User-initiated graceful disconnect. If the protocol supports it
   * (TN5250), types SIGNOFF on the command line and waits briefly for the
   * host to end the interactive job before dropping the TCP socket. Avoids
   * CPF1220 "device session limit" on IBM i with LMTDEVSSN=*YES.
   */
  async handleGracefulDisconnect(timeoutMs: number = 1500): Promise<void> {
    if (this.handler && typeof (this.handler as any).attemptSignOff === 'function') {
      try {
        await (this.handler as any).attemptSignOff(timeoutMs);
      } catch {
        // best-effort
      }
    }
    this.handleDisconnect();
  }

  getScreenData(): ScreenData | null {
    return this.handler?.getScreenData() ?? null;
  }

  handleReadMdt(modifiedOnly: boolean): void {
    if (!this.handler || !this.connected) {
      this.send({ type: 'error', message: 'Not connected' });
      return;
    }
    const fields = this.handler.readFieldValues(modifiedOnly);
    this.send({ type: 'mdt', data: { modifiedOnly, fields } });
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
