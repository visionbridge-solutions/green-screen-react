import * as net from 'net';
import { EventEmitter } from 'events';
import { TELNET, TelnetRecordStream } from '../net/telnet.js';
import { TERMINAL_TYPE } from './constants.js';

/**
 * Manages raw TCP socket to a z/OS (or other 3270) host.
 * Handles Telnet negotiation and extracts 3270 data records (IAC EOR delimited).
 *
 * Supports basic TN3270 (RFC 1576) negotiation.
 * TN3270E (RFC 2355) is handled at a basic level.
 */
export class TN3270Connection extends EventEmitter {
  private socket: net.Socket | null = null;
  private host: string = '';
  private port: number = 23;
  private connected: boolean = false;
  private readonly stream = new TelnetRecordStream({
    onNegotiation: (cmd, option) => this.handleNegotiation(cmd, option),
    onSubnegotiation: (data) => this.handleSubnegotiation(data),
    onRecord: (record) => this.onRecord(record),
  });
  private tn3270eMode: boolean = false;

  get isConnected(): boolean {
    return this.connected;
  }

  connect(host: string, port: number, connectTimeout?: number): Promise<void> {
    return new Promise((resolve, reject) => {
      if (this.socket) {
        this.disconnect();
      }

      this.host = host;
      this.port = port;
      this.stream.reset();
      this.tn3270eMode = false;

      this.socket = new net.Socket();
      this.socket.setTimeout(connectTimeout ?? 30000);

      const onError = (err: Error) => {
        this.cleanup();
        reject(err);
      };

      this.socket.once('error', onError);

      this.socket.connect(port, host, () => {
        this.connected = true;
        this.socket!.removeListener('error', onError);

        this.socket!.on('error', (err) => {
          this.emit('error', err);
          this.cleanup();
        });

        this.socket!.on('close', () => {
          this.cleanup();
          this.emit('disconnected');
        });

        this.socket!.on('timeout', () => {
          this.emit('error', new Error('Connection timeout'));
          // A socket timeout does NOT close the socket — destroy it so the
          // half-open connection can't dangle (the 'close' handler then cleans up).
          this.socket?.destroy();
        });

        this.socket!.on('data', (data: Buffer) => this.onData(data));

        this.emit('connected');
        resolve();
      });
    });
  }

  disconnect(): void {
    if (this.socket) {
      this.socket.destroy();
      this.cleanup();
    }
  }

  sendRaw(data: Buffer): void {
    if (this.socket && this.connected) {
      this.socket.write(data);
    }
  }

  private cleanup(): void {
    this.connected = false;
    if (this.socket) {
      this.socket.removeAllListeners();
      this.socket.destroy();
      this.socket = null;
    }
  }

  private onData(data: Buffer): void {
    this.stream.feed(data);
  }

  private onRecord(record: Buffer): void {
    // In TN3270E mode, strip the 5-byte header (proper RFC 2355 header
    // handling lands with the TN3270E negotiation rework).
    if (this.tn3270eMode && record.length > 5) {
      const dataRecord = record.subarray(5);
      if (dataRecord.length > 0) {
        this.emit('data', dataRecord);
      }
    } else {
      this.emit('data', record);
    }
  }

  private handleNegotiation(cmd: number, option: number): void {
    switch (cmd) {
      case TELNET.DO:
        if (option === TELNET.OPT_TTYPE ||
            option === TELNET.OPT_EOR ||
            option === TELNET.OPT_BINARY) {
          this.sendTelnet(TELNET.WILL, option);
        } else if (option === 0x28) {
          // TN3270E — accept
          this.sendTelnet(TELNET.WILL, option);
          this.tn3270eMode = true;
        } else {
          this.sendTelnet(TELNET.WONT, option);
        }
        break;

      case TELNET.WILL:
        if (option === TELNET.OPT_EOR ||
            option === TELNET.OPT_BINARY) {
          this.sendTelnet(TELNET.DO, option);
        } else if (option === 0x28) {
          this.sendTelnet(TELNET.DO, option);
          this.tn3270eMode = true;
        } else {
          this.sendTelnet(TELNET.DONT, option);
        }
        break;

      case TELNET.DONT:
        this.sendTelnet(TELNET.WONT, option);
        break;

      case TELNET.WONT:
        this.sendTelnet(TELNET.DONT, option);
        break;
    }
  }

  private handleSubnegotiation(data: Buffer): void {
    if (data.length === 0) return;

    const option = data[0];

    if (option === TELNET.OPT_TTYPE && data.length >= 2 && data[1] === TELNET.TTYPE_SEND) {
      this.sendTerminalType();
    } else if (option === 0x28) {
      // TN3270E subnegotiation
      this.handleTN3270ESubneg(data);
    }
  }

  private sendTerminalType(): void {
    const typeStr = TERMINAL_TYPE;
    const buf = Buffer.alloc(4 + typeStr.length + 2);
    let i = 0;
    buf[i++] = TELNET.IAC;
    buf[i++] = TELNET.SB;
    buf[i++] = TELNET.OPT_TTYPE;
    buf[i++] = TELNET.TTYPE_IS;
    for (let j = 0; j < typeStr.length; j++) {
      buf[i++] = typeStr.charCodeAt(j);
    }
    buf[i++] = TELNET.IAC;
    buf[i++] = TELNET.SE;
    this.sendRaw(buf);
  }

  private handleTN3270ESubneg(data: Buffer): void {
    if (data.length < 2) return;

    const msgType = data[1];
    // TN3270E DEVICE-TYPE SEND (0x08 0x02)
    if (msgType === 0x02) {
      // Send device type response
      const typeStr = TERMINAL_TYPE;
      const resp = Buffer.alloc(4 + typeStr.length + 2);
      let i = 0;
      resp[i++] = TELNET.IAC;
      resp[i++] = TELNET.SB;
      resp[i++] = 0x28; // TN3270E
      resp[i++] = 0x02; // DEVICE-TYPE IS
      for (let j = 0; j < typeStr.length; j++) {
        resp[i++] = typeStr.charCodeAt(j);
      }
      resp[i++] = TELNET.IAC;
      resp[i++] = TELNET.SE;
      this.sendRaw(resp);
    }
    // TN3270E FUNCTIONS REQUEST (0x08 0x04)
    if (msgType === 0x04) {
      // Accept no functions
      this.sendRaw(Buffer.from([
        TELNET.IAC, TELNET.SB, 0x28,
        0x04, // FUNCTIONS IS
        TELNET.IAC, TELNET.SE,
      ]));
    }
  }

  private sendTelnet(cmd: number, option: number): void {
    this.sendRaw(Buffer.from([TELNET.IAC, cmd, option]));
  }
}
