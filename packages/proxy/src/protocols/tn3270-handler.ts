import { ProtocolHandler } from './types.js';
import type { ScreenData, ProtocolOptions, ProtocolType } from './types.js';
import { TN3270Connection } from '../tn3270/connection.js';
import { ScreenBuffer3270 } from '../tn3270/screen.js';
import { TN3270Parser } from '../tn3270/parser.js';
import { TN3270Encoder } from '../tn3270/encoder.js';
import { KEY_TO_AID } from '../tn3270/constants.js';

/**
 * TN3270 protocol handler — implements the ProtocolHandler interface
 * for IBM z/OS (mainframe) 3270 terminal connections.
 */
export class TN3270Handler extends ProtocolHandler {
  readonly protocol: ProtocolType = 'tn3270';

  readonly connection: TN3270Connection;
  readonly screen: ScreenBuffer3270;
  readonly parser: TN3270Parser;
  readonly encoder: TN3270Encoder;

  constructor() {
    super();
    this.screen = new ScreenBuffer3270();
    this.connection = new TN3270Connection();
    this.parser = new TN3270Parser(this.screen);
    this.encoder = new TN3270Encoder(this.screen);

    this.connection.on('data', (record: Buffer) => this.onRecord(record));
    this.connection.on('disconnected', () => this.emit('disconnected'));
    this.connection.on('error', (err: Error) => this.emit('error', err));
  }

  get isConnected(): boolean {
    return this.connection.isConnected;
  }

  async connect(host: string, port: number, options?: ProtocolOptions): Promise<void> {
    // Drop any state left from a previous session on this handler — an
    // in-place reconnect must not render the pre-drop screen (same
    // rationale as the 5250 reconnect-reset).
    this.screen.reset();
    const connectTimeout = options?.connectTimeout as number | undefined;
    await this.connection.connect(host, port, connectTimeout);
  }

  disconnect(): void {
    this.connection.disconnect();
  }

  getScreenData(): ScreenData {
    return this.screen.toScreenData();
  }

  sendText(text: string): boolean {
    return this.encoder.insertText(text);
  }

  sendKey(keyName: string): boolean {
    const response = this.encoder.buildAidResponse(keyName);
    if (!response) return false;
    this.connection.sendRaw(response);
    // Transmitting an AID inhibits input until the host's WCC keyboard
    // restore; remember the AID for host-initiated Read Modified replies.
    this.screen.keyboardLocked = true;
    this.screen.lastAid = KEY_TO_AID[keyName] ?? this.screen.lastAid;
    return true;
  }

  setCursor(row: number, col: number): boolean {
    if (row < 0 || row >= this.screen.rows || col < 0 || col >= this.screen.cols) {
      return false;
    }
    this.screen.cursorAddr = row * this.screen.cols + col;
    return true;
  }

  sendRaw(data: Buffer): void {
    this.connection.sendRaw(data);
  }

  destroy(): void {
    this.disconnect();
    this.removeAllListeners();
  }

  private onRecord(record: Buffer): void {
    try {
      const modified = this.parser.parseRecord(record);
      if (modified) {
        this.emit('screenChange', this.screen.toScreenData());
      }
    } catch (err) {
      // A crafted/corrupt host record must not throw out of the socket 'data'
      // handler and drop the connection — log and skip it.
      console.error(`[tn3270] dropped unparseable record (len=${record.length}): ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}
