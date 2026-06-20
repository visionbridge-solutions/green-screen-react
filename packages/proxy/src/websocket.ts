import { WebSocketServer, WebSocket } from 'ws';
import { IncomingMessage, Server as HttpServer } from 'http';
import { URL } from 'url';
import {
  getSession,
  getDefaultSession,
  destroySession,
  gracefullyDestroySession,
} from './session.js';
import { sessionLifecycle, getSessionStore } from './session-store.js';
import { SessionController } from './controller.js';
import type { ProtocolType } from './protocols/index.js';
import type { ConnectionStatus } from 'green-screen-types';

interface WsClient {
  ws: WebSocket;
  sessionId: string | null;
  controller: SessionController | null;
}

const clients: Set<WsClient> = new Set();
const sessionClients: Map<string, Set<WsClient>> = new Map();
const unassignedClients: Set<WsClient> = new Set();
/** Controllers whose WebSocket disconnected but TCP is still alive (for reattach) */
const orphanedControllers: Map<string, SessionController> = new Map();
/** Auto-reap timers for orphaned controllers. A page reload (or a backend
 *  integrator that briefly loses its WS subscription mid-operation) reattaches
 *  to the SAME live controller — the TCP to the host stays up the whole time, so
 *  the in-flight screen/job is preserved seamlessly. Anything longer than the
 *  window is treated as a closed tab / abandoned session. Keeping the socket
 *  alive counts against the host's per-user session quota (IBM i LMTDEVSSN →
 *  CPF1220), so the window is bounded — but it MUST comfortably exceed a single
 *  host round-trip (a 5250 lookup + two-phase ENTER can leave a backend driver
 *  briefly without a WS for longer than a couple of seconds). 20s was too tight:
 *  a transient blip mid-data-entry reaped the session before the backend could
 *  resume, abandoning the in-progress record. 90s leaves ample reattach room
 *  while the 30-min idle timer still releases genuinely-abandoned sessions. */
const orphanReapTimers: Map<string, ReturnType<typeof setTimeout>> = new Map();
const ORPHAN_TTL_MS = 90_000;

function scheduleOrphanReap(sessionId: string): void {
  const prev = orphanReapTimers.get(sessionId);
  if (prev) clearTimeout(prev);
  const timer = setTimeout(() => {
    orphanReapTimers.delete(sessionId);
    const ctrl = orphanedControllers.get(sessionId);
    if (!ctrl) return;
    orphanedControllers.delete(sessionId);
    console.log(`[orphan-reap] TTL expired for session ${sessionId.slice(0, 8)} — closing (re-attachable)`);
    // Bare TCP close, NOT a graceful SIGNOFF. An orphan-reap means a client
    // dropped its WS and didn't resume in time — but we can't tell a closed
    // browser tab from a backend driver mid-record whose resume is still
    // racing. SIGNOFF here ENDS the host job, so a late resume lands on a
    // fresh Sign On and the in-progress record is lost (the bug this restores).
    // A bare close leaves the IBM i job DISCONNECTED — re-attachable — and the
    // 30-min idle timer (Session._idleTimer) still SIGNOFFs a genuinely
    // abandoned session, so device slots aren't leaked indefinitely.
    ctrl.handleDisconnect();
  }, ORPHAN_TTL_MS);
  orphanReapTimers.set(sessionId, timer);
}

function cancelOrphanReap(sessionId: string): void {
  const t = orphanReapTimers.get(sessionId);
  if (t) { clearTimeout(t); orphanReapTimers.delete(sessionId); }
}

/**
 * Cancel a pending orphan reap when an HTTP REST request touches the
 * session. The orphan reaper assumes "WS gone for 20s = closed tab",
 * which is correct for browser-driven sessions but wrong for backend
 * integrators that drive the session over REST and merely lost their
 * WS subscription momentarily (api restart, reload, network blip).
 * Real activity through any REST endpoint proves the client is still
 * here — keep the session alive.
 */
