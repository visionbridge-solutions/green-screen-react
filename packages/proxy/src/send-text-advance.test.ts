/**
 * `/send-text` and the `/batch` text op carry the caller's typing intent:
 * `advance: true` is keyboard typing (past a full field it moves on to the
 * next one); absent, the text is a field write that never leaves its field
 * and reports what it could not place. See tn5250/auto-advance.test.ts for
 * the emulator rules themselves.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import express from 'express';
import type { AddressInfo } from 'net';
import type { Server } from 'http';
import routes from './routes.js';
import { createSession, getAllSessions } from './session.js';
import { getSessionStore } from './session-store.js';
import type { TN5250Handler } from './protocols/tn5250-handler.js';
import type { FieldDef } from './tn5250/screen.js';

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
});

function field(row: number, col: number, length: number): FieldDef {
  return { row, col, length, ffw1: 0, ffw2: 0, fcw1: 0, fcw2: 0, attribute: 0x24, rawAttrByte: 0x24, modified: false };
}

function signOnSession() {
  const session = createSession('tn5250');
  const screen = (session.handler as TN5250Handler).screen;
  const user = field(5, 52, 10);
  const password = field(6, 52, 10);
  screen.fields.push(user, password);
  screen.cursorRow = 5;
  screen.cursorCol = 52;
  const value = (f: FieldDef) => screen.getFieldValue(f).trimEnd();
  return { session, user, password, value };
}

async function post(sessionId: string, path: string, body: unknown) {
  const res = await fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Session-Id': sessionId },
    body: JSON.stringify(body),
  });
  return res.json() as Promise<{ success: boolean }>;
}

describe('typing intent over REST', () => {
  it('/send-text with advance types on into the next field', async () => {
    const { session, user, password, value } = signOnSession();
    const res = await post(session.id, '/send-text', { text: 'LEGACYBPRDSECRET', advance: true });
    expect(res.success).toBe(true);
    expect(value(user)).toBe('LEGACYBPRD');
    expect(value(password)).toBe('SECRET');
  });

  it('/send-text without it refuses the overflow and keeps the field whole', async () => {
    const { session, user, password, value } = signOnSession();
    const res = await post(session.id, '/send-text', { text: 'LEGACYBPRDSECRET' });
    expect(res.success).toBe(false);
    expect(value(user)).toBe('LEGACYBPRD');
    expect(value(password)).toBe('');
  });

  it('the /batch text op carries the same intent', async () => {
    const { session, password, value } = signOnSession();
    const res = await post(session.id, '/batch', {
      operations: [{ type: 'text', value: 'LEGACYBPRDSECRET', advance: true }],
    });
    expect(res.success).toBe(true);
    expect(value(password)).toBe('SECRET');
  });
});
