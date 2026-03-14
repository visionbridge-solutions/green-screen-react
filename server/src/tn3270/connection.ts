import * as net from 'net';
import { EventEmitter } from 'events';
import { TELNET } from '../tn5250/constants.js';
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
  private recvBuffer: Buffer = Buffer.alloc(0);
  private tn3270eMode: boolean = false;

  get isConnected(): boolean {
    return this.connected;
  }

  connect(host: string, port: number): Promise<void> {
    return new Promise((resolve, reject) => {
      if (this.socket) {
        this.disconnect();
      }

      this.host = host;
      this.port = port;
      this.recvBuffer = Buffer.alloc(0);
      this.tn3270eMode = false;

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

  private processBuffer(): void {
    while (this.recvBuffer.length > 0) {
      // Check for Telnet commands
      if (this.recvBuffer[0] === TELNET.IAC && this.recvBuffer.length >= 2) {
        const cmd = this.recvBuffer[1];

        if (cmd === TELNET.IAC) {
          // Escaped 0xFF — part of data stream
          break;
        }

        // Subnegotiation
        if (cmd === TELNET.SB) {
          const seIdx = this.findSubnegEnd();
          if (seIdx === -1) return;
          const subData = this.recvBuffer.subarray(2, seIdx);
          this.recvBuffer = this.recvBuffer.subarray(seIdx + 2);
          this.handleSubnegotiation(subData);
          continue;
        }

        // DO/DONT/WILL/WONT
        if (cmd === TELNET.DO || cmd === TELNET.DONT || cmd === TELNET.WILL || cmd === TELNET.WONT) {
          if (this.recvBuffer.length < 3) return;
          const option = this.recvBuffer[2];
          this.recvBuffer = this.recvBuffer.subarray(3);
          this.handleNegotiation(cmd, option);
          continue;
        }

        if (cmd === TELNET.EOR) {
          this.recvBuffer = this.recvBuffer.subarray(2);
          continue;
        }

        // Skip unknown 2-byte commands
        this.recvBuffer = this.recvBuffer.subarray(2);
        continue;
      }

      // Extract a 3270 record: data terminated by IAC EOR
      const recordEnd = this.findRecordEnd();
      if (recordEnd === -1) return;

      const rawRecord = this.recvBuffer.subarray(0, recordEnd);
      this.recvBuffer = this.recvBuffer.subarray(recordEnd + 2);

      const record = this.unescapeIAC(rawRecord);
      if (record.length > 0) {
        // In TN3270E mode, strip the 5-byte header
        if (this.tn3270eMode && record.length > 5) {
          const dataRecord = record.subarray(5);
          if (dataRecord.length > 0) {
            this.emit('data', dataRecord);
          }
        } else {
          this.emit('data', record);
        }
      }
    }
  }

  private findSubnegEnd(): number {
    for (let i = 2; i < this.recvBuffer.length - 1; i++) {
      if (this.recvBuffer[i] === TELNET.IAC && this.recvBuffer[i + 1] === TELNET.SE) {
        return i;
      }
    }
    return -1;
  }

  private findRecordEnd(): number {
    for (let i = 0; i < this.recvBuffer.length - 1; i++) {
      if (this.recvBuffer[i] === TELNET.IAC && this.recvBuffer[i + 1] === TELNET.EOR) {
        return i;
      }
    }
    return -1;
  }

  private unescapeIAC(data: Buffer): Buffer {
    const result: number[] = [];
    for (let i = 0; i < data.length; i++) {
      if (data[i] === TELNET.IAC && i + 1 < data.length && data[i + 1] === TELNET.IAC) {
        result.push(TELNET.IAC);
        i++;
      } else {
        result.push(data[i]);
      }
    }
    return Buffer.from(result);
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
