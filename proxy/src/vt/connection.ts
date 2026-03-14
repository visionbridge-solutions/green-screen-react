import * as net from 'net';
import { EventEmitter } from 'events';
import { TELNET, DEFAULT_TERMINAL_TYPE, DEFAULT_ROWS, DEFAULT_COLS } from './constants.js';

export interface VTConnectionOptions {
  terminalType?: string;
  rows?: number;
  cols?: number;
}

/**
 * Manages a TCP/Telnet connection for VT terminal sessions.
 *
 * Unlike TN5250/TN3270, VT data is a continuous byte stream — there is no
 * IAC EOR record framing. Telnet IAC commands are handled inline and stripped
 * from the data stream; all remaining bytes are emitted as 'data' events.
 */
export class VTConnection extends EventEmitter {
  private socket: net.Socket | null = null;
  private host: string = '';
  private port: number = 23;
  private connected: boolean = false;
  private recvBuffer: Buffer = Buffer.alloc(0);
  private terminalType: string = DEFAULT_TERMINAL_TYPE;
  private rows: number = DEFAULT_ROWS;
  private cols: number = DEFAULT_COLS;

  get isConnected(): boolean {
    return this.connected;
  }

  get remoteHost(): string {
    return this.host;
  }

  get remotePort(): number {
    return this.port;
  }

  connect(host: string, port: number, options?: VTConnectionOptions): Promise<void> {
    return new Promise((resolve, reject) => {
      if (this.socket) {
        this.disconnect();
      }

      this.host = host;
      this.port = port;
      this.recvBuffer = Buffer.alloc(0);

      if (options?.terminalType) this.terminalType = options.terminalType;
      if (options?.rows) this.rows = options.rows;
      if (options?.cols) this.cols = options.cols;

      this.socket = new net.Socket();
      this.socket.setTimeout(30000);

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

  /** Send raw bytes over the socket */
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
    this.recvBuffer = Buffer.concat([this.recvBuffer, data]);
    this.processBuffer();
  }

  /**
   * Process the receive buffer. Strip out Telnet IAC commands and emit
   * the remaining application data as 'data' events.
   */
  private processBuffer(): void {
    const appData: number[] = [];
    let i = 0;

    while (i < this.recvBuffer.length) {
      const byte = this.recvBuffer[i];

      if (byte === TELNET.IAC) {
        if (i + 1 >= this.recvBuffer.length) {
          // Incomplete IAC sequence — keep remainder for next chunk
          break;
        }

        const cmd = this.recvBuffer[i + 1];

        // IAC IAC = escaped 0xFF literal byte
        if (cmd === TELNET.IAC) {
          appData.push(0xff);
          i += 2;
          continue;
        }

        // Subnegotiation: IAC SB ... IAC SE
        if (cmd === TELNET.SB) {
          const seIdx = this.findSubnegEnd(i);
          if (seIdx === -1) break; // Wait for more data
          const subData = this.recvBuffer.subarray(i + 2, seIdx);
          this.handleSubnegotiation(subData);
          i = seIdx + 2; // skip past IAC SE
          continue;
        }

        // DO/DONT/WILL/WONT: 3-byte commands
        if (cmd === TELNET.DO || cmd === TELNET.DONT || cmd === TELNET.WILL || cmd === TELNET.WONT) {
          if (i + 2 >= this.recvBuffer.length) break; // Wait for option byte
          const option = this.recvBuffer[i + 2];
          this.handleNegotiation(cmd, option);
          i += 3;
          continue;
        }

        // Other 2-byte IAC commands (GA, NOP, etc.) — skip
        i += 2;
        continue;
      }

      // Regular data byte
      appData.push(byte);
      i++;
    }

    // Keep unprocessed bytes
    this.recvBuffer = this.recvBuffer.subarray(i);

    // Emit application data
    if (appData.length > 0) {
      this.emit('data', Buffer.from(appData));
    }
  }

  /** Find IAC SE after position `start` (which points to IAC SB) */
  private findSubnegEnd(start: number): number {
    for (let j = start + 2; j < this.recvBuffer.length - 1; j++) {
      if (this.recvBuffer[j] === TELNET.IAC && this.recvBuffer[j + 1] === TELNET.SE) {
        return j;
      }
    }
    return -1;
  }

  private handleNegotiation(cmd: number, option: number): void {
    switch (cmd) {
      case TELNET.DO:
        if (
          option === TELNET.OPT_TTYPE ||
          option === TELNET.OPT_NAWS ||
          option === TELNET.OPT_BINARY ||
          option === TELNET.OPT_SGA
        ) {
          this.sendTelnet(TELNET.WILL, option);
          // After agreeing to NAWS, immediately send window size
          if (option === TELNET.OPT_NAWS) {
            this.sendNAWS();
          }
        } else {
          this.sendTelnet(TELNET.WONT, option);
        }
        break;

      case TELNET.WILL:
        if (
          option === TELNET.OPT_ECHO ||
          option === TELNET.OPT_SGA ||
          option === TELNET.OPT_BINARY
        ) {
          this.sendTelnet(TELNET.DO, option);
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
    }
  }

  private sendTerminalType(): void {
    const typeStr = this.terminalType;
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

  /** Send NAWS (Negotiate About Window Size) subnegotiation */
  private sendNAWS(): void {
    const buf = Buffer.from([
      TELNET.IAC, TELNET.SB, TELNET.OPT_NAWS,
      (this.cols >> 8) & 0xff, this.cols & 0xff,
      (this.rows >> 8) & 0xff, this.rows & 0xff,
      TELNET.IAC, TELNET.SE,
    ]);
    this.sendRaw(buf);
  }

  private sendTelnet(cmd: number, option: number): void {
    this.sendRaw(Buffer.from([TELNET.IAC, cmd, option]));
  }
}
