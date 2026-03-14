import { ProtocolHandler, ScreenData, ProtocolOptions, ProtocolType } from './types.js';
import { HP6530Connection } from '../hp6530/connection.js';
import { HP6530Screen } from '../hp6530/screen.js';
import { HP6530Parser } from '../hp6530/parser.js';
import { HP6530Encoder } from '../hp6530/encoder.js';

/**
 * HP 6530 protocol handler — implements the ProtocolHandler interface
 * for HP NonStop (Tandem) terminal connections.
 *
 * HP 6530 terminals are block-mode ASCII terminals used with HP NonStop
 * systems in payment processing, stock exchanges, and telecom.
 */
export class HP6530Handler extends ProtocolHandler {
  readonly protocol: ProtocolType = 'hp6530';

  readonly connection: HP6530Connection;
  readonly screen: HP6530Screen;
  readonly parser: HP6530Parser;
  readonly encoder: HP6530Encoder;

  constructor() {
    super();
    this.screen = new HP6530Screen();
    this.connection = new HP6530Connection();
    this.parser = new HP6530Parser(this.screen);
    this.encoder = new HP6530Encoder(this.screen);

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
    return this.encoder.insertText(text);
  }

  sendKey(keyName: string): boolean {
    const response = this.encoder.buildKeyResponse(keyName);
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

  private onData(data: Buffer): void {
    const modified = this.parser.parse(data);
    if (modified) {
      this.emit('screenChange', this.screen.toScreenData());
    }
  }
}