export function cancelOrphanReapOnRestActivity(sessionId: string): void {
  if (orphanedControllers.has(sessionId)) {
    cancelOrphanReap(sessionId);
    // Move the controller out of the orphaned bucket — the REST-only
    // client has effectively re-claimed it. We don't have a WS to
    // bind it to, but the controller can stay alive as long as the
    // 5-min idle-timeout (Session._idleTimer) keeps not firing.
    orphanedControllers.delete(sessionId);
  }
}

function indexClient(client: WsClient): void {
  if (client.sessionId) {
    let set = sessionClients.get(client.sessionId);
    if (!set) { set = new Set(); sessionClients.set(client.sessionId, set); }
    set.add(client);
    unassignedClients.delete(client);
  } else {
    unassignedClients.add(client);
  }
}

function removeClient(client: WsClient): void {
  clients.delete(client);
  unassignedClients.delete(client);
  if (client.sessionId) {
    // Orphan-and-reap ONLY a WS-OWNED controller (one that created its own
    // handler via the `connect` path). An ADOPTED controller merely
    // observes/drives a REST-created Session whose handler the session store
    // owns and whose lifecycle is governed independently (idle backstop +
    // explicit /disconnect). Reaping it on WS absence would bare-close that
    // shared handler and kill a durable, client-independent connection out
    // from under its owner — exactly the WS-presence coupling we must NOT have.
    // So for an adopted controller we simply drop the WS binding and leave the
    // Session alone; a later reattach re-adopts the still-live Session.
    if (client.controller && client.controller.connected && !client.controller.adopted) {
      orphanedControllers.set(client.sessionId, client.controller);
      scheduleOrphanReap(client.sessionId);
    }
    const set = sessionClients.get(client.sessionId);
    if (set) {
      set.delete(client);
      if (set.size === 0) sessionClients.delete(client.sessionId);
    }
  }
}

// Subscribe to session lifecycle events so clients still watching a lost
// session receive a structured `session.lost` notification (e.g. host TCP
// dropped, idle timeout). Clients can then call `reattach` against a new
// session or surface a "session expired" UI without string-matching errors.
let lifecycleSubscribed = false;
function ensureLifecycleSubscribed(): void {
  if (lifecycleSubscribed) return;
  lifecycleSubscribed = true;
  sessionLifecycle.on('session.lost', (sessionId: string, status: ConnectionStatus) => {
    const message = JSON.stringify({ type: 'session.lost', sessionId, status });
    const targets = sessionClients.get(sessionId);
    if (targets) {
      for (const client of targets) {
        if (client.ws.readyState === WebSocket.OPEN) client.ws.send(message);
      }
    }
  });
  sessionLifecycle.on('session.resumed', (sessionId: string) => {
    const message = JSON.stringify({ type: 'session.resumed', sessionId });
    const targets = sessionClients.get(sessionId);
    if (targets) {
      for (const client of targets) {
        if (client.ws.readyState === WebSocket.OPEN) client.ws.send(message);
      }
    }
  });
  // Proxy-driven auto-reconnect re-established the TCP after an unexpected host
  // drop. Notify watchers so a driving integrator (e.g. LegacyBridge) re-runs
  // ONLY its sign-on cascade (the proxy holds no credentials), and observers can
  // clear any "reconnecting" UI. ``needsSignOn`` is currently always true.
  sessionLifecycle.on('session.reconnected', (sessionId: string, info: { needsSignOn?: boolean }) => {
    const message = JSON.stringify({ type: 'session.reconnected', sessionId, needsSignOn: info?.needsSignOn !== false });
    const targets = sessionClients.get(sessionId);
    if (targets) {
      for (const client of targets) {
        if (client.ws.readyState === WebSocket.OPEN) client.ws.send(message);
      }
    }
  });
}

