/**
 * `POST /disconnect` with `signOff: false` closes the socket WITHOUT typing.
 *
 * The graceful exit types SIGNOFF into the widest input field of whatever
 * screen is up and presses Enter. On a menu that ends the job; on a
 * data-entry screen it SUBMITS that screen with "SIGNOFF" in one of its
 * fields. An integrator that cannot prove its session stands where SIGNOFF is
 * a command asks for the bare close instead, and the host's own
 * disconnected-job handling ends the job.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import express from 'express';
import type { AddressInfo } from 'net';
import type { Server } from 'http';
import routes from './routes.js';
import { createSession, getAllSessions, getSession } from './session.js';
import { getSessionStore } from './session-store.js';

let server: Server;
let base: string;

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use(routes);
  server = app.listen(0);
  await new Promise<void>((resolve) => server.once('listening', () => resolve()));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));
afterEach(() => {
  for (const s of Array.from(getAllSessions())) getSessionStore().delete(s.id);
  vi.restoreAllMocks();
});

/** An authenticated session on a stubbed host: the graceful exit is a spy. */
async function signedOn() {
  const session = createSession('tn5250');
  vi.spyOn(session.handler, 'connect').mockResolvedValue(undefined);
  vi.spyOn(session.handler, 'disconnect').mockImplementation(() => {});
  await session.connect('ibmi.example', 23, {} as never);
  (session as unknown as { _status: { status: string } })._status.status = 'authenticated';
  const exit = vi.fn().mockResolvedValue(true);
  (session.handler as unknown as { attemptGracefulExit: typeof exit }).attemptGracefulExit = exit;
  const destroyed = vi.spyOn(session.handler, 'destroy');
  return { session, exit, destroyed };
}

async function disconnect(sessionId: string, body?: unknown, query = '') {
  const res = await fetch(`${base}/disconnect${query}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Session-Id': sessionId },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return res.json() as Promise<{ success: boolean; signedOff?: boolean }>;
}

describe('a disconnect that must not type', () => {
  it('signOff: false closes the socket and types nothing', async () => {
    const { session, exit, destroyed } = await signedOn();
    const res = await disconnect(session.id, { signOff: false });
    expect(res).toEqual({ success: true, signedOff: false });
    expect(exit).not.toHaveBeenCalled();
    expect(destroyed).toHaveBeenCalled();
    expect(getSession(session.id)).toBeUndefined();
  });

  it('?signOff=false is the same close', async () => {
    const { session, exit } = await signedOn();
    await disconnect(session.id, undefined, '?signOff=false');
    expect(exit).not.toHaveBeenCalled();
    expect(getSession(session.id)).toBeUndefined();
  });

  it('a plain disconnect still signs off first', async () => {
    const { session, exit } = await signedOn();
    const res = await disconnect(session.id);
    expect(res).toEqual({ success: true, signedOff: true });
    expect(exit).toHaveBeenCalledTimes(1);
    expect(getSession(session.id)).toBeUndefined();
  });
});
