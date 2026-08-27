import * as net from 'net';
import * as tls from 'tls';
import { EventEmitter } from 'events';
import { TELNET, TERMINAL_TYPE as DEFAULT_TERMINAL_TYPE } from './constants.js';
import { TelnetRecordStream } from '../net/telnet.js';

export interface ConnectionEvents {
  connected: () => void;
  disconnected: () => void;
  data: (record: Buffer) => void;
  error: (err: Error) => void;
}

export interface TN5250ConnectOptions {
  /** Terminal type for TTYPE negotiation (e.g. 'IBM-3179-2'). */
  terminalType?: string;
  connectTimeout?: number;
  /**
   * Telnet-over-TLS (IBM i "Telnet SSL", conventionally port 992). The TLS
   * handshake must complete before any telnet byte flows; a handshake
   * failure rejects the connect — there is NO fallback to plaintext.
   */
  tls?: boolean;
  /**
   * Verify the host certificate chain (default true). Set false only for
   * hosts with self-signed certs that can't be pinned via `caCert` —
   * traffic is still encrypted, but not MITM-resistant.
   */
  tlsVerify?: boolean;
  /** PEM CA (or self-signed host cert) to trust for verification. */
  caCert?: string;
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
  /** True iff the CURRENT socket completed a TLS handshake. Read from actual
   * socket state at connect time, never echoed from the request — integrators
   * assert this to prove no plaintext leg exists (see routes `security.tls`). */
  private secured: boolean = false;
  private readonly stream = new TelnetRecordStream({
    onNegotiation: (cmd, option) => this.handleNegotiation(cmd, option),
    onSubnegotiation: (data) => this.handleSubnegotiation(data),
    onRecord: (record) => this.emit('data', record),
  });
  private negotiationDone: boolean = false;
  private terminalType: string = DEFAULT_TERMINAL_TYPE;
  /** Environment variables to send in NEW_ENVIRON (e.g., DEVNAME for device name). */
  private envVars: Record<string, string> = {};
  private keepAliveTimer: ReturnType<typeof setInterval> | null = null;
  /**
   * Wall-clock ms timestamp of the most recent byte received from the
   * host (any byte — telnet IAC, 5250 record header, payload, anything).
   * Set to ``connect()`` resolution time on session open. Updated in
   * ``onData`` before any parsing. This is the unambiguous liveness
   * signal: if (now - lastRecvAtMs) is large AND we sent something
   * after lastRecvAtMs, the host stopped replying. No interpretation of
   * screen state, no overlap with kbd-locked-for-error / etc.
   */
  private lastRecvAtMs: number = 0;
  /**
   * Wall-clock ms timestamp of the most recent AID byte sent to the
   * host. Updated only on ``sendRaw`` calls that follow a host-bound
   * AID write (AID/PRINT/CLEAR/SYS_REQUEST/etc.); telnet keepalive
   * probes and negotiation traffic do NOT count, since "is the host
   * sending us anything?" is what we're measuring against.
   * Set by callers via ``recordHostBoundSend()``.
   */
  private lastHostBoundSendAtMs: number = 0;
  private static readonly KEEP_ALIVE_INTERVAL = 15_000; // 15s — well under PUB400's ~30s idle timeout
  // Timing Mark (IAC DO TM) instead of NOP — it's a round-trip: the server
  // must respond with WILL/WONT TM.  If the IBM i interactive job has ended
  // (QINACTITV), processing the TM may cause the TELNET server to push the
  // sign-on screen, enabling early timeout detection.
  private static readonly KEEP_ALIVE_TM = Buffer.from([TELNET.IAC, TELNET.DO, TELNET.OPT_TIMING_MARK]);

  get isConnected(): boolean {
    return this.connected;
  }

  /** Whether the live socket is TLS-secured (false when disconnected). */
  get isTls(): boolean {
    return this.connected && this.secured;
  }

  get remoteHost(): string {
    return this.host;
  }

  get remotePort(): number {
    return this.port;
  }

  /** Wall-clock ms of the most recent byte received from the host. 0 if never. */
  get lastReceivedAtMs(): number {
    return this.lastRecvAtMs;
  }

