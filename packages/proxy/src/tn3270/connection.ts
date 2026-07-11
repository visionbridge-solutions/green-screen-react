import * as net from 'net';
import { EventEmitter } from 'events';
import { TELNET, TelnetRecordStream } from '../net/telnet.js';
import { TERMINAL_TYPE, TN3270E } from './constants.js';

export interface TN3270ConnectOptions {
  /** Terminal type / TN3270E device type (e.g. 'IBM-3278-2'). */
  terminalType?: string;
  connectTimeout?: number;
  /**
   * Negotiate TN3270E (RFC 2355) when the server offers it. Default true;
   * set false to force classic RFC 1576 (TTYPE + EOR + BINARY).
   */
  tn3270e?: boolean;
}

/**
 * Manages the raw TCP socket to a z/OS (or other 3270) host: telnet
 * negotiation, IAC EOR record framing (shared TelnetRecordStream), and the
 * TN3270E (RFC 2355) session layer — device-type/functions negotiation and
 * the 5-byte data header on every record in both directions.
 *
 * Falls back to classic TN3270 (RFC 1576) when the server doesn't offer
 * option 40 or `tn3270e: false` was requested.
 */
export class TN3270Connection extends EventEmitter {
  private socket: net.Socket | null = null;
  private host: string = '';
  private port: number = 23;
  private connected: boolean = false;
  private terminalType: string = TERMINAL_TYPE;

  // --- TN3270E state ---
  private tn3270eEnabled: boolean = true;
  private tn3270eMode: boolean = false;       // WILL/DO agreed on option 40
  private tn3270eNegotiated: boolean = false; // FUNCTIONS IS agreed — headers flow
  private deviceTypeRequested: string = '';
  /** Device name (LU) the server assigned via DEVICE-TYPE IS ... CONNECT. */
  private luName: string = '';
  private sendSeq: number = 0;

  /** Liveness timestamps — same contract as the TN5250 connection. */
  private lastRecvAtMs: number = 0;
  private lastSentAtMs: number = 0;

  private readonly stream = new TelnetRecordStream({
    onNegotiation: (cmd, option) => this.handleNegotiation(cmd, option),
    onSubnegotiation: (data) => this.handleSubnegotiation(data),
    onRecord: (record) => this.onRecord(record),
  });

  get isConnected(): boolean {
    return this.connected;
  }

  /** Whether the RFC 2355 session layer is active (5-byte data headers). */
  get isTn3270e(): boolean {
    return this.tn3270eNegotiated;
  }

  /** LU / device name the server bound this session to ('' if none). */
  get assignedLuName(): string {
    return this.luName;
  }

  get lastReceivedAtMs(): number {
    return this.lastRecvAtMs;
  }

  get lastSentAtMsValue(): number {
    return this.lastSentAtMs;
  }

