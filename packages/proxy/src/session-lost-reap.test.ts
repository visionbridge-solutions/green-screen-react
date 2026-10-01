/**
 * A LOST session — its host connection gone for good, nothing recovering it —
 * is removed from the store once integrators have had LOST_REAP_MS to read its
 * final status. Nothing removed it before: its idle timer stops with the
 * connection, and the connect watchdog only covers a first connect. Two
 * sessions whose auto-reconnect gave up (ECONNREFUSED, five attempts) sat in a
 * production proxy for six days, still reading 'connecting'.
 *
 * Pinned here:
 *   - an exhausted auto-reconnect reads 'disconnected' with why it gave up, is
 *     reported lost once, stays readable for the grace, then is removed;
 *   - a drop with no auto-reconnect is removed the same way;
 *   - an error verdict survives the socket close that follows it, so the lost
 *     session's final status still says why;
 *   - a session that connects again within the grace is kept;
 *   - a reconnect in flight when the grace ends is left to the connect watchdog;
 *   - a session closed by the host while being signed off arms no reaper.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Session, createSession, getAllSessions, getSession, gracefullyDestroySession } from './session.js';
import { getSessionStore, sessionLifecycle } from './session-store.js';

const BACKOFF_TOTAL_MS = Session.RECONNECT_BACKOFF_MS.reduce((a, b) => a + b, 0);

function purge() {
  for (const s of Array.from(getAllSessions())) {
    s.destroy();
    getSessionStore().delete(s.id);
  }
}

/** A session connected to a stubbed host (no socket is ever opened). */
async function connected(opts: { autoReconnect?: boolean } = {}): Promise<Session> {
  const session = createSession('tn5250');
  vi.spyOn(session.handler, 'connect').mockResolvedValue(undefined);
  vi.spyOn(session.handler, 'disconnect').mockImplementation(() => {});
  await session.connect('ibmi.example', 23, { autoReconnect: opts.autoReconnect } as never);
  expect(session.status.connected).toBe(true);
  return session;
}

describe('a lost session is reaped after its grace', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => {
    purge();
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('an auto-reconnect that gives up says so, stays readable, then is removed', async () => {
    const session = await connected({ autoReconnect: true });
    vi.mocked(session.handler.connect).mockRejectedValue(new Error('connect ECONNREFUSED 172.18.0.15:42002'));
    const lost = vi.fn();
    sessionLifecycle.on('session.lost', lost);

    session.handler.emit('disconnected');
    await vi.advanceTimersByTimeAsync(BACKOFF_TOTAL_MS + 100);

    expect(session.status.status).toBe('disconnected');
    expect(session.status.error).toMatch(/gave up after 5 attempts: connect ECONNREFUSED/);
    expect(lost).toHaveBeenCalledTimes(1);
    expect(getSession(session.id)).toBe(session);

    await vi.advanceTimersByTimeAsync(Session.LOST_REAP_MS);
    expect(getSession(session.id)).toBeUndefined();
    sessionLifecycle.off('session.lost', lost);
  });

  it('a drop with no auto-reconnect is removed after the grace', async () => {
    const session = await connected();
    session.handler.emit('disconnected');
    await vi.advanceTimersByTimeAsync(Session.LOST_REAP_MS - 1000);
    expect(getSession(session.id)).toBe(session);
    await vi.advanceTimersByTimeAsync(1000);
    expect(getSession(session.id)).toBeUndefined();
  });

  it('the error that lost it survives the socket close that follows', async () => {
    const session = await connected();
    const refused = Object.assign(new Error('host refused device LBA512C0E7'), { fatal: true });
    session.handler.emit('error', refused);
    session.handler.emit('disconnected');
    expect(session.status.status).toBe('disconnected');
    expect(session.status.error).toBe('host refused device LBA512C0E7');
  });

  it('a session that connects again within the grace is kept', async () => {
    const session = await connected();
    session.handler.emit('disconnected');
    await vi.advanceTimersByTimeAsync(Session.LOST_REAP_MS / 2);
    await session.connect('ibmi.example', 23);
    await vi.advanceTimersByTimeAsync(Session.LOST_REAP_MS);
    expect(getSession(session.id)).toBe(session);
    expect(session.status.connected).toBe(true);
  });

  it('a reconnect still in flight when the grace ends is not cut', async () => {
    const session = await connected();
    session.handler.emit('disconnected');
    await vi.advanceTimersByTimeAsync(Session.LOST_REAP_MS - 1000);
    // The host takes its time: the connect watchdog owns this attempt now.
    vi.mocked(session.handler.connect).mockReturnValue(new Promise(() => {}));
    void session.connect('ibmi.example', 23);
    await vi.advanceTimersByTimeAsync(2000);
    expect(session.status.status).toBe('connecting');
    expect(getSession(session.id)).toBe(session);
  });

  it('a session the host closes while it is being signed off arms no reaper', async () => {
    const session = await connected();
    session.markAuthenticated('LEGACYBPRD');
    // SIGNOFF answered by the host closing the socket — the expected outcome,
    // inside gracefulDestroy's wait, before its destroyer removes the entry.
    session.handler.attemptGracefulExit = vi.fn(async () => {
      session.handler.emit('disconnected');
      return true;
    });
    await gracefullyDestroySession(session.id); // the /disconnect teardown
    expect(getSession(session.id)).toBeUndefined();
    expect(vi.getTimerCount()).toBe(0); // idle timer stopped, no reaper armed
  });
});
