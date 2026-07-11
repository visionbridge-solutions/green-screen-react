import { ProtocolHandler } from './types.js';
import type { ScreenData, ProtocolOptions, ProtocolType } from './types.js';
import { TN3270Connection } from '../tn3270/connection.js';
import { ScreenBuffer3270 } from '../tn3270/screen.js';
import { TN3270Parser } from '../tn3270/parser.js';
import { TN3270Encoder } from '../tn3270/encoder.js';
import { KEY_TO_AID, TERMINAL_TYPE, dimensionsFor3270Type } from '../tn3270/constants.js';
import type { EbcdicCodePage } from '../encoding/ebcdic.js';

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

    const termType = options?.terminalType || TERMINAL_TYPE;
    // The model digit sets the ALTERNATE size (EWA); default stays 24x80.
    const dims = dimensionsFor3270Type(termType);
    this.screen.configureSizes(dims.rows, dims.cols);
    // z/OS commonly runs cp37 or cp1047; explicit option wins.
    this.screen.codePage = (options?.codePage as EbcdicCodePage) ?? 'cp37';

    await this.connection.connect(host, port, {
      terminalType: termType,
      connectTimeout: options?.connectTimeout as number | undefined,
      tn3270e: options?.tn3270e as boolean | undefined,
    });
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
    // Liveness probe: application-transparent telnet TIMING-MARK round-trip
    // (PA/PF keys all reach the application — see connection.sendTimingMark).
    if (keyName === 'Heartbeat' || keyName === 'HEARTBEAT') {
      this.connection.sendTimingMark();
      return true;
    }
    const response = this.encoder.buildAidResponse(keyName);
    if (!response) return false;
    this.connection.sendRecord(response);
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

  override getLiveness(): { lastReceivedAtMs: number; lastSentAtMs: number } {
    return {
      lastReceivedAtMs: this.connection.lastReceivedAtMs,
      lastSentAtMs: this.connection.lastSentAtMsValue,
    };
  }

  destroy(): void {
    this.disconnect();
    this.removeAllListeners();
  }

  /**
   * Answer host-initiated reads the parser flagged — Read Partition
   * (Query) and Read Buffer / Read Modified (All). Without these replies
   * the host waits forever (same flush pattern as the 5250 handler).
   */
  private flushHostReplies(): void {
    if (this.parser.pendingQueryReply) {
      this.parser.pendingQueryReply = false;
      this.connection.sendRecord(this.encoder.buildQueryReply());
    }
    if (this.parser.pendingRead) {
      const kind = this.parser.pendingRead;
      this.parser.pendingRead = null;
      if (kind === 'buffer') {
        this.connection.sendRecord(this.encoder.buildReadBufferReply());
      } else {
        this.connection.sendRecord(this.encoder.buildReadModifiedReply(kind === 'modifiedAll'));
      }
    }
  }

  private onRecord(record: Buffer): void {
    try {
      const modified = this.parser.parseRecord(record);
      this.flushHostReplies();
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
