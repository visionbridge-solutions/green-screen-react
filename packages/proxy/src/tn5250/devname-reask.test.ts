import { describe, it, expect } from 'vitest';
import { TN5250Connection } from './connection.js';
import { TELNET } from './constants.js';

// RFC 2877 §6: when the requested DEVNAME cannot be used, the server answers
// the client's NEW_ENVIRON IS with ANOTHER SEND that names DEVNAME. Replaying
// the same name only earns a closed socket (observed 2026-09-05: three silent
// re-asks per connect, a blank screen upstream, the integrator advised to
// "reconnect"). The second ask is a fatal, non-recoverable verdict.

const SEND = 0x01;
const USERVAR = 0x03;
const VAR = 0x00;
const bytes = (s: string) => Array.from(Buffer.from(s, 'latin1'));

// First request the IBM i sends: SEND USERVAR "IBMRSEED"<8 seed bytes> VAR USERVAR
const INITIAL_SEND = Buffer.from([
  TELNET.OPT_NEW_ENVIRON, SEND, USERVAR, ...bytes('IBMRSEED'), 1, 2, 3, 4, 5, 6, 7, 8, VAR, USERVAR,
]);
// The re-ask: SEND USERVAR "DEVNAME"
const DEVNAME_REASK = Buffer.from([TELNET.OPT_NEW_ENVIRON, SEND, USERVAR, ...bytes('DEVNAME')]);

function connectionUnderTest(devname?: string) {
  const conn = new TN5250Connection();
  const sent: Buffer[] = [];
  const errors: Array<Error & { code?: string; fatal?: boolean }> = [];
  (conn as unknown as { sendRaw: (b: Buffer) => void }).sendRaw = (b: Buffer) => { sent.push(b); };
  (conn as unknown as { disconnect: () => void }).disconnect = () => { /* no socket in the test */ };
  conn.on('error', (e) => errors.push(e));
  if (devname) conn.setEnvVars({ DEVNAME: devname });
  const subneg = (data: Buffer) =>
    (conn as unknown as { handleSubnegotiation: (d: Buffer) => void }).handleSubnegotiation(data);
  return { conn, sent, errors, subneg };
}

describe('TN5250Connection — DEVNAME re-ask is a fatal verdict', () => {
  it('answers the initial NEW_ENVIRON SEND with our DEVNAME', () => {
    const { sent, errors, subneg } = connectionUnderTest('LB8EB63D9D');
    subneg(INITIAL_SEND);
    expect(errors).toEqual([]);
    expect(sent).toHaveLength(1);
    expect(sent[0].toString('latin1')).toContain('DEVNAME');
    expect(sent[0].toString('latin1')).toContain('LB8EB63D9D');
  });

  it('a second SEND naming DEVNAME raises DEVICE_NAME_REJECTED and replays nothing', () => {
    const { sent, errors, subneg } = connectionUnderTest('LB8EB63D9D');
    subneg(INITIAL_SEND);
    subneg(DEVNAME_REASK);
    expect(sent).toHaveLength(1);
    expect(errors).toHaveLength(1);
    expect(errors[0].code).toBe('DEVICE_NAME_REJECTED');
    expect(errors[0].fatal).toBe(true);
    expect(errors[0].message).toContain('LB8EB63D9D');
    expect(errors[0].message.toLowerCase()).toContain('device not available');
  });

  it('without a DEVNAME of our own, a DEVNAME request is answered like any other', () => {
    const { sent, errors, subneg } = connectionUnderTest();
    subneg(INITIAL_SEND);
    subneg(DEVNAME_REASK);
    expect(errors).toEqual([]);
    expect(sent).toHaveLength(2);
  });

  it('isDevnameReask recognises only a SEND that names DEVNAME', () => {
    expect(TN5250Connection.isDevnameReask(DEVNAME_REASK)).toBe(true);
    expect(TN5250Connection.isDevnameReask(INITIAL_SEND)).toBe(false);
    expect(TN5250Connection.isDevnameReask(Buffer.from([TELNET.OPT_NEW_ENVIRON, 0x00]))).toBe(false);
  });
});
