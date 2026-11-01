/**
 * `/send-text` and the `/batch` text op take `animate` (default true). Off,
 * the value is still inserted one character at a time — the same per-character
 * validation, the same refusal at a non-writable position, the same field
 * bound — but with no inter-character pacing and ONE frame for the whole
 * string instead of one per keystroke. An automated driver typing a few
 * hundred characters a form paid ~15 ms and a broadcast per character for
 * frames no one watched; a person's interactive typing keeps its animation.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import type { AddressInfo } from 'net';
import type { Server } from 'http';
import routes from './routes.js';
import { createSession, getAllSessions } from './session.js';
import { getSessionStore } from './session-store.js';
import { broadcastScreenToSession } from './websocket.js';
import type { TN5250Handler } from './protocols/tn5250-handler.js';
import type { FieldDef } from './tn5250/screen.js';

vi.mock('./websocket.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./websocket.js')>();
  return { ...actual, broadcastScreenToSession: vi.fn() };
});
const broadcasts = vi.mocked(broadcastScreenToSession);

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
beforeEach(() => broadcasts.mockClear());
afterEach(() => {
  for (const s of Array.from(getAllSessions())) getSessionStore().delete(s.id);
});

function field(row: number, col: number, length: number): FieldDef {
  return { row, col, length, ffw1: 0, ffw2: 0, fcw1: 0, fcw2: 0, attribute: 0x24, rawAttrByte: 0x24, modified: false };
}

/** A form with a wide field (row 10) and the sign-on pair (rows 5/6). */
function formSession() {
  const session = createSession('tn5250');
  const screen = (session.handler as TN5250Handler).screen;
  const user = field(5, 52, 10);
  const password = field(6, 52, 10);
  const wide = field(10, 2, 70);
  screen.fields.push(user, password, wide);
  screen.cursorRow = 10;
  screen.cursorCol = 2;
  const value = (f: FieldDef) => screen.getFieldValue(f).trimEnd();
  const at = (row: number, col: number) => { screen.cursorRow = row; screen.cursorCol = col; };
  return { session, screen, user, password, wide, value, at };
}

async function post(sessionId: string, path: string, body: unknown) {
  const res = await fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Session-Id': sessionId },
    body: JSON.stringify(body),
  });
  return res.json() as Promise<{ success: boolean; error?: string; cursor_row: number; cursor_col: number }>;
}

/** Frames broadcast for ONE session since the last clear. */
const framesFor = (sessionId: string) => broadcasts.mock.calls.filter(([id]) => id === sessionId).length;

const SIXTY = 'THE QUICK BROWN FOX JUMPS OVER THE LAZY DOG AND KEEPS ON RUNNING';

