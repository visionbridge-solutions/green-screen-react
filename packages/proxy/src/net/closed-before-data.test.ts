import { describe, it, expect, afterEach } from 'vitest';
import * as net from 'net';
import { EventEmitter } from 'events';
import { TN5250Connection } from '../tn5250/connection.js';
import { TN3270Connection } from '../tn3270/connection.js';
import { VTConnection } from '../vt/connection.js';
import { HP6530Connection } from '../hp6530/connection.js';
import { CLOSED_BEFORE_DATA } from './closed-before-data.js';

// A socket the far end closes before sending one byte never reached a host
// that negotiated: a relay or an SSH forward refused the caller. 2026-11-09 a
// staging relay refused by the SSH sidecar reached the integrator as "connected,
// no screen" and was reported as "no virtual device available on the host".
// Every protocol says so with CLOSED_BEFORE_DATA; a close after any byte is an
// ordinary drop.
//
// Mutation checks: the close handler without the verdict -> "says so" red for
// that protocol; the verdict on every close (not only silent ones) -> "an
// ordinary drop" red; the watch not reset on connect -> the second-connect case red.

type Conn = EventEmitter & { connect(host: string, port: number): Promise<void> };
const PROTOCOLS: Array<[string, () => Conn]> = [
  ['tn5250', () => new TN5250Connection() as unknown as Conn],
  ['tn3270', () => new TN3270Connection() as unknown as Conn],
  ['vt', () => new VTConnection() as unknown as Conn],
  ['hp6530', () => new HP6530Connection() as unknown as Conn],
];

const servers: net.Server[] = [];
const sockets: net.Socket[] = [];
afterEach(async () => {
  sockets.splice(0).forEach((s) => s.destroy());
  await Promise.all(servers.splice(0).map((s) => new Promise((r) => s.close(() => r(null)))));
});

/** A far end that, per connection, optionally writes `bytes` then closes. */
async function farEnd(bytes: number[][]): Promise<number> {
  let n = 0;
  const server = net.createServer((sock) => {
    sockets.push(sock);
    sock.on('error', () => { /* the client may reset; irrelevant here */ });
    const say = bytes[n++] ?? [];
    if (say.length) sock.write(Buffer.from(say));
    setTimeout(() => sock.destroy(), 50);
  });
  servers.push(server);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  return (server.address() as net.AddressInfo).port;
}

async function runOnce(conn: Conn, port: number): Promise<Array<Error & { code?: string }>> {
  const errors: Array<Error & { code?: string }> = [];
  const onError = (e: Error & { code?: string }) => errors.push(e);
  conn.on('error', onError);
  const gone = new Promise<void>((r) => conn.once('disconnected', () => r()));
  await conn.connect('127.0.0.1', port);
  await gone;
  conn.off('error', onError);
  return errors;
}

describe.each(PROTOCOLS)('%s — a close before any byte is the route, not the host', (_name, make) => {
  it('says so: CLOSED_BEFORE_DATA, then disconnected', async () => {
    const port = await farEnd([[]]);
    const errors = await runOnce(make(), port);
    expect(errors.map((e) => e.code)).toEqual([CLOSED_BEFORE_DATA]);
    expect(errors[0].message).toContain('closed before the host sent anything');
  });

  it('a close after the host spoke is an ordinary drop (no verdict)', async () => {
    // IAC DO TERMINAL-TYPE — the first thing a telnet host says.
    const port = await farEnd([[0xff, 0xfd, 0x18]]);
    const errors = await runOnce(make(), port);
    expect(errors.filter((e) => e.code === CLOSED_BEFORE_DATA)).toEqual([]);
  });

  it('the watch starts over on a new connect', async () => {
    const port = await farEnd([[0xff, 0xfd, 0x18], []]);
    const conn = make();
    expect((await runOnce(conn, port)).filter((e) => e.code === CLOSED_BEFORE_DATA)).toEqual([]);
    expect((await runOnce(conn, port)).map((e) => e.code)).toEqual([CLOSED_BEFORE_DATA]);
  });
});
