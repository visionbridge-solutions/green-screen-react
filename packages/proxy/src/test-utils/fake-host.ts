/**
 * FakeHost — a scripted TCP server for connection-level protocol tests.
 *
 * Drives real sockets so telnet negotiation, EOR framing, and IAC escaping
 * are exercised end-to-end without a live host. A script is an ordered list
 * of steps; the host walks it as the client talks:
 *
 *   const host = await FakeHost.start([
 *     expectBytes(Buffer.from([0xff, 0xfd, 0x19])),  // wait for DO EOR
 *     sendBytes(Buffer.from([0xff, 0xfb, 0x19])),    // reply WILL EOR
 *     closeConnection(),
 *   ]);
 *   // connect a ProtocolHandler to 127.0.0.1:host.port …
 *   await host.finished;   // rejects on byte mismatch / timeout
 *   await host.stop();
 *
 * `expectBytes` consumes exactly the given bytes from the inbound stream and
 * fails fast on the first mismatching byte, so a desync points at the exact
 * offset. Inbound bytes arriving while no expect step is active are buffered.
 */
import net from 'node:net';

export type FakeHostStep =
  | { kind: 'expect'; bytes: Buffer; label?: string }
  | { kind: 'send'; bytes: Buffer }
  | { kind: 'wait'; ms: number }
  | { kind: 'close' };

export function expectBytes(bytes: Buffer | number[], label?: string): FakeHostStep {
  return { kind: 'expect', bytes: Buffer.from(bytes as Buffer), label };
}

export function sendBytes(bytes: Buffer | number[]): FakeHostStep {
  return { kind: 'send', bytes: Buffer.from(bytes as Buffer) };
}

export function waitMs(ms: number): FakeHostStep {
  return { kind: 'wait', ms };
}

export function closeConnection(): FakeHostStep {
  return { kind: 'close' };
}

export class FakeHost {
  readonly port: number;
  readonly finished: Promise<void>;
  /** Every byte the client sent, in order — inspect after `finished`. */
  readonly received: Buffer[] = [];

  private readonly server: net.Server;
  private socket: net.Socket | null = null;
  private inbound: Buffer = Buffer.alloc(0);
  private stepIndex = 0;
  private resolveFinished!: () => void;
  private rejectFinished!: (err: Error) => void;
  private settled = false;
  private timeout: NodeJS.Timeout | null = null;

  private constructor(
    private readonly steps: FakeHostStep[],
    server: net.Server,
    port: number,
  ) {
    this.server = server;
    this.port = port;
    this.finished = new Promise<void>((resolve, reject) => {
      this.resolveFinished = resolve;
      this.rejectFinished = reject;
    });
    // Swallow unhandled-rejection noise when a test never awaits `finished`.
    this.finished.catch(() => {});
  }

  static async start(steps: FakeHostStep[], opts: { timeoutMs?: number } = {}): Promise<FakeHost> {
    const server = net.createServer();
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => resolve());
    });
    const address = server.address() as net.AddressInfo;
    const host = new FakeHost(steps, server, address.port);
    server.on('connection', (socket) => host.onConnection(socket));
    host.armTimeout(opts.timeoutMs ?? 5000);
    return host;
  }

  async stop(): Promise<void> {
    if (this.timeout) clearTimeout(this.timeout);
    this.socket?.destroy();
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
    if (!this.settled) this.succeed(); // stopping early with no pending expectations is fine
  }

  private armTimeout(timeoutMs: number): void {
    this.timeout = setTimeout(() => this.fail(new Error(this.timeoutMessage())), timeoutMs);
  }

  private timeoutMessage(): string {
    const step = this.steps[this.stepIndex];
    if (step?.kind === 'expect') {
      const label = step.label ? ` ${step.label}` : '';
      const preview = hex(this.inbound.subarray(0, 32));
      return (
        `FakeHost timed out at step ${this.stepIndex} (expect${label}: ` +
        `waiting for ${step.bytes.length} bytes, have ${this.inbound.length}: ${preview})`
      );
    }
    return `FakeHost timed out at step ${this.stepIndex} (${step?.kind ?? 'done'})`;
  }

  private onConnection(socket: net.Socket): void {
    if (this.socket) {
      socket.destroy();
      this.fail(new Error('FakeHost got a second connection'));
      return;
    }
    this.socket = socket;
    socket.on('data', (chunk: Buffer) => {
      this.received.push(chunk);
      this.inbound = Buffer.concat([this.inbound, chunk]);
      this.advance();
    });
    socket.on('error', () => {});
    this.advance();
  }

  private advance(): void {
    while (!this.settled && this.stepIndex < this.steps.length) {
      if (this.applyStep(this.steps[this.stepIndex]) === 'wait') return;
    }
    if (!this.settled && this.stepIndex >= this.steps.length) this.succeed();
  }

  private applyStep(step: FakeHostStep): 'wait' | 'continue' {
    switch (step.kind) {
      case 'send':
        this.socket!.write(step.bytes);
        this.stepIndex++;
        return 'continue';
      case 'close':
        this.socket!.end();
        this.stepIndex++;
        return 'continue';
      case 'wait':
        this.stepIndex++;
        setTimeout(() => this.advance(), step.ms);
        return 'wait';
      case 'expect':
        return this.applyExpect(step);
    }
  }

  private applyExpect(step: Extract<FakeHostStep, { kind: 'expect' }>): 'wait' | 'continue' {
    const want = step.bytes;
    const have = this.inbound;
    const overlap = Math.min(want.length, have.length);
    for (let i = 0; i < overlap; i++) {
      if (have[i] !== want[i]) {
        const label = step.label ? ` (${step.label})` : '';
        this.fail(
          new Error(
            `FakeHost byte mismatch at step ${this.stepIndex}${label} offset ${i}: ` +
              `expected 0x${want[i].toString(16)}, got 0x${have[i].toString(16)} ` +
              `(inbound: ${hex(have.subarray(0, 32))})`,
          ),
        );
        return 'wait';
      }
    }
    if (have.length < want.length) return 'wait'; // need more bytes
    this.inbound = have.subarray(want.length);
    this.stepIndex++;
    return 'continue';
  }

  private succeed(): void {
    if (this.settled) return;
    this.settled = true;
    if (this.timeout) clearTimeout(this.timeout);
    this.resolveFinished();
  }

  private fail(err: Error): void {
    if (this.settled) return;
    this.settled = true;
    if (this.timeout) clearTimeout(this.timeout);
    this.rejectFinished(err);
  }
}

function hex(buf: Buffer): string {
  return [...buf].map((b) => b.toString(16).padStart(2, '0')).join(' ');
}
