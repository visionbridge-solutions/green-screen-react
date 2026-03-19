import * as net from 'net';
import { EventEmitter } from 'events';
import { TELNET, TERMINAL_TYPE as DEFAULT_TERMINAL_TYPE } from './constants.js';

export interface ConnectionEvents {
  connected: () => void;
  disconnected: () => void;
  data: (record: Buffer) => void;
  error: (err: Error) => void;
}

/**
 * Manages raw TCP socket to IBM i, handles Telnet negotiation,
 * and extracts 5250 data records (delimited by IAC EOR).
 */
export class TN5250Connection extends EventEmitter {
  private socket: net.Socket | null = null;
  private host: string = '';
  private port: number = 23;
  private connected: boolean = false;
  private recvBuffer: Buffer = Buffer.alloc(0);
  private negotiationDone: boolean = false;
  private terminalType: string = DEFAULT_TERMINAL_TYPE;

  get isConnected(): boolean {
    return this.connected;
  }

  get remoteHost(): string {
    return this.host;
  }

  get remotePort(): number {
    return this.port;
  }

  connect(host: string, port: number, terminalType?: string): Promise<void> {
    return new Promise((resolve, reject) => {
      if (this.socket) {
        this.disconnect();
      }

      this.host = host;
      this.port = port;
      this.recvBuffer = Buffer.alloc(0);
      this.negotiationDone = false;
      this.terminalType = terminalType || DEFAULT_TERMINAL_TYPE;

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
    // Append to receive buffer
    this.recvBuffer = Buffer.concat([this.recvBuffer, data]);

    // Process all complete messages in the buffer
    this.processBuffer();
  }

  private processBuffer(): void {
    while (this.recvBuffer.length > 0) {
      // Check for Telnet commands (IAC ...)
      if (this.recvBuffer[0] === TELNET.IAC && this.recvBuffer.length >= 2) {
        const cmd = this.recvBuffer[1];

        // IAC IAC = escaped 0xFF byte (part of data, not a command)
        if (cmd === TELNET.IAC) {
          // This is data, not a command — handled below with record extraction
          break;
        }

        // Subnegotiation: IAC SB ... IAC SE
        if (cmd === TELNET.SB) {
          const seIdx = this.findSubnegEnd();
          if (seIdx === -1) return; // Wait for more data

          const subData = this.recvBuffer.subarray(2, seIdx);
          this.recvBuffer = this.recvBuffer.subarray(seIdx + 2); // skip IAC SE
          this.handleSubnegotiation(subData);
          continue;
        }

        // DO/DONT/WILL/WONT: 3 bytes
        if (cmd === TELNET.DO || cmd === TELNET.DONT || cmd === TELNET.WILL || cmd === TELNET.WONT) {
          if (this.recvBuffer.length < 3) return; // Wait for option byte
          const option = this.recvBuffer[2];
          this.recvBuffer = this.recvBuffer.subarray(3);
          this.handleNegotiation(cmd, option);
          continue;
        }

        // Other IAC commands (EOR handled in record extraction below)
        if (cmd === TELNET.EOR) {
          // Should not happen here at start of buffer in isolation
          this.recvBuffer = this.recvBuffer.subarray(2);
          continue;
        }

        // Unknown 2-byte IAC command, skip
        this.recvBuffer = this.recvBuffer.subarray(2);
        continue;
      }

      // Extract a 5250 record: data terminated by IAC EOR
      const recordEnd = this.findRecordEnd();
      if (recordEnd === -1) return; // Wait for more data

      // Extract the record data (removing IAC EOR and unescaping IAC IAC)
      const rawRecord = this.recvBuffer.subarray(0, recordEnd);
      this.recvBuffer = this.recvBuffer.subarray(recordEnd + 2); // skip IAC EOR

      const record = this.unescapeIAC(rawRecord);
      if (record.length > 0) {
        this.emit('data', record);
      }

      continue;
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

  /** Find IAC EOR (end of 5250 record) */
  private findRecordEnd(): number {
    for (let i = 0; i < this.recvBuffer.length - 1; i++) {
      if (this.recvBuffer[i] === TELNET.IAC && this.recvBuffer[i + 1] === TELNET.EOR) {
        return i;
      }
    }
    return -1;
  }

  /** Remove IAC IAC escaping from data */
  private unescapeIAC(data: Buffer): Buffer {
    const result: number[] = [];
    for (let i = 0; i < data.length; i++) {
      if (data[i] === TELNET.IAC && i + 1 < data.length && data[i + 1] === TELNET.IAC) {
        result.push(TELNET.IAC);
        i++; // skip doubled IAC
      } else {
        result.push(data[i]);
      }
    }
    return Buffer.from(result);
  }

  private handleNegotiation(cmd: number, option: number): void {
    switch (cmd) {
      case TELNET.DO:
        // Server asks us to enable something
        // Refuse TN5250E — our subneg is incomplete; server will fall back to TTYPE
        if (option === TELNET.OPT_TTYPE ||
            option === TELNET.OPT_EOR ||
            option === TELNET.OPT_BINARY ||
            option === TELNET.OPT_NEW_ENVIRON) {
          this.sendTelnet(TELNET.WILL, option);
        } else {
          this.sendTelnet(TELNET.WONT, option);
        }
        break;

      case TELNET.WILL:
        // Server offers to enable something
        if (option === TELNET.OPT_EOR ||
            option === TELNET.OPT_BINARY) {
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
      // Server asks for terminal type — respond with our type
      this.sendTerminalType();
    } else if (option === TELNET.OPT_NEW_ENVIRON) {
      // Server asks for environment variables — send empty response
      this.sendEnviron(data);
    } else if (option === TELNET.OPT_TN5250E) {
      // TN5250E subnegotiation — handle device name etc.
      this.handleTN5250ESubneg(data);
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

  private sendEnviron(data: Buffer): void {
    // Send empty NEW-ENVIRON response
    const buf = Buffer.from([
      TELNET.IAC, TELNET.SB, TELNET.OPT_NEW_ENVIRON,
      0x00, // IS
      TELNET.IAC, TELNET.SE,
    ]);
    this.sendRaw(buf);
  }

  private handleTN5250ESubneg(_data: Buffer): void {
    // TN5250E is refused during negotiation (WONT), so this should not be called.
    // If it is, ignore — the server will fall back to TTYPE negotiation.
  }

  private sendTelnet(cmd: number, option: number): void {
    this.sendRaw(Buffer.from([TELNET.IAC, cmd, option]));
  }
}
