import { ProtocolHandler } from './types.js';
import type { ScreenData, ProtocolOptions, ProtocolType } from './types.js';
import { VTConnection } from '../vt/connection.js';
import { VTScreenBuffer } from '../vt/screen.js';
import { VTParser } from '../vt/parser.js';
import { VTEncoder } from '../vt/encoder.js';

/**
 * VT terminal protocol handler — implements the ProtocolHandler interface
 * for VT100/VT220/VT320 terminal connections.
 *
 * VT terminals are stream-mode (character-at-a-time). Each keystroke is
 * sent immediately; the host echoes characters back. Used by OpenVMS,
 * Pick/MultiValue, Unix, and many other systems.
 */
export class VTHandler extends ProtocolHandler {
  readonly protocol: ProtocolType = 'vt';

  readonly connection: VTConnection;
  readonly screen: VTScreenBuffer;
  readonly parser: VTParser;
  readonly encoder: VTEncoder;

  constructor() {
    super();
    this.screen = new VTScreenBuffer();
    this.connection = new VTConnection();
    this.parser = new VTParser(this.screen);
    this.encoder = new VTEncoder(this.screen);

    this.connection.on('data', (data: Buffer) => this.onData(data));
    this.connection.on('disconnected', () => this.emit('disconnected'));
    this.connection.on('error', (err: Error) => this.emit('error', err));
  }

  override get traits() {
    return { inputModel: 'stream' as const, hasMdt: false };
  }

  /** Stream mode: every key round-trips; the host owns the echo. */
  override isLocalKey(_key: string): boolean {
    return false;
  }

  get isConnected(): boolean {
    return this.connection.isConnected;
  }

  async connect(host: string, port: number, options?: ProtocolOptions): Promise<void> {
    // Drop prior-session state (same reconnect-reset rationale as 5250/3270).
    this.screen.reset();
    this.parser.pendingResponses.length = 0;

    const rows = (options?.rows as number) || this.screen.rows;
    const cols = (options?.cols as number) || this.screen.cols;
    if (rows !== this.screen.rows || cols !== this.screen.cols) {
      this.screen.resize(rows, cols);
    }
    this.parser.encoding = options?.encoding === 'utf8' ? 'utf8' : 'latin1';

    await this.connection.connect(host, port, {
      terminalType: options?.terminalType as string | undefined,
      rows,
      cols,
      connectTimeout: options?.connectTimeout as number | undefined,
    });
  }

  disconnect(): void {
    this.connection.disconnect();
  }

  getScreenData(): ScreenData {
    return this.screen.toScreenData();
  }

  sendText(text: string): boolean {
    const encoded = this.encoder.encodeText(text);
    this.connection.sendRaw(encoded);
    // Line-mode servers (no WILL ECHO) expect the terminal to echo locally —
    // without this, typed text is invisible until the host redraws.
    if (!this.connection.remoteEcho) {
      this.parser.feed(encoded);
      this.emit('screenChange', this.screen.toScreenData());
    }
    return true;
  }

  sendKey(keyName: string): boolean {
    const encoded = this.encoder.encodeKey(keyName);
    if (!encoded) return false;
    this.connection.sendRaw(encoded);
    if (!this.connection.remoteEcho && keyName.toUpperCase() === 'ENTER') {
      this.parser.feed(Buffer.from('\r\n', 'latin1'));
      this.emit('screenChange', this.screen.toScreenData());
    }
    return true;
  }

  sendRaw(data: Buffer): void {
    this.connection.sendRaw(data);
  }

  override getLiveness(): { lastReceivedAtMs: number; lastSentAtMs: number } {
    return {
      lastReceivedAtMs: this.connection.lastReceivedAtMs,
      lastSentAtMs: this.connection.lastSentAtMs,
    };
  }

  destroy(): void {
    this.disconnect();
    this.removeAllListeners();
  }

  private onData(data: Buffer): void {
    try {
      const modified = this.parser.feed(data);
      // Answer host probes (DA/DSR/CPR/DECID) — vim/less-style apps hang
      // without a Cursor Position Report.
      while (this.parser.pendingResponses.length > 0) {
        this.connection.sendRaw(this.parser.pendingResponses.shift()!);
      }
      if (modified) {
        this.emit('screenChange', this.screen.toScreenData());
      }
    } catch (err) {
      // Corrupt host data must not throw out of the socket 'data' handler and
      // drop the connection — log and skip it.
      console.error(`[vt] dropped unparseable data (len=${data.length}): ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}
