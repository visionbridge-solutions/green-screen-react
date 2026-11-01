/**
 * Two rules of the tenant boundary, pinned at the HTTP layer:
 *
 *  - the credential-less healthcheck the auth gate admits learns that the
 *    server is up and what it can do — never a session's host or user, even
 *    when exactly one session is live (the default-session resolution);
 *  - a scoped keyed connect CLAIMS the keyed session the all-access caller
 *    opened, once, for that scope — never a session of another scope.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import express from 'express';
import type { AddressInfo } from 'net';
import type { Server } from 'http';
import routes, { claimKeyedSession } from './routes.js';
import { authGate } from './auth-gate.js';
import { mintScopedToken } from './security.js';
import { createSession, getAllSessions } from './session.js';
import { getSessionStore } from './session-store.js';

const BASE_TOKEN = 'base-secret-for-tests';
let server: Server;
let base: string;

beforeAll(async () => {
  process.env.GS_PROXY_AUTH_TOKEN = BASE_TOKEN;
  const app = express();
  app.use(express.json());
  app.use(authGate);
  app.use(routes);
  server = app.listen(0);
  await new Promise<void>((resolve) => server.once('listening', () => resolve()));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => {
  delete process.env.GS_PROXY_AUTH_TOKEN;
  return new Promise<void>((resolve) => server.close(() => resolve()));
});
afterEach(() => {
  for (const s of Array.from(getAllSessions())) getSessionStore().delete(s.id);
});

async function status(headers: Record<string, string> = {}) {
  const res = await fetch(`${base}/status`, { headers });
  return { code: res.status, body: (await res.json()) as Record<string, unknown> };
}

describe('the bare healthcheck', () => {
  it('answers an anonymous probe with liveness only, even with one live session', async () => {
    const session = createSession('tn5250');
    session.markAuthenticated('OPERATOR1');
    const { code, body } = await status();
    expect(code).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.sessions).toBe(1);
    expect(body.capabilities).toContain('scoped-auth');
    expect(body).not.toHaveProperty('username');
    expect(body).not.toHaveProperty('host');
    expect(body).not.toHaveProperty('connected');
  });

  it('still resolves the lone session for the control plane (base token)', async () => {
    const session = createSession('tn5250');
    session.markAuthenticated('OPERATOR1');
    const { body } = await status({ Authorization: `Bearer ${BASE_TOKEN}` });
    expect(body.username).toBe('OPERATOR1');
    expect(body.capabilities).toContain('scoped-auth');
  });

  it("never hands another scope's lone session to a scoped caller", async () => {
    const session = createSession('tn5250', 'org-a');
    session.markAuthenticated('OPERATOR1');
    const { body } = await status({ Authorization: `Bearer ${mintScopedToken('org-b', BASE_TOKEN)}` });
    expect(body.ok).toBe(true);
    expect(body.sessions).toBe(0);
    expect(body).not.toHaveProperty('username');
  });

  it('refuses every other credential-less request', async () => {
    const res = await fetch(`${base}/sessions`);
    expect(res.status).toBe(401);
  });
});

describe('/sessions names each session\'s scope for the control plane', () => {
  it('lists the scope a session was created under', async () => {
    createSession('tn5250', 'org-a');
    createSession('tn5250');
    const res = await fetch(`${base}/sessions`, { headers: { Authorization: `Bearer ${BASE_TOKEN}` } });
    const body = (await res.json()) as { sessions: { scope: string | null }[] };
    expect(body.sessions.map((s) => s.scope).sort()).toEqual([null, 'org-a'].sort());
  });
});

describe('claimKeyedSession', () => {
  it("claims the control plane's (unscoped) session for the scoped caller, once", () => {
    const s = createSession('tn5250');
    expect(claimKeyedSession(s, 'org-a')).toBe(s);
    expect(s.scope).toBe('org-a');
    // Claimed once: another scope naming the same key gets nothing.
    expect(claimKeyedSession(s, 'org-b')).toBeUndefined();
    expect(s.scope).toBe('org-a');
  });

  it("never hands a session of another scope across, nor retags it", () => {
    const s = createSession('tn5250', 'org-a');
    expect(claimKeyedSession(s, 'org-b')).toBeUndefined();
    expect(s.scope).toBe('org-a');
  });

  it('leaves the all-access caller unrestricted and nothing retagged', () => {
    const s = createSession('tn5250', 'org-a');
    expect(claimKeyedSession(s, null)).toBe(s);
    expect(s.scope).toBe('org-a');
    expect(claimKeyedSession(undefined, 'org-a')).toBeUndefined();
  });
});
