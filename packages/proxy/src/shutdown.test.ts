/**
 * The proxy's shutdown tells integrators what it is doing.
 *
 * It used to drain every session in silence: no `session.lost`, and — to a
 * WebSocket watcher — a bare `status: disconnected` from the controller
 * wrapping the session, which on an auto-reconnecting session reads as "the
 * proxy is recovering this". LegacyBridge deferred to that recovery for 90 s
 * after every proxy roll (2026-10-01).
 *
 * Pinned here:
 *   - each drained session is announced `session.lost` (disconnected, with the
 *     SHUTTING_DOWN error) once it is gone from the store, and the WS
 *     controllers are shut down after the sessions;
 *   - while draining, `/status` answers 503 and `/connect` refuses, so a
 *     client waiting for a proxy to come back does not take the leaving one
 *     for it, and no session opens only to be cut by the exit;
 *   - a controller adopted onto a REST session is left to the session drain,
 *     even once the store no longer holds that session.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import express from 'express';
import type { AddressInfo } from 'net';
import type { Server } from 'http';
import routes from './routes.js';
import { createSession, getAllSessions } from './session.js';
import { getSessionStore, sessionLifecycle } from './session-store.js';
import { SHUTTING_DOWN, drainForShutdown, isShuttingDown, resetShutdownStateForTests } from './shutdown.js';
import { SessionController } from './controller.js';
import { wrapsARestSession } from './websocket.js';

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
  resetShutdownStateForTests();
  for (const s of Array.from(getAllSessions())) getSessionStore().delete(s.id);
  vi.restoreAllMocks();
});

function liveSession(host: string) {
  const session = createSession('tn5250');
  vi.spyOn(session.handler, 'disconnect').mockImplementation(() => {});
  (session as unknown as { _status: object })._status = {
    connected: true, status: 'connected', protocol: 'tn5250', host,
  };
  return session;
}

describe('the shutdown drain', () => {
  it('announces every drained session lost, then shuts the WS controllers', async () => {
    const a = liveSession('sshbridge');
    const b = liveSession('ibmi.example');
    const order: string[] = [];
    const lost = vi.fn((id: string) => order.push(`lost:${id}`));
    sessionLifecycle.on('session.lost', lost);

    await drainForShutdown(async () => { order.push('ws'); });

    expect(getAllSessions()).toHaveLength(0);
    expect(isShuttingDown()).toBe(true);
    for (const s of [a, b]) {
      const [, status] = lost.mock.calls.find(([id]) => id === s.id)!;
      expect(status).toMatchObject({ connected: false, status: 'disconnected', error: SHUTTING_DOWN });
    }
    expect(order[order.length - 1]).toBe('ws');
    sessionLifecycle.off('session.lost', lost);
  });
});

describe('a draining proxy starts nothing', () => {
  it('/status answers 503 — it is not the proxy to wait for', async () => {
    const before = await fetch(`${base}/status`);
    expect(before.status).toBe(200);
    await drainForShutdown(async () => {});
    const during = await fetch(`${base}/status`);
    expect(during.status).toBe(503);
    expect(await during.json()).toMatchObject({ ok: false, shuttingDown: true });
  });

  it('/connect refuses', async () => {
    await drainForShutdown(async () => {});
    const res = await fetch(`${base}/connect`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ host: 'ibmi.example', port: 23 }),
    });
    expect(res.status).toBe(503);
    expect(getAllSessions()).toHaveLength(0);
  });
});

describe('a controller adopted onto a REST session', () => {
  it('is left to the session drain even once the store is empty', () => {
    const session = liveSession('sshbridge');
    const ctrl = new SessionController(() => {});
    ctrl.adoptHandler(session.handler);
    getSessionStore().delete(session.id); // what the drain has done by now
    expect(wrapsARestSession(ctrl, session.id)).toBe(true);
  });

  it('a controller that owns its handler is shut down by the WS drain', () => {
    expect(wrapsARestSession(new SessionController(() => {}), 'some-id')).toBe(false);
  });
});