export function setupWebSocket(server: HttpServer): WebSocketServer {
  ensureLifecycleSubscribed();
  const wss = new WebSocketServer({ server, path: '/ws' });

  wss.on('connection', (ws: WebSocket, req: IncomingMessage) => {
    const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
    const sessionId = url.searchParams.get('sessionId');

    const client: WsClient = { ws, sessionId, controller: null };
    clients.add(client);
    indexClient(client);

    ws.on('close', () => removeClient(client));
    ws.on('error', () => removeClient(client));

    ws.on('message', async (raw: Buffer | string) => {
      try {
        const msg = JSON.parse(typeof raw === 'string' ? raw : raw.toString());
        await handleWsCommand(ws, client, msg);
      } catch (err) {
        wsSend(ws, { type: 'error', message: err instanceof Error ? err.message : String(err) });
      }
    });

    // Send current screen immediately if a session is available
    const session = sessionId ? getSession(sessionId) : getDefaultSession();
    if (session && session.status.connected) {
      wsSend(ws, { type: 'screen', data: session.getScreenData() });
      wsSend(ws, { type: 'status', data: session.status });
    }
  });

  return wss;
}

/** Server-side single-writer guard. Returns true (and sends an error) when this
 *  WS client must NOT drive input because the session is locked to an exclusive
 *  driver (e.g. an automated agent run holds it). WS clients are observers while
 *  a driveHolder is set; the REST drive path (the lock owner itself) is exempt.
 *  Unlocked sessions (driveHolder null) let interactive clients drive freely. */
function driveBlocked(ws: WebSocket, client: WsClient): boolean {
  const session = client.sessionId ? getSession(client.sessionId) : undefined;
  if (session && session.driveHolder) {
    wsSend(ws, { type: 'error', message: `observe-only: session is driven by ${session.driveHolder}` });
    return true;
  }
  return false;
}

