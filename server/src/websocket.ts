import { WebSocketServer, WebSocket } from 'ws';
import { IncomingMessage, Server as HttpServer } from 'http';
import { URL } from 'url';
import { getSession, getDefaultSession, getAllSessions, Session } from './session.js';

interface WsClient {
  ws: WebSocket;
  sessionId: string | null;
}

const clients: Set<WsClient> = new Set();

export function setupWebSocket(server: HttpServer): WebSocketServer {
  const wss = new WebSocketServer({ server, path: '/ws' });

  wss.on('connection', (ws: WebSocket, req: IncomingMessage) => {
    // Extract sessionId from query params
    const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
    const sessionId = url.searchParams.get('sessionId');

    const client: WsClient = { ws, sessionId };
    clients.add(client);

    ws.on('close', () => {
      clients.delete(client);
    });

    ws.on('error', () => {
      clients.delete(client);
    });

    // Send current screen immediately if a session is available
    const session = sessionId ? getSession(sessionId) : getDefaultSession();
    if (session && session.status.connected) {
      ws.send(JSON.stringify({ type: 'screen', data: session.getScreenData() }));
      ws.send(JSON.stringify({ type: 'status', data: session.status }));
    }
  });

  return wss;
}

/** Subscribe to a session's events and push to connected WS clients */
export function bindSessionToWebSocket(session: Session): void {
  session.on('screenChange', (screenData: any) => {
    const msg = JSON.stringify({ type: 'screen', data: screenData });
    broadcastToSession(session.id, msg);
  });

  session.on('statusChange', (status: any) => {
    const msg = JSON.stringify({ type: 'status', data: status });
    broadcastToSession(session.id, msg);
  });
}

function broadcastToSession(sessionId: string, message: string): void {
  for (const client of clients) {
    if (client.ws.readyState !== WebSocket.OPEN) continue;

    // Send to clients that are either:
    // 1. Explicitly bound to this session
    // 2. Not bound to any session (will receive from default/single session)
    if (client.sessionId === sessionId || client.sessionId === null) {
      client.ws.send(message);
    }
  }
}
