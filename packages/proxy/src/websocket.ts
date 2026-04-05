import { WebSocketServer, WebSocket } from 'ws';
import { IncomingMessage, Server as HttpServer } from 'http';
import { URL } from 'url';
import {
  getSession,
  getDefaultSession,
  destroySession,
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
    // If this client has a live controller, orphan it for potential reattach
    if (client.controller && client.controller.connected) {
      orphanedControllers.set(client.sessionId, client.controller);
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

async function handleWsCommand(ws: WebSocket, client: WsClient, msg: any): Promise<void> {
  switch (msg.type) {
    case 'connect': {
      const { host = 'pub400.com', port = 23, protocol = 'tn5250', username, password, terminalType, codePage } = msg;

      // Destroy previous session if this client had one
      const oldSessionId = client.sessionId;
      if (oldSessionId) {
        destroySession(oldSessionId);
        const orphan = orphanedControllers.get(oldSessionId);
        if (orphan) { orphan.handleDisconnect(); orphanedControllers.delete(oldSessionId); }
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
      controller.handleText(msg.text);
      break;
    }

    case 'key': {
      const controller = client.controller;
      if (!controller) { wsSend(ws, { type: 'error', message: 'Not connected' }); return; }
      await controller.handleKey(msg.key);
      break;
    }

    case 'setCursor': {
      const controller = client.controller;
      if (!controller) { wsSend(ws, { type: 'error', message: 'Not connected' }); return; }
      controller.handleSetCursor(msg.row, msg.col);
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
          orphanedControllers.delete(sessionId);
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
          if (oldSessionId) {
            const set = sessionClients.get(oldSessionId);
            if (set) { set.delete(client); if (set.size === 0) sessionClients.delete(oldSessionId); }
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

    case 'disconnect': {
      if (client.controller) {
        client.controller.handleDisconnect();
        client.controller = null;
      }
      if (client.sessionId) {
        destroySession(client.sessionId);
        const set = sessionClients.get(client.sessionId);
        if (set) { set.delete(client); if (set.size === 0) sessionClients.delete(client.sessionId); }
        client.sessionId = null;
        unassignedClients.add(client);
      }
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
export function shutdownAllWsControllers(): void {
  for (const [sessionId, orphan] of orphanedControllers) {
    try { orphan.handleDisconnect(); } catch { /* ignore */ }
    orphanedControllers.delete(sessionId);
  }
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
    try { ctrl.handleDisconnect(); } catch { /* ignore */ }
    client.controller = null;
  }
}
