import { sessionLifecycle } from './session-store.js';

/**
 * Idempotent connect-by-key registry.
 *
 * An integrator that drives one logical terminal (e.g. an automation bound to
 * a specific host user / device) passes a stable opaque `key` on /connect. The
 * proxy then guarantees AT MOST ONE live session per key:
 *
 *   - all keyed connects for the same key are SERIALISED by a per-key mutex,
 *     so a concurrent burst can't race to open N sockets — the first opens the
 *     session, the rest observe it live and reuse it;
 *   - a connect for a key that already has a live session returns that session
 *     instead of opening another.
 *
 * This makes the classic "N concurrent reconnects → N host devices → device
 * session-limit (LMTDEVSSN/CPF1220) contention" storm structurally impossible
 * rather than merely policy-discouraged in the integrator. The key is opaque —
 * the proxy never interprets it — so this stays protocol-generic.
 *
 * State is process-local (mirrors the default in-memory SessionStore). A
 * multi-process deployment that swaps in a routing store would key the registry
 * the same way at the routing layer.
 */

/** key → the sessionId of its current live session. Only holds sessions
 *  believed connected; cleared on `session.lost` so a dead key reconnects
 *  fresh instead of handing back a corpse. */
const keyToSessionId = new Map<string, string>();

/** key → tail of its serialised operation chain (the per-key mutex). */
const keyLocks = new Map<string, Promise<void>>();

/** The session id currently bound to `key`, or undefined. */
export function getKeyedSessionId(key: string): string | undefined {
  return keyToSessionId.get(key);
}

/** Bind a key to its live session id (called once a keyed connect succeeds). */
export function bindKey(key: string, sessionId: string): void {
  keyToSessionId.set(key, sessionId);
}

/**
 * Run `fn` under the per-key mutex: keyed connects for the same key execute
 * one-at-a-time, in arrival order. The first caller opens the session; while it
 * runs, the rest wait, then observe the now-live session and reuse it. This is
 * the single-flight guarantee that defeats the reconnect storm without the
 * intent-coalescing hazards of sharing one promise across callers (a no-creds
 * connect and a with-creds login want different end states).
 */
export async function withKeyLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const prev = keyLocks.get(key) ?? Promise.resolve();
  let release!: () => void;
  const mine = new Promise<void>((r) => { release = r; });
  // Our segment of the chain resolves only after the previous holder released
  // (prev) AND we release (mine). The next caller awaits this as its `prev`.
  const tail = prev.then(() => mine);
  keyLocks.set(key, tail);
  await prev; // wait our turn
  try {
    return await fn();
  } finally {
    release();
    // Drop the entry iff no later caller chained on (they'd have replaced the
    // tail), so idle keys don't accumulate.
    if (keyLocks.get(key) === tail) keyLocks.delete(key);
  }
}

/** Drop any key bindings pointing at a session (called when it dies). */
export function unbindSession(sessionId: string): void {
  for (const [k, sid] of keyToSessionId) {
    if (sid === sessionId) keyToSessionId.delete(k);
  }
}

// A lost session must not stay reachable by key — otherwise the next
// connect-by-key would hand back the dead session id forever. Clearing it
// here means the next connect for that key opens a fresh session.
sessionLifecycle.on('session.lost', (sessionId: string) => unbindSession(sessionId));