  /** Wall-clock ms of the most recent byte sent to the host. 0 if never.
   * Includes 5250 records, telnet negotiation, telnet keepalive — every
   * write that expects a reply. */
  get lastSentAtMs(): number {
    return this.lastHostBoundSendAtMs;
  }

  /**
   * Set environment variables to send during NEW_ENVIRON negotiation.
   * Per lib5250 telnetstr.c:632-664, these are sent as VAR name VALUE value
   * pairs. Common vars: DEVNAME (device name), TERM, IBMMFRTYPMDL.
   */
  setEnvVars(vars: Record<string, string>): void {
    this.envVars = { ...vars };
  }

  connect(host: string, port: number, options?: TN5250ConnectOptions): Promise<void> {
    return new Promise((resolve, reject) => {
      if (this.socket) {
        this.disconnect();
      }

      this.host = host;
      this.port = port;
      this.stream.reset();
      this.negotiationDone = false;
      this.terminalType = options?.terminalType || DEFAULT_TERMINAL_TYPE;
      this.secured = false;

      const onError = (err: Error) => {
        this.cleanup();
        reject(err);
      };

      // Pre-connect stall (TCP connect or TLS handshake hanging against a
      // half-open/wrong-protocol listener): destroy with an error so the
      // connect promise rejects instead of dangling until a caller-side
      // watchdog reaps the session.
      const onConnectTimeout = () => {
        this.socket?.destroy(new Error('Connection timeout during connect/handshake'));
      };

      // The connected callback fires on plain TCP connect, or — in TLS mode —
      // on 'secureConnect', i.e. only after the handshake completed. A failed
      // handshake surfaces as an 'error' and rejects; telnet negotiation can
      // therefore never start on an unencrypted socket when TLS was requested.
      const onConnected = () => {
        this.connected = true;
        this.secured = this.socket instanceof tls.TLSSocket;
        // Seed the recv timestamp so a brand-new session looks alive
        // even before the first byte arrives from the host.
        this.lastRecvAtMs = Date.now();
        this.socket!.removeListener('error', onError);
        this.socket!.removeListener('timeout', onConnectTimeout);

        // Enable OS-level TCP keepalive. Linux defaults (75s probe
        // interval × 9 probes after the initial-delay window) catch
        // half-open connections via TCP-layer retransmission timeout.
        // Initial delay 30s — no probes during normal traffic.
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
          // A socket timeout does NOT close the socket — Node just fires the
          // event. Destroy it so the half-open connection can't dangle (and so
          // the 'close' handler runs cleanup + emits 'disconnected').
          this.socket?.destroy();
        });

        this.socket!.on('data', (data: Buffer) => this.onData(data));

        this.startKeepAlive();
        this.emit('connected');
        resolve();
      };

      if (options?.tls) {
        // tls.connect starts the TCP + TLS handshake immediately; the
        // callback is the 'secureConnect' event. SNI defaults to `host`
        // for hostnames (Node omits it for IP literals automatically).
        this.socket = tls.connect(
          {
            host,
            port,
            rejectUnauthorized: options.tlsVerify !== false,
            ca: options.caCert ? [options.caCert] : undefined,
          },
          onConnected,
        );
      } else {
        this.socket = new net.Socket();
        this.socket.connect(port, host, onConnected);
      }

      this.socket.setTimeout(options?.connectTimeout ?? 30000);
      this.socket.once('error', onError);
      this.socket.once('timeout', onConnectTimeout);
    });
  }

  disconnect(): void {
    if (this.socket) {
      console.log(`[tn5250] Disconnecting socket to ${this.socket.remoteAddress}:${this.socket.remotePort}`);
      // Send FIN first, then destroy to ensure TCP session closes on the host
      try { this.socket.end(); } catch { /* ignore */ }
      this.cleanup();
    }
  }

  /** Send raw bytes over the socket. Stamps ``lastHostBoundSendAtMs``
   * so the liveness check has a definitive "did the host respond
   * since I last asked it something?" comparison. Includes telnet
   * negotiation and keepalive — they all expect host replies. */
  sendRaw(data: Buffer): void {
    if (this.socket && this.connected) {
      this.lastHostBoundSendAtMs = Date.now();
      this.socket.write(data);
    }
  }

  private startKeepAlive(): void {
    this.stopKeepAlive();
    this.keepAliveTimer = setInterval(() => {
      if (!this.socket || !this.connected) return;

      // Send the IAC DO TIMING-MARK probe. This serves two purposes
      // even though IBM i doesn't always reply:
      //   1. Keeps idle TCP traffic flowing so middleboxes (NAT,
      //      load balancers, ssh tunnel, etc.) don't drop the
      //      connection as inactive.
      //   2. Best-effort liveness signal — when the kernel's TCP
      //      stack tries to flush the write to a dead socket, it
      //      eventually returns EPIPE/ECONNRESET, triggering the
      //      socket 'error' handler which emits 'disconnected'.
      //
      // We INTENTIONALLY do NOT do app-layer dead-link detection
      // here. An earlier attempt (45s of "no host data" → declare
      // dead) caused false positives during normal idle, because
      // IBM i frequently doesn't respond to TIMING-MARK at all on
      // some screens — the protocol allows but does not require it.
      // Real dead-link detection is delegated to:
      //   - OS-level TCP_KEEPALIVE (set in connect()) — ~12 min
      //     fallback when the kernel discovers the connection is
      //     half-open via retransmission timeout.
      //   - The proxy session orphan reaper — 5 min idle TTL.
      //   - The api-side stale-session detection — fires on the
      //     first send that fails after a real keystroke.
      this.sendRaw(TN5250Connection.KEEP_ALIVE_TM);
    }, TN5250Connection.KEEP_ALIVE_INTERVAL);
  }

  private stopKeepAlive(): void {
    if (this.keepAliveTimer) {
      clearInterval(this.keepAliveTimer);
      this.keepAliveTimer = null;
    }
  }

  private cleanup(): void {
    this.stopKeepAlive();
    this.connected = false;
    this.secured = false;
    if (this.socket) {
      this.socket.removeAllListeners();
      this.socket.destroy();
      this.socket = null;
    }
  }

  private onData(data: Buffer): void {
    // Stamp before any parsing — every byte from the host counts as
    // proof of a live link, regardless of what protocol layer
    // ultimately consumes it.
    this.lastRecvAtMs = Date.now();

    this.stream.feed(data);
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
        } else if (option === TELNET.OPT_TIMING_MARK) {
          // WILL TM is the response to our keep-alive DO TM — the mark is
          // complete, no further reply needed (RFC 860).
        } else {
          this.sendTelnet(TELNET.DONT, option);
        }
        break;

      case TELNET.DONT:
        this.sendTelnet(TELNET.WONT, option);
        break;

      case TELNET.WONT:
        if (option === TELNET.OPT_TIMING_MARK) {
          // WONT TM — server declined our keep-alive probe, nothing to do.
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
    // Per lib5250 telnetstr.c:632-664: send NEW_ENVIRON IS with all env vars.
    // Each var is encoded as: VAR(0x00) name VALUE(0x01) value
    // USERVAR(0x03) can also be used for user-defined vars.
    const parts: number[] = [TELNET.IAC, TELNET.SB, TELNET.OPT_NEW_ENVIRON, 0x00 /* IS */];

    for (const [name, value] of Object.entries(this.envVars)) {
      // Use USERVAR (0x03) for custom vars like DEVNAME, VAR (0x00) for standard ones
      const varType = (name === 'TERM' || name === 'USER') ? 0x00 : 0x03;
      parts.push(varType);
      for (let i = 0; i < name.length; i++) parts.push(name.charCodeAt(i));
      parts.push(0x01); // VALUE
      for (let i = 0; i < value.length; i++) parts.push(value.charCodeAt(i));
    }

    parts.push(TELNET.IAC, TELNET.SE);
    this.sendRaw(Buffer.from(parts));
  }

  private handleTN5250ESubneg(_data: Buffer): void {
    // TN5250E is refused during negotiation (WONT), so this should not be called.
    // If it is, ignore — the server will fall back to TTYPE negotiation.
  }

  private sendTelnet(cmd: number, option: number): void {
    this.sendRaw(Buffer.from([TELNET.IAC, cmd, option]));
  }
}
