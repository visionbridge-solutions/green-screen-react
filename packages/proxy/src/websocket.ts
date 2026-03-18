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
import { TN5250Handler } from './protocols/tn5250-handler.js';

interface WsClient {
  ws: WebSocket;
  sessionId: string | null;
}

const clients: Set<WsClient> = new Set();
const sessionClients: Map<string, Set<WsClient>> = new Map();
const unassignedClients: Set<WsClient> = new Set();

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
    const set = sessionClients.get(client.sessionId);
    if (set) {
      set.delete(client);
      if (set.size === 0) sessionClients.delete(client.sessionId);
    }
  }
}

function waitForScreen(session: Session, timeoutMs: number): Promise<any> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(session.getScreenData()), timeoutMs);
    session.once('screenChange', (data: any) => {
      clearTimeout(timer);
      resolve(data);
    });
  });
}

/**
 * Wait until the screen has at least `minFields` input fields, or timeout.
 * This handles the case where the host sends CLEAR_UNIT + WTD as separate
 * records — the first screenChange (from CLEAR_UNIT) has no fields, but
 * the second (from WTD) has the actual sign-in fields.
 */
function waitForScreenWithFields(session: Session, minFields: number, timeoutMs: number): Promise<any> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(session.getScreenData()), timeoutMs);

    const check = (data: any) => {
      const inputFields = (data.fields || []).filter((f: any) => f.is_input);
      if (inputFields.length >= minFields) {
        clearTimeout(timer);
        session.removeListener('screenChange', check);
        resolve(data);
      }
    };

    // Check current state first
    const current = session.getScreenData();
    const currentInputs = (current.fields || []).filter((f: any) => f.is_input);
    if (currentInputs.length >= minFields) {
      clearTimeout(timer);
      resolve(current);
      return;
    }

    session.on('screenChange', check);
  });
}

export function setupWebSocket(server: HttpServer): WebSocketServer {
  const wss = new WebSocketServer({ server, path: '/ws' });

  wss.on('connection', (ws: WebSocket, req: IncomingMessage) => {
    const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
    const sessionId = url.searchParams.get('sessionId');

    const client: WsClient = { ws, sessionId };
    clients.add(client);
    indexClient(client);

    ws.on('close', () => {
      removeClient(client);
    });

    ws.on('error', () => {
      removeClient(client);
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
      const { host = 'pub400.com', port = 23, protocol = 'tn5250', username, password } = msg;

      const session = createSession(protocol);
      // Update client's session assignment and re-index
      const oldSessionId = client.sessionId;
      client.sessionId = session.id;
      if (oldSessionId) {
        const set = sessionClients.get(oldSessionId);
        if (set) { set.delete(client); if (set.size === 0) sessionClients.delete(oldSessionId); }
      }
      unassignedClients.delete(client);
      indexClient(client);

      bindSessionToWebSocket(session);

      wsSend(ws, { type: 'status', data: { connected: false, status: 'connecting', protocol, host } });

      try {
        await session.connect(host, port);
        wsSend(ws, { type: 'status', data: { connected: true, status: 'connected', protocol, host } });

        // Auto-sign-in: if credentials were provided, wait for sign-in fields
        // then fill and submit atomically on the proxy side (no client round-trips).
        // Screen updates are handled by bindSessionToWebSocket broadcast — no
        // explicit screen sends here to avoid stale data overwriting broadcast updates
        // (host often sends CLEAR_UNIT + WTD as separate records).
        if (username && password && session.handler instanceof TN5250Handler) {
          await waitForScreenWithFields(session, 2, 5000);
          const handler = session.handler;
          const ok = handler.autoSignIn(username, password);
          if (ok) {
            // Wait for the host's response (confirmation screen or menu).
            await waitForScreen(session, 10000);
            // Restore the username on the confirmation screen — CLEAR_UNIT
            // wipes the buffer, but the user expects their typed value to
            // persist on the sign-on confirmation form.
            handler.restoreFields();
            wsSend(ws, { type: 'screen', data: session.getScreenData() });
          }
        } else {
          await waitForScreen(session, 5000);
        }

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
      // Broadcast handles screen updates for remote changes;
      // for local text insertion, send current state immediately
      wsSend(ws, { type: 'screen', data: session.getScreenData() });
      break;
    }

    case 'key': {
      const session = resolveSession(client);
      if (!session) { wsSend(ws, { type: 'error', message: 'Not connected' }); return; }

      const localKeys = ['Tab', 'Backtab', 'TAB', 'BACKTAB'];
      const ok = session.sendKey(msg.key);
      if (!ok) { wsSend(ws, { type: 'error', message: `Unknown key: ${msg.key}` }); return; }

      if (localKeys.includes(msg.key)) {
        // Local cursor movement — send immediately, no server round-trip
        wsSend(ws, { type: 'screen', data: session.getScreenData() });
      } else {
        // Wait for the host's response, then send the latest screen state.
        // Using getScreenData() instead of the waitForScreen result avoids
        // sending a stale CLEAR_UNIT snapshot when the host sends multiple
        // records (CLEAR_UNIT + WTD) — by the time await resumes, both
        // records have been processed.
        await waitForScreen(session, 3000);
        wsSend(ws, { type: 'screen', data: session.getScreenData() });
      }
      break;
    }

    case 'reattach': {
      const { sessionId } = msg;
      const session = sessionId ? getSession(sessionId) : undefined;
      if (session && session.status.connected) {
        // Reassign this client to the existing session
        const oldSessionId = client.sessionId;
        client.sessionId = session.id;
        if (oldSessionId) {
          const set = sessionClients.get(oldSessionId);
          if (set) { set.delete(client); if (set.size === 0) sessionClients.delete(oldSessionId); }
        }
        unassignedClients.delete(client);
        indexClient(client);
        bindSessionToWebSocket(session);
        wsSend(ws, { type: 'screen', data: session.getScreenData() });
        wsSend(ws, { type: 'status', data: session.status });
        wsSend(ws, { type: 'connected', sessionId: session.id });
      } else {
        wsSend(ws, { type: 'error', message: 'Session not found or disconnected' });
      }
      break;
    }

    case 'disconnect': {
      const session = resolveSession(client);
      if (session) {
        destroySession(session.id);
        const set = sessionClients.get(session.id);
        if (set) { set.delete(client); if (set.size === 0) sessionClients.delete(session.id); }
        client.sessionId = null;
        unassignedClients.add(client);
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
  const targets = sessionClients.get(sessionId);
  if (targets) {
    for (const client of targets) {
      if (client.ws.readyState === WebSocket.OPEN) client.ws.send(message);
    }
  }
  for (const client of unassignedClients) {
    if (client.ws.readyState === WebSocket.OPEN) client.ws.send(message);
  }
}