describe('/send-text without animation', () => {
  it('leaves the same buffer and cursor as animated typing, in one burst with one frame', async () => {
    const animated = formSession();
    const t0 = Date.now();
    const a = await post(animated.session.id, '/send-text', { text: SIXTY });
    const animatedMs = Date.now() - t0;
    const animatedFrames = framesFor(animated.session.id);

    const plain = formSession();
    const t1 = Date.now();
    const b = await post(plain.session.id, '/send-text', { text: SIXTY, animate: false });
    const plainMs = Date.now() - t1;

    expect(a.success).toBe(true);
    expect(b.success).toBe(true);
    expect(plain.value(plain.wide)).toBe(SIXTY);
    expect(plain.value(plain.wide)).toBe(animated.value(animated.wide));
    expect([b.cursor_row, b.cursor_col]).toEqual([a.cursor_row, a.cursor_col]);

    // 60 keystrokes animated = 59 pauses of 15 ms, a frame per character and
    // the final frame; unanimated there is no pause and only the final frame.
    expect(animatedFrames).toBe(SIXTY.length + 1);
    expect(framesFor(plain.session.id)).toBe(1);
    expect(animatedMs).toBeGreaterThanOrEqual(59 * 15 - 20);
    expect(plainMs).toBeLessThan(300);
  });

  it('still refuses a non-writable position, and shows what was typed before it', async () => {
    const plain = formSession();
    plain.at(1, 0); // no field here
    const res = await post(plain.session.id, '/send-text', { text: 'NOPE', animate: false });
    expect(res.success).toBe(false);
    expect(res.error).toBe('Cannot type at current cursor position');
    expect(plain.value(plain.wide)).toBe('');
    expect(plain.value(plain.user)).toBe('');
    // The frame after a refusal is still broadcast: viewers see the buffer as it is.
    expect(framesFor(plain.session.id)).toBe(1);
  });

  it('still never spills past a full field (advance off)', async () => {
    const plain = formSession();
    plain.at(5, 52);
    const res = await post(plain.session.id, '/send-text', { text: 'LEGACYBPRDSECRET', animate: false });
    expect(res.success).toBe(false);
    expect(plain.value(plain.user)).toBe('LEGACYBPRD');
    expect(plain.value(plain.password)).toBe('');
  });

  it('types on into the next field with advance, unanimated too', async () => {
    const plain = formSession();
    plain.at(5, 52);
    const res = await post(plain.session.id, '/send-text', { text: 'LEGACYBPRDSECRET', advance: true, animate: false });
    expect(res.success).toBe(true);
    expect(plain.value(plain.user)).toBe('LEGACYBPRD');
    expect(plain.value(plain.password)).toBe('SECRET');
  });

  it('animates by default and on anything but an explicit false', async () => {
    const byDefault = formSession();
    await post(byDefault.session.id, '/send-text', { text: 'ABC' });
    expect(framesFor(byDefault.session.id)).toBe(4); // one per keystroke + the final frame

    const explicit = formSession();
    await post(explicit.session.id, '/send-text', { text: 'ABC', animate: true });
    expect(framesFor(explicit.session.id)).toBe(4);
  });
});

describe('/batch text ops without animation', () => {
  it('honours a request-level animate: false for every text op', async () => {
    const plain = formSession();
    const res = await post(plain.session.id, '/batch', {
      animate: false,
      operations: [
        { type: 'setCursor', row: 5, col: 52 },
        { type: 'text', value: 'LEGACYBPRD' },
        { type: 'setCursor', row: 6, col: 52 },
        { type: 'text', value: 'SECRET' },
      ],
    });
    expect(res.success).toBe(true);
    expect(plain.value(plain.user)).toBe('LEGACYBPRD');
    expect(plain.value(plain.password)).toBe('SECRET');
    // The batch's one final frame; no per-keystroke frames.
    expect(framesFor(plain.session.id)).toBe(1);
  });

  it('a text op has its own animate, outranking the request; the default is animated', async () => {
    const mixed = formSession();
    await post(mixed.session.id, '/batch', {
      animate: false,
      operations: [
        { type: 'setCursor', row: 5, col: 52 },
        { type: 'text', value: 'ABCD', animate: true },
        { type: 'setCursor', row: 6, col: 52 },
        { type: 'text', value: 'XYZ' },
      ],
    });
    expect(mixed.value(mixed.user)).toBe('ABCD');
    expect(mixed.value(mixed.password)).toBe('XYZ');
    expect(framesFor(mixed.session.id)).toBe(4 + 1); // ABCD animated, XYZ not, the final frame

    const byDefault = formSession();
    await post(byDefault.session.id, '/batch', {
      operations: [{ type: 'text', value: 'ABCD' }],
    });
    expect(framesFor(byDefault.session.id)).toBe(4 + 1);
  });

  it('refuses an unwritable text op the same way and shows the buffer as it is', async () => {
    const plain = formSession();
    const res = await post(plain.session.id, '/batch', {
      animate: false,
      operations: [
        { type: 'setCursor', row: 1, col: 0 },
        { type: 'text', value: 'NOPE' },
      ],
    });
    expect(res.success).toBe(false);
    expect(res.error).toBe('Cannot type "NOPE" at current cursor position');
    expect(framesFor(plain.session.id)).toBe(1);
  });
});
