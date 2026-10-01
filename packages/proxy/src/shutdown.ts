/**
 * The proxy's own shutdown, as integrators see it.
 *
 * A shutdown drains every session it holds (SIGNOFF + FIN — see
 * gracefullyDestroySession), and those sessions are gone for good: the next
 * process starts empty. It used to say nothing of the kind. A watcher heard no
 * `session.lost`, only — if it was attached over the WebSocket — a bare
 * `status: disconnected` from the controller wrapping the session, which on a
 * session that auto-reconnects reads as "the proxy is recovering this". An
 * integrator that defers to the proxy's recovery (LegacyBridge, for up to 90 s)
 * then waited out recovery that was never coming, and its agents stayed off
 * the host for a minute and a half after every proxy roll.
 *
 * So, while it drains, the proxy:
 *   - refuses to start anything new (`/connect` and WS `connect`/`reattach`
 *     answer "shutting down", `/status` answers 503) — a session opened now
 *     would be cut by the exit with no SIGNOFF, and a client polling for "is a
 *     proxy back?" must not mistake the one that is leaving for it;
 *   - announces each drained session `session.lost`, with status
 *     `disconnected` and the error SHUTTING_DOWN, once it is gone.
 */
import type { ConnectionStatus } from 'green-screen-types';
import { gracefullyDestroySession } from './session.js';
import { getSessionStore, sessionLifecycle } from './session-store.js';

export const SHUTTING_DOWN = 'proxy shutting down';

let shuttingDown = false;

/** True from the moment a shutdown drain begins. */
export function isShuttingDown(): boolean {
  return shuttingDown;
}

/**
 * Drain everything for process exit: every stored session gracefully (in
 * parallel, so ~1.5 s whatever their number), each announced lost once it is
 * gone, then the WS-owned controllers (passed in — websocket.ts owns them).
 */
export async function drainForShutdown(shutdownWsControllers: () => Promise<void>): Promise<void> {
  shuttingDown = true;
  const sessions = Array.from(getSessionStore().values());
  await Promise.allSettled(sessions.map(async (session) => {
    const last = session.status;
    await gracefullyDestroySession(session.id).catch(() => { /* best-effort */ });
    const lost: ConnectionStatus = {
      connected: false,
      status: 'disconnected',
      protocol: last.protocol,
      host: last.host,
      error: SHUTTING_DOWN,
    };
    sessionLifecycle.emit('session.lost', session.id, lost);
  }));
  await shutdownWsControllers();
}

/** Test seam: a fresh process is not shutting down. */
export function resetShutdownStateForTests(): void {
  shuttingDown = false;
}