  connect(host: string, port: number, options?: TN3270ConnectOptions): Promise<void> {
    return new Promise((resolve, reject) => {
      if (this.socket) {
        this.disconnect();
      }

      this.host = host;
      this.port = port;
      this.stream.reset();
      this.tn3270eEnabled = options?.tn3270e !== false;
      this.tn3270eMode = false;
      this.tn3270eNegotiated = false;
      this.terminalType = options?.terminalType || TERMINAL_TYPE;
      this.deviceTypeRequested = '';
      this.luName = '';
      this.sendSeq = 0;

      this.socket = new net.Socket();
      this.socket.setTimeout(options?.connectTimeout ?? 30000);

      const onError = (err: Error) => {
        this.cleanup();
        reject(err);
      };

      this.socket.once('error', onError);

      this.socket.connect(port, host, () => {
        this.connected = true;
        this.lastRecvAtMs = Date.now();
        this.socket!.removeListener('error', onError);
        try { this.socket!.setKeepAlive(true, 30_000); } catch { /* ignore */ }

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
      this.lastSentAtMs = Date.now();
      this.socket.write(data);
    }
  }

  /**
   * Send one 3270 record: prepends the TN3270E 5-byte header when the
   * session layer is active, escapes IAC bytes, appends IAC EOR.
   */
  sendRecord(record: Buffer): void {
    let payload = record;
    if (this.tn3270eNegotiated) {
      const header = Buffer.from([
        TN3270E.DT_3270_DATA, 0x00, 0x00,
        (this.sendSeq >> 8) & 0x7f, this.sendSeq & 0xff,
      ]);
      this.sendSeq = (this.sendSeq + 1) & 0x7fff;
      payload = Buffer.concat([header, record]);
    }
    const framed: number[] = [];
    for (const byte of payload) {
      framed.push(byte);
      if (byte === TELNET.IAC) framed.push(TELNET.IAC);
    }
    framed.push(TELNET.IAC, TELNET.EOR);
    this.sendRaw(Buffer.from(framed));
  }

  /**
   * Telnet TIMING-MARK probe — an application-transparent liveness
   * round-trip (the server must answer WILL/WONT TM). The 3270 analog of
   * the 5250 'Heartbeat': PA/PF keys all reach the application, so a probe
   * must stay at the telnet layer.
   */
  sendTimingMark(): void {
    this.sendRaw(Buffer.from([TELNET.IAC, TELNET.DO, TELNET.OPT_TIMING_MARK]));
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
    // Any byte from the host is liveness proof — stamp before parsing.
    this.lastRecvAtMs = Date.now();
    this.stream.feed(data);
  }

  private onRecord(record: Buffer): void {
    if (!this.tn3270eNegotiated) {
      if (record.length > 0) this.emit('data', record);
      return;
    }
    // TN3270E: every record carries the 5-byte header.
    if (record.length < 5) return;
    const dataType = record[0];
    const payload = record.subarray(5);
    switch (dataType) {
      case TN3270E.DT_3270_DATA:
      case TN3270E.DT_SSCP_LU_DATA:
        // SSCP-LU data (VTAM USSMSG screens) is an unformatted stream —
        // the parser's command-less fallback renders it.
        if (payload.length > 0) this.emit('data', payload);
        break;
      case TN3270E.DT_UNBIND:
        this.emit('unbind');
        break;
      default:
        // RESPONSE / BIND-IMAGE / NVT etc. — we negotiated no functions,
        // so these should not arrive; ignore defensively.
        break;
    }
  }

  private handleNegotiation(cmd: number, option: number): void {
    switch (cmd) {
      case TELNET.DO:
        if (option === TELNET.OPT_TN3270E && this.tn3270eEnabled) {
          this.sendTelnet(TELNET.WILL, option);
          this.tn3270eMode = true;
        } else if (option === TELNET.OPT_TTYPE ||
            option === TELNET.OPT_EOR ||
            option === TELNET.OPT_BINARY) {
          this.sendTelnet(TELNET.WILL, option);
        } else {
          this.sendTelnet(TELNET.WONT, option);
        }
        break;

      case TELNET.WILL:
        if (option === TELNET.OPT_EOR ||
            option === TELNET.OPT_BINARY) {
          this.sendTelnet(TELNET.DO, option);
        } else if (option === TELNET.OPT_TN3270E && this.tn3270eEnabled) {
          this.sendTelnet(TELNET.DO, option);
          this.tn3270eMode = true;
        } else if (option === TELNET.OPT_TIMING_MARK) {
          // Reply to our liveness probe — the timestamp update in onData
          // is the signal; no further reply needed (RFC 860).
        } else {
          this.sendTelnet(TELNET.DONT, option);
        }
        break;

      case TELNET.DONT:
        if (option === TELNET.OPT_TN3270E) {
          this.tn3270eMode = false;
          this.tn3270eNegotiated = false;
        }
        this.sendTelnet(TELNET.WONT, option);
        break;

      case TELNET.WONT:
        if (option === TELNET.OPT_TIMING_MARK) {
          // Server declined the probe — still liveness proof, nothing to do.
        } else {
          this.sendTelnet(TELNET.DONT, option);
        }
        break;
    }
  }

  private handleSubnegotiation(data: Buffer): void {
    if (data.length === 0) return;

    const option = data[0];

    if (option === TELNET.OPT_TTYPE && data.length >= 2 && data[1] === TELNET.TTYPE_SEND) {
      this.sendTerminalType();
    } else if (option === TELNET.OPT_TN3270E) {
      this.handleTN3270ESubneg(data);
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

  /**
   * RFC 2355 subnegotiation. `data` = [0x28, <byte1>, <byte2>, ...] where
   * server-initiated messages are SEND DEVICE-TYPE [0x08 0x02],
   * DEVICE-TYPE IS/REJECT [0x02 0x04|0x06 ...], FUNCTIONS REQUEST/IS
   * [0x03 0x07|0x04 ...].
   */
  private handleTN3270ESubneg(data: Buffer): void {
    if (data.length < 3) return;
    const kind = data[1];
    const op = data[2];

    if (kind === TN3270E.SEND && op === TN3270E.DEVICE_TYPE) {
      // Server: SEND DEVICE-TYPE → we REQUEST our device type (-E variant
      // for extended datastream unless the caller pinned one).
      this.deviceTypeRequested = this.terminalType.endsWith('-E')
        ? this.terminalType
        : `${this.terminalType}-E`;
      this.sendDeviceTypeRequest(this.deviceTypeRequested);
      return;
    }

    if (kind === TN3270E.DEVICE_TYPE) {
      this.handleDeviceTypeReply(op, data);
      return;
    }

    if (kind === TN3270E.FUNCTIONS) {
      this.handleFunctionsReply(op, data);
    }
  }

  private handleDeviceTypeReply(op: number, data: Buffer): void {
    if (op === TN3270E.IS) {
      // DEVICE-TYPE IS <type> [CONNECT <lu>] — accepted. Extract the LU.
      const rest = data.subarray(3).toString('latin1');
      const connectIdx = rest.indexOf(String.fromCharCode(TN3270E.CONNECT));
      if (connectIdx >= 0) {
        this.luName = rest.substring(connectIdx + 1);
      }
      // Propose the empty function set (plain terminal semantics).
      this.sendFunctions(TN3270E.REQUEST, []);
      return;
    }
    if (op === TN3270E.REJECT) {
      if (this.deviceTypeRequested.endsWith('-E')) {
        // Retry once without extended datastream.
        this.deviceTypeRequested = this.deviceTypeRequested.slice(0, -2);
        this.sendDeviceTypeRequest(this.deviceTypeRequested);
      } else {
        this.emit('error', new Error(
          `TN3270E device type rejected by host (${this.terminalType})`));
      }
    }
  }

  private handleFunctionsReply(op: number, data: Buffer): void {
    const requested = [...data.subarray(3)];
    if (op === TN3270E.IS) {
      // Agreement — with our empty proposal this should be the empty set.
      this.tn3270eNegotiated = true;
      return;
    }
    if (op === TN3270E.REQUEST) {
      if (requested.length === 0) {
        // Server proposes the empty set too — agree and go live.
        this.sendFunctions(TN3270E.IS, []);
        this.tn3270eNegotiated = true;
      } else {
        // Server wants functions we don't implement — counter with empty.
        this.sendFunctions(TN3270E.REQUEST, []);
      }
    }
  }

  private sendDeviceTypeRequest(deviceType: string): void {
    const parts: number[] = [
      TELNET.IAC, TELNET.SB, TELNET.OPT_TN3270E,
      TN3270E.DEVICE_TYPE, TN3270E.REQUEST,
    ];
    for (let i = 0; i < deviceType.length; i++) parts.push(deviceType.charCodeAt(i));
    parts.push(TELNET.IAC, TELNET.SE);
    this.sendRaw(Buffer.from(parts));
  }

  private sendFunctions(op: number, functions: number[]): void {
    this.sendRaw(Buffer.from([
      TELNET.IAC, TELNET.SB, TELNET.OPT_TN3270E,
      TN3270E.FUNCTIONS, op, ...functions,
      TELNET.IAC, TELNET.SE,
    ]));
  }

  private sendTelnet(cmd: number, option: number): void {
    this.sendRaw(Buffer.from([TELNET.IAC, cmd, option]));
  }
}