async function handleWsCommand(ws: WebSocket, client: WsClient, msg: any): Promise<void> {
  switch (msg.type) {
    case 'connect': {
      const { host = 'pub400.com', port = 23, protocol = 'tn5250', username, password, terminalType, codePage } = msg;

      // Destroy previous session if this client had one
      const oldSessionId = client.sessionId;
      if (oldSessionId) {
        destroySession(oldSessionId);
        const orphan = orphanedControllers.get(oldSessionId);
        if (orphan) { orphan.handleDisconnect(); orphanedControllers.delete(oldSessionId); cancelOrphanReap(oldSessionId); }
        if (client.controller) { client.controller.handleDisconnect(); }
        const set = sessionClients.get(oldSessionId);
        if (set) { set.delete(client); if (set.size === 0) sessionClients.delete(oldSessionId); }
      }

      const controller = new SessionController((m) => {
        wsSend(ws, m);
        // Also broadcast screen/status to other clients watching this session
        if (client.sessionId && ('type' in m) && (m as any).type === 'screen') {
          broadcastToSession(client.sessionId, JSON.stringify(m), ws);
        }
      });
      client.controller = controller;

      // Generate a session ID and track it
      const sessionId = crypto.randomUUID();
      client.sessionId = sessionId;
      unassignedClients.delete(client);
      indexClient(client);

      try {
        await controller.handleConnect({
          host,
          port,
          protocol: protocol as ProtocolType,
          username,
          password,
          sessionId,
          terminalType,
          codePage,
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        wsSend(ws, { type: 'error', message });
        wsSend(ws, { type: 'status', data: { connected: false, status: 'error', protocol, host, error: message } });
      }
      break;
    }

    case 'text': {
      const controller = client.controller;
      if (!controller) { wsSend(ws, { type: 'error', message: 'Not connected' }); return; }
      if (driveBlocked(ws, client)) return;
      controller.handleText(msg.text);
      break;
    }

    case 'key': {
      const controller = client.controller;
      if (!controller) { wsSend(ws, { type: 'error', message: 'Not connected' }); return; }
      if (driveBlocked(ws, client)) return;
      await controller.handleKey(msg.key);
      break;
    }

    case 'setCursor': {
      const controller = client.controller;
      if (!controller) { wsSend(ws, { type: 'error', message: 'Not connected' }); return; }
      if (driveBlocked(ws, client)) return;
      controller.handleSetCursor(msg.row, msg.col);
      break;
    }

    case 'eraseEOF': {
      const controller = client.controller;
      if (!controller) { wsSend(ws, { type: 'error', message: 'Not connected' }); return; }
      if (driveBlocked(ws, client)) return;
      controller.handleEraseEOF();
      break;
    }

    case 'reattach': {
      const { sessionId } = msg;
      // Reattach is local-proxy-specific (session persistence across page reloads).
      // Find the existing controller by scanning all clients with this session ID.
      let existingController: SessionController | null = null;
      if (sessionId) {
        // Check orphaned controllers first (from page reloads)
        const orphan = orphanedControllers.get(sessionId);
        if (orphan && orphan.connected) {
          existingController = orphan;
          orphanedControllers.delete(sessionId); cancelOrphanReap(sessionId);
        }
        // Also check active clients
        if (!existingController) {
          const targets = sessionClients.get(sessionId);
          if (targets) {
            for (const c of targets) {
              if (c.controller && c.controller.connected) {
                existingController = c.controller;
                break;
              }
            }
          }
        }
      }

      if (existingController) {
        // Reuse the existing controller — just re-bind this WebSocket to it
        const oldSessionId = client.sessionId;
        client.sessionId = sessionId;
        client.controller = existingController;
        if (oldSessionId && oldSessionId !== sessionId) {
          const set = sessionClients.get(oldSessionId);
          if (set) { set.delete(client); if (set.size === 0) sessionClients.delete(oldSessionId); }
          // Destroy the stale session this client was previously bound to
          // — otherwise it would linger until idle timeout and count
          // against host session quotas (CPF1220).
          destroySession(oldSessionId);
          orphanedControllers.delete(oldSessionId); cancelOrphanReap(oldSessionId);
        }
        unassignedClients.delete(client);
        indexClient(client);
        const screen = existingController.getScreenData();
        if (screen) wsSend(ws, { type: 'screen', data: screen });
        wsSend(ws, { type: 'status', data: { connected: true, status: 'connected' } });
        wsSend(ws, { type: 'connected', sessionId });
        sessionLifecycle.emit('session.resumed', sessionId);
      } else {
        // Also try the session manager (REST sessions)
        const session = sessionId ? getSession(sessionId) : undefined;
        if (session && session.status.connected) {
          const oldSessionId = client.sessionId;
          client.sessionId = session.id;
          if (oldSessionId && oldSessionId !== session.id) {
            const set = sessionClients.get(oldSessionId);
            if (set) { set.delete(client); if (set.size === 0) sessionClients.delete(oldSessionId); }
            // Same leak fix as the orphaned-controller path above.
            destroySession(oldSessionId);
            orphanedControllers.delete(oldSessionId); cancelOrphanReap(oldSessionId);
          }
          unassignedClients.delete(client);
          indexClient(client);
          // Adopt the REST session's handler into a SessionController so
          // subsequent WS key/text/setCursor commands from this client have
          // a controller to dispatch through. Without this, the `case 'key'`
          // branch would see `client.controller == null` and reply with
          // "Not connected", silently dropping every keystroke from
          // interactive clients that reattach to REST-created sessions.
          const adoptedController = new SessionController((m) => {
            wsSend(ws, m);
            // Mirror the `connect` path: broadcast screen updates to other
            // clients watching the same session so dashboards stay in sync.
            if (client.sessionId && ('type' in m) && (m as any).type === 'screen') {
              broadcastToSession(client.sessionId, JSON.stringify(m), ws);
            }
          });
          adoptedController.adoptHandler(session.handler);
          client.controller = adoptedController;
          wsSend(ws, { type: 'screen', data: session.getScreenData() });
          wsSend(ws, { type: 'status', data: session.status });
          wsSend(ws, { type: 'connected', sessionId: session.id });
          sessionLifecycle.emit('session.resumed', session.id);
        } else {
          wsSend(ws, { type: 'error', message: 'Session not found or disconnected' });
        }
      }
      break;
    }

    case 'readMdt': {
      const controller = client.controller;
      if (!controller) { wsSend(ws, { type: 'error', message: 'Not connected' }); return; }
      const modifiedOnly = msg.modifiedOnly !== false;
      controller.handleReadMdt(modifiedOnly);
      break;
    }

    case 'markAuthenticated': {
      // Look up the session via the session store (the controller path
      // doesn't hold a Session reference, so we resolve by id here).
      if (!client.sessionId) { wsSend(ws, { type: 'error', message: 'No active session' }); return; }
      const username = typeof msg.username === 'string' ? msg.username : '';
      if (!username) { wsSend(ws, { type: 'error', message: 'username is required' }); return; }
      const session = getSession(client.sessionId);
      if (!session) { wsSend(ws, { type: 'error', message: 'Session not found' }); return; }
      session.markAuthenticated(username);
      wsSend(ws, { type: 'status', data: session.status });
      break;
    }

    case 'waitForFields': {
      if (!client.sessionId) { wsSend(ws, { type: 'error', message: 'No active session' }); return; }
      const session = getSession(client.sessionId);
      if (!session) { wsSend(ws, { type: 'error', message: 'Session not found' }); return; }
      const minFields = typeof msg.minFields === 'number' ? msg.minFields : 0;
      const timeoutMs = typeof msg.timeoutMs === 'number' ? msg.timeoutMs : 5000;
      const screen = await session.waitForScreenWithFields(minFields, timeoutMs);
      const inputCount = (screen.fields || []).filter((f) => f.is_input).length;
      wsSend(ws, { type: 'waitForFields', data: { matched: inputCount >= minFields, inputFieldCount: inputCount, screen } });
      break;
    }

    case 'ping':
      // Liveness keepalive — reply so the client's dead-socket watchdog
      // resets. No state change on the server.
      wsSend(ws, { type: 'pong' });
      break;

    case 'disconnect': {
      const sessionId = client.sessionId;
      const controller = client.controller;
      // Clear client-side tracking immediately so no new screen events
      // get broadcast to this client while SIGNOFF is in flight.
      client.controller = null;
      if (sessionId) {
        const set = sessionClients.get(sessionId);
        if (set) { set.delete(client); if (set.size === 0) sessionClients.delete(sessionId); }
        // Drop any orphaned controller for this session so it can't be
        // resurrected by a later reattach against an about-to-die session.
        orphanedControllers.delete(sessionId); cancelOrphanReap(sessionId);
        client.sessionId = null;
        unassignedClients.add(client);
      }
      // Graceful teardown covers both WS-created sessions (tracked by
      // SessionController only) and REST-adopted sessions (in the session
      // store). We run both paths — each is a no-op for the other's
      // session type.
      try {
        if (controller) await controller.handleGracefulDisconnect();
        if (sessionId) await gracefullyDestroySession(sessionId);
      } catch (err) {
        console.warn(`[ws] graceful disconnect failed for ${sessionId?.slice(0, 8)}:`, err);
      }
      // Ack so the client can close its WebSocket without racing the
      // server-side teardown. Clients that wait for this message guarantee
      // the SIGNOFF has been sent (or best-effort attempted) before TCP
      // closes.
      wsSend(ws, { type: 'disconnected' });
      break;
    }
  }
}

function wsSend(ws: WebSocket, data: object): void {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(data));
  }
}

