import * as net from 'net';
import { EventEmitter } from 'events';
import { TELNET } from '../tn5250/constants.js';
import { TERMINAL_TYPE, CTRL } from './constants.js';

export interface ConnectionEvents {
  connected: () => void;
  disconnected: () => void;
  data: (data: Buffer) => void;
  error: (err: Error) => void;
}

/**
 * Manages a TCP/Telnet connection to an HP NonStop (Tandem) system.
 *
 * HP 6530 terminals use standard Telnet negotiation but differ from
 * TN5250/TN3270 in that data is stream-based — there are no IAC EOR
 * delimited records. Instead, the host sends escape sequences inline
 * and block-mode data transfer uses DC1 (XON) / DC3 (XOFF) for flow
 * control.
 */
export class HP6530Connection extends EventEmitter {
  private socket: net.Socket | null = null;
  private host: string = '';
  private port: number = 23;
  private _connected: boolean = false;
  private recvBuffer: Buffer = Buffer.alloc(0);

  /** Whether we are in XOFF state (host asked us to pause sending) */
  private xoff: boolean = false;

  /** Queue of outbound data waiting for XON */
  private sendQueue: Buffer[] = [];

  get isConnected(): boolean {
    return this._connected;
  }

  get remoteHost(): string {
    return this.host;
  }

  get remotePort(): number {
    return this.port;
  }

  connect(host: string, port: number): Promise<void> {
    return new Promise((resolve, reject) => {
      if (this.socket) {
        this.disconnect();
      }

      this.host = host;
      this.port = port;
      this.recvBuffer = Buffer.alloc(0);
      this.xoff = false;
      this.sendQueue = [];

      this.socket = new net.Socket();
      this.socket.setTimeout(30000);

      const onError = (err: Error) => {
        this.cleanup();
        reject(err);
      };

      this.socket.once('error', onError);

      this.socket.connect(port, host, () => {
        this._connected = true;
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

  /** Send raw bytes over the socket, respecting XON/XOFF flow control */
  sendRaw(data: Buffer): void {
    if (!this.socket || !this._connected) return;

    if (this.xoff) {
      // Queue data until we receive XON
      this.sendQueue.push(data);
      return;
    }

    this.socket.write(data);
  }

  private cleanup(): void {
    this._connected = false;
    this.xoff = false;
    this.sendQueue = [];
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
   * Process the receive buffer. We need to:
   * 1. Handle Telnet IAC sequences (negotiation)
   * 2. Handle DC1/DC3 flow control characters
   * 3. Pass remaining data (escape sequences + printable chars) to the parser
   */
  private processBuffer(): void {
    while (this.recvBuffer.length > 0) {
      const byte = this.recvBuffer[0];

      // --- Telnet IAC handling ---
      if (byte === TELNET.IAC) {
        if (this.recvBuffer.length < 2) return; // need more data

        const cmd = this.recvBuffer[1];

        // IAC IAC = escaped 0xFF literal
        if (cmd === TELNET.IAC) {
          // Emit as data
          this.emitData(Buffer.from([0xFF]));
          this.recvBuffer = this.recvBuffer.subarray(2);
          continue;
        }

        // Subnegotiation: IAC SB ... IAC SE
        if (cmd === TELNET.SB) {
          const seIdx = this.findSubnegEnd();
          if (seIdx === -1) return; // wait for more data
          const subData = this.recvBuffer.subarray(2, seIdx);
          this.recvBuffer = this.recvBuffer.subarray(seIdx + 2);
          this.handleSubnegotiation(subData);
          continue;
        }

        // DO / DONT / WILL / WONT: 3 bytes
        if (cmd === TELNET.DO || cmd === TELNET.DONT ||
            cmd === TELNET.WILL || cmd === TELNET.WONT) {
          if (this.recvBuffer.length < 3) return;
          const option = this.recvBuffer[2];
          this.recvBuffer = this.recvBuffer.subarray(3);
          this.handleNegotiation(cmd, option);
          continue;
        }

        // Other IAC command (2 bytes), skip
        this.recvBuffer = this.recvBuffer.subarray(2);
        continue;
      }

      // --- XON/XOFF flow control ---
      if (byte === CTRL.DC3) {
        // XOFF: host asks us to stop sending
        this.xoff = true;
        this.recvBuffer = this.recvBuffer.subarray(1);
        continue;
      }

      if (byte === CTRL.DC1) {
        // XON: host allows us to resume sending
        this.xoff = false;
        this.recvBuffer = this.recvBuffer.subarray(1);
        this.flushSendQueue();
        continue;
      }

      // --- Regular data (escape sequences + printable characters) ---
      // Find the next IAC or flow control character to know how much data to emit
      let end = 1;
      while (end < this.recvBuffer.length) {
        const b = this.recvBuffer[end];
        if (b === TELNET.IAC || b === CTRL.DC1 || b === CTRL.DC3) break;
        end++;
      }

      const chunk = this.recvBuffer.subarray(0, end);
      this.recvBuffer = this.recvBuffer.subarray(end);
      this.emitData(Buffer.from(chunk));
    }
  }

  private emitData(data: Buffer): void {
    if (data.length > 0) {
      this.emit('data', data);
    }
  }

  private flushSendQueue(): void {
    if (!this.socket || !this._connected) return;
    while (this.sendQueue.length > 0 && !this.xoff) {
      const queued = this.sendQueue.shift()!;
      this.socket.write(queued);
    }
  }

  /** Find IAC SE sequence for subnegotiation end */
  private findSubnegEnd(): number {
    for (let i = 2; i < this.recvBuffer.length - 1; i++) {
      if (this.recvBuffer[i] === TELNET.IAC && this.recvBuffer[i + 1] === TELNET.SE) {
        return i;
      }
    }
    return -1;
  }

  private handleNegotiation(cmd: number, option: number): void {
    switch (cmd) {
      case TELNET.DO:
        // Server asks us to enable an option
        if (option === TELNET.OPT_TTYPE ||
            option === TELNET.OPT_BINARY ||
            option === 0x03 /* SGA */ ||
            option === 0x01 /* ECHO */) {
          this.sendTelnet(TELNET.WILL, option);
        } else {
          this.sendTelnet(TELNET.WONT, option);
        }
        break;

      case TELNET.WILL:
        // Server offers an option
        if (option === TELNET.OPT_BINARY ||
            option === 0x03 /* SGA */ ||
            option === 0x01 /* ECHO */) {
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

  private sendTelnet(cmd: number, option: number): void {
    if (this.socket && this._connected) {
      // Bypass flow control for Telnet negotiation
      this.socket.write(Buffer.from([TELNET.IAC, cmd, option]));
    }
  }
}
