import { WebSocketServer, WebSocket } from 'ws';
import { IncomingMessage, Server as HttpServer } from 'http';
import { URL } from 'url';
import {
  getSession,
  getDefaultSession,
  destroySession,
} from './session.js';
import { SessionController } from './controller.js';
import type { ProtocolType } from './protocols/index.js';

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

export function setupWebSocket(server: HttpServer): WebSocketServer {
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
      const { host = 'pub400.com', port = 23, protocol = 'tn5250', username, password, terminalType } = msg;

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
          wsSend(ws, { type: 'screen', data: session.getScreenData() });
          wsSend(ws, { type: 'status', data: session.status });
          wsSend(ws, { type: 'connected', sessionId: session.id });
        } else {
          wsSend(ws, { type: 'error', message: 'Session not found or disconnected' });
        }
      }
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