function broadcastToSession(sessionId: string, message: string, exclude?: WebSocket): void {
  const targets = sessionClients.get(sessionId);
  if (targets) {
    for (const client of targets) {
      if (client.ws !== exclude && client.ws.readyState === WebSocket.OPEN) {
        client.ws.send(message);
      }
    }
  }
  for (const client of unassignedClients) {
    if (client.ws !== exclude && client.ws.readyState === WebSocket.OPEN) {
      client.ws.send(message);
    }
  }
}

/** Broadcast a screen update to all WebSocket clients watching a session.
 *  Called from HTTP routes (e.g. /send-key) so dashboard clients stay in sync. */
export function broadcastScreenToSession(sessionId: string, screenData: object): void {
  const message = JSON.stringify({ type: 'screen', data: screenData });
  broadcastToSession(sessionId, message);
}

/**
 * Destroy a WS-tracked session by id. Used by the REST beacon endpoint so
 * that `navigator.sendBeacon` on page unload can reliably tear down
 * WS-created sessions — those are NOT in the REST session store, so
 * destroySession() alone is a no-op for them.
 *
 * Covers orphaned controllers (from prior page reloads) and live
 * controllers still bound to an open WebSocket. Does NOT touch adopted
 * REST sessions — the caller should also invoke destroySession() for
 * those.
 */
