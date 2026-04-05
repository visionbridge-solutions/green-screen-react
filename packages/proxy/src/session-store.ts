import { EventEmitter } from 'events';
import type { Session } from './session.js';
import type { ConnectionStatus } from 'green-screen-types';

/**
 * Pluggable session store. The proxy keeps live Session instances (each
 * holding a TCP connection + parser state) keyed by session id. By default
 * sessions live in an in-memory Map, which works for single-process
 * deployments. For multi-process or HA deployments, integrators can plug a
 * custom store (e.g. Redis-backed process routing) by calling
 * {@link setSessionStore} before the HTTP/WS server starts accepting
 * traffic.
 *
 * IMPORTANT: Live Session objects can not themselves be serialised across
 * processes — they own TCP sockets and parser state. A Redis-backed store
 * therefore works at the *routing* layer: it records which process owns a
 * given session id, and remote processes forward requests to the owning
 * process (out of scope for this interface — store authors handle it).
 * For typical single-process deployments, use the default in-memory store.
 */
export interface SessionStore {
  /** Insert a session (fresh or just-reattached). */
  set(id: string, session: Session): void;
  /** Look up a session by id; returns undefined when not present or expired. */
  get(id: string): Session | undefined;
  /** Remove a session from the store (does NOT call `destroy()`). */
  delete(id: string): void;
  /** Fast existence check. */
  has(id: string): boolean;
  /** Iterate over all currently-stored sessions. */
  values(): IterableIterator<Session>;
  /** Total number of stored sessions. */
  size(): number;
}

/** Default in-memory session store — process-local Map. */
export class InMemorySessionStore implements SessionStore {
  private readonly map = new Map<string, Session>();

  set(id: string, session: Session): void {
    this.map.set(id, session);
  }
  get(id: string): Session | undefined {
    return this.map.get(id);
  }
  delete(id: string): void {
    this.map.delete(id);
  }
  has(id: string): boolean {
    return this.map.has(id);
  }
  values(): IterableIterator<Session> {
    return this.map.values();
  }
  size(): number {
    return this.map.size;
  }
}

let activeStore: SessionStore = new InMemorySessionStore();

/**
 * Replace the active session store. Call this once at startup, before the
 * HTTP/WS server accepts connections. Switching stores mid-flight will
 * orphan any sessions already held in the previous store.
 */
export function setSessionStore(store: SessionStore): void {
  activeStore = store;
}

/** Get the active session store (for internal proxy code + tests). */
export function getSessionStore(): SessionStore {
  return activeStore;
}

/**
 * Global lifecycle event bus. Emits:
 *   - 'session.lost'     (sessionId: string, status: ConnectionStatus)
 *   - 'session.resumed'  (sessionId: string, clientWs?: unknown)
 *
 * Use this from layers that need to observe session lifecycle without
 * importing the websocket module directly (avoids circular imports).
 */
export type SessionLifecycleEvents = {
  'session.lost': (sessionId: string, status: ConnectionStatus) => void;
  'session.resumed': (sessionId: string) => void;
};

class SessionLifecycleEmitter extends EventEmitter {}
export const sessionLifecycle = new SessionLifecycleEmitter();
