/**
 * A connection the far end closed before sending a single byte.
 *
 * Every protocol here begins with the host talking first (telnet option
 * negotiation for TN5250/TN3270/VT/HP6530). A socket that opens and then closes
 * with nothing received never reached a host that negotiated — whatever sits in
 * front of it (a tunnel, a relay, a firewall, an SSH forward refusing the
 * caller) accepted the TCP connection and dropped it. Without this verdict the
 * integrator sees only "connected, then no screen", which reads exactly like a
 * host that negotiated and then refused a device, and blames the customer's
 * system for a refusal on our own side of the line (2026-11-09: a staging relay
 * refused by the SSH sidecar was reported as "no virtual device available on
 * the host").
 *
 * Not fatal: a route that dropped one connection may carry the next, so
 * auto-reconnect still tries.
 */
export const CLOSED_BEFORE_DATA = 'CLOSED_BEFORE_DATA';

/** Counts the bytes a connection has received since its socket opened. */
export class FirstByteWatch {
  private received = 0;

  /** A new socket: nothing received yet. */
  reset(): void {
    this.received = 0;
  }

  note(byteCount: number): void {
    this.received += byteCount;
  }

  /** True while the far end has sent nothing at all. */
  get silent(): boolean {
    return this.received === 0;
  }
}

export function closedBeforeDataError(host: string, port: number): Error & { code: string; fatal: false } {
  return Object.assign(
    new Error(
      `connection to ${host}:${port} closed before the host sent anything (no telnet negotiation took place): ` +
      'the route to the host accepted the connection and dropped it',
    ),
    { code: CLOSED_BEFORE_DATA, fatal: false as const },
  );
}
