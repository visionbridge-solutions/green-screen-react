import { WebSocketServer, WebSocket } from 'ws';
import { IncomingMessage, Server as HttpServer } from 'http';
import { URL } from 'url';
import {
  Session,
  createSession,
  getSession,
  getDefaultSession,
  destroySession,
} from './session.js';

interface WsClient {
  ws: WebSocket;
  sessionId: string | null;
}

const clients: Set<WsClient> = new Set();

export function setupWebSocket(server: HttpServer): WebSocketServer {
  const wss = new WebSocketServer({ server, path: '/ws' });

  wss.on('connection', (ws: WebSocket, req: IncomingMessage) => {
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

    // Handle incoming commands (bidirectional protocol)
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

/** Handle an incoming WebSocket command from the client */
async function handleWsCommand(ws: WebSocket, client: WsClient, msg: any): Promise<void> {
  switch (msg.type) {
    case 'connect': {
      const { host = 'pub400.com', port = 23, protocol = 'tn5250' } = msg;

      const session = createSession(protocol);
      client.sessionId = session.id;

      bindSessionToWebSocket(session);

      wsSend(ws, { type: 'status', data: { connected: false, status: 'connecting', protocol, host } });

      try {
        await session.connect(host, port);
        wsSend(ws, { type: 'status', data: { connected: true, status: 'connected', protocol, host } });

        // Wait for initial screen data
        await new Promise(resolve => setTimeout(resolve, 2000));
        const screenData = session.getScreenData();
        wsSend(ws, { type: 'screen', data: screenData });
        wsSend(ws, { type: 'connected', sessionId: session.id });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        wsSend(ws, { type: 'error', message });
        wsSend(ws, { type: 'status', data: { connected: false, status: 'error', protocol, host, error: message } });
      }
      break;
    }

    case 'text': {
      const session = resolveSession(client);
      if (!session) { wsSend(ws, { type: 'error', message: 'Not connected' }); return; }

      session.sendText(msg.text);
      const screenData = session.getScreenData();
      wsSend(ws, { type: 'screen', data: screenData });
      break;
    }

    case 'key': {
      const session = resolveSession(client);
      if (!session) { wsSend(ws, { type: 'error', message: 'Not connected' }); return; }

      const ok = session.sendKey(msg.key);
      if (!ok) { wsSend(ws, { type: 'error', message: `Unknown key: ${msg.key}` }); return; }

      // Wait for host response
      await new Promise(resolve => setTimeout(resolve, 1500));
      const screenData = session.getScreenData();
      wsSend(ws, { type: 'screen', data: screenData });
      break;
    }

    case 'disconnect': {
      const session = resolveSession(client);
      if (session) {
        destroySession(session.id);
        client.sessionId = null;
      }
      wsSend(ws, { type: 'status', data: { connected: false, status: 'disconnected' } });
      break;
    }
  }
}

function resolveSession(client: WsClient): Session | undefined {
  if (client.sessionId) return getSession(client.sessionId);
  return getDefaultSession();
}

function wsSend(ws: WebSocket, data: object): void {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(data));
  }
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

    if (client.sessionId === sessionId || client.sessionId === null) {
      client.ws.send(message);
    }
  }
}
