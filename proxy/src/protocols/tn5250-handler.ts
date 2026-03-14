import { ProtocolHandler, ScreenData, ProtocolOptions, ProtocolType } from './types.js';
import { TN5250Connection } from '../tn5250/connection.js';
import { ScreenBuffer } from '../tn5250/screen.js';
import { TN5250Parser } from '../tn5250/parser.js';
import { TN5250Encoder } from '../tn5250/encoder.js';

/**
 * TN5250 protocol handler — implements the ProtocolHandler interface
 * for IBM i (AS/400) TN5250 terminal connections.
 */
export class TN5250Handler extends ProtocolHandler {
  readonly protocol: ProtocolType = 'tn5250';

  readonly connection: TN5250Connection;
  readonly screen: ScreenBuffer;
  readonly parser: TN5250Parser;
  readonly encoder: TN5250Encoder;

  constructor() {
    super();
    this.screen = new ScreenBuffer();
    this.connection = new TN5250Connection();
    this.parser = new TN5250Parser(this.screen);
    this.encoder = new TN5250Encoder(this.screen);

    this.connection.on('data', (record: Buffer) => this.onRecord(record));
    this.connection.on('disconnected', () => this.emit('disconnected'));
    this.connection.on('error', (err: Error) => this.emit('error', err));
  }

  get isConnected(): boolean {
    return this.connection.isConnected;
  }

  async connect(host: string, port: number, _options?: ProtocolOptions): Promise<void> {
    await this.connection.connect(host, port);
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
    const modified = this.parser.parseRecord(record);
    if (modified) {
      this.parser.calculateFieldLengths();
      this.emit('screenChange', this.screen.toScreenData());
    }
  }
}
