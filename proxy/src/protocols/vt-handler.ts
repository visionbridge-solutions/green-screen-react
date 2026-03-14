import { ProtocolHandler, ScreenData, ProtocolOptions, ProtocolType } from './types.js';
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
    const encoded = this.encoder.encodeText(text);
    this.connection.sendRaw(encoded);
    return true;
  }

  sendKey(keyName: string): boolean {
    const encoded = this.encoder.encodeKey(keyName);
    if (!encoded) return false;
    this.connection.sendRaw(encoded);
    return true;
  }

  sendRaw(data: Buffer): void {
    this.connection.sendRaw(data);
  }

  destroy(): void {
    this.disconnect();
    this.removeAllListeners();
  }

  private onData(data: Buffer): void {
    const modified = this.parser.feed(data);
    if (modified) {
      this.emit('screenChange', this.screen.toScreenData());
    }
  }
}