export async function destroyWsSession(sessionId: string): Promise<boolean> {
  let found = false;
  const orphan = orphanedControllers.get(sessionId);
  if (orphan) {
    found = true;
    orphanedControllers.delete(sessionId); cancelOrphanReap(sessionId);
    try { await orphan.handleGracefulDisconnect(); } catch { /* ignore */ }
  }
  const targets = sessionClients.get(sessionId);
  if (targets) {
    for (const client of targets) {
      const ctrl = client.controller;
      if (!ctrl) continue;
      found = true;
      client.controller = null;
      try { await ctrl.handleGracefulDisconnect(); } catch { /* ignore */ }
    }
    sessionClients.delete(sessionId);
  }
  return found;
}

/**
 * Disconnect every SessionController held by this module so their TCP
 * sockets send a clean FIN to the upstream host before the process exits.
 *
 * The HTTP `createProxy().close()` path calls this during graceful
 * shutdown. Without it, TCP connections to legacy hosts are torn down
 * abruptly on process exit, which on IBM i leaves virtual telnet device
 * descriptions stuck in `VARY ON PENDING` until a host-side timer
 * reclaims them — blocking subsequent sign-ons from device-restricted
 * user profiles.
 *
 * Covers both live controllers bound to an active WS client and
 * orphaned controllers whose WS dropped but whose TCP is still alive
 * (kept for potential reattach). Adopted controllers (WS reattaches to
 * a REST-owned Session) are intentionally left alone — the REST
 * Session owns the handler lifecycle and is drained separately by
 * iterating the session store.
 */
export async function shutdownAllWsControllers(): Promise<void> {
  // Gracefully disconnect orphaned controllers (SIGNOFF + TCP close)
  const orphanDrains: Promise<void>[] = [];
  for (const [sessionId, orphan] of orphanedControllers) {
    orphanDrains.push(
      orphan.handleGracefulDisconnect().catch(() => { /* ignore */ })
    );
    orphanedControllers.delete(sessionId); cancelOrphanReap(sessionId);
  }

  // Gracefully disconnect live WS controllers
  const liveDrains: Promise<void>[] = [];
  for (const client of clients) {
    const ctrl = client.controller;
    if (!ctrl) continue;
    // Skip adopted controllers — they wrap a REST Session's handler,
    // which the session store drain will disconnect. Adopted
    // controllers have `connected=true` but no owned handler lifecycle.
    // We detect them by checking whether the handler is owned by a
    // Session in the store (same instance).
    const ownedByRestSession = client.sessionId
      ? getSessionStore().get(client.sessionId)?.handler === (ctrl as any).handler
      : false;
    if (ownedByRestSession) continue;
    liveDrains.push(
      ctrl.handleGracefulDisconnect().catch(() => { /* ignore */ })
    );
    client.controller = null;
  }

  await Promise.allSettled([...orphanDrains, ...liveDrains]);
}
