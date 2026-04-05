import { Router, Request, Response, NextFunction } from 'express';
import {
  Session,
  createSession,
  getSession,
  getDefaultSession,
  getAllSessions,
  destroySession,
  gracefullyDestroySession,
} from './session.js';
import { TN5250Handler } from './protocols/index.js';
import { broadcastScreenToSession, destroyWsSession } from './websocket.js';
const router = Router();

/** Resolve session from header, query param, or default. Resets idle timer on access. */
function resolveSession(req: Request): Session | undefined {
  const sessionId =
    (req.headers['x-session-id'] as string) ||
    (req.query.sessionId as string);

  const session = sessionId ? getSession(sessionId) : getDefaultSession();
  if (session) session.touch();
  return session;
}

// POST /connect
router.post('/connect', async (req: Request, res: Response) => {
  try {
    const { host = 'pub400.com', port = 23, protocol = 'tn5250', terminalType, screenTimeout, connectTimeout, username, password } = req.body || {};

    // Destroy only the caller's previous session (identified by X-Session-Id),
    // NOT all sessions for the same host:port. Multiple agents may legitimately
    // maintain concurrent sessions to the same host.
    const previousSessionId = req.headers['x-session-id'] as string;
    if (previousSessionId) {
      const prev = getSession(previousSessionId);
      if (prev) {
        console.log(`[connect] Destroying caller's previous session ${previousSessionId.slice(0, 8)} for ${host}:${port} before new connect`);
        destroySession(previousSessionId);
      }
    }

    const session = createSession(protocol);
    console.log(`[connect] Created session ${session.id.slice(0, 8)} for ${host}:${port}`);
    if (typeof screenTimeout === 'number' && screenTimeout > 0) {
      session.screenTimeout = screenTimeout;
    }

    // Store session ID in response header
    res.setHeader('X-Session-Id', session.id);

    const options: Record<string, unknown> = {};
    if (terminalType) options.terminalType = terminalType;
    if (typeof connectTimeout === 'number' && connectTimeout > 0) options.connectTimeout = connectTimeout;

    await session.connect(host, port, Object.keys(options).length > 0 ? options : undefined);

    // Auto-sign-in if credentials provided and handler supports it
    if (username && password && session.handler instanceof TN5250Handler) {
      const result = await session.handler.performAutoSignIn(username, password);
      if (result) {
        if (result.authenticated) {
          session.markAuthenticated(username);
        }
        // On failed sign-in (host still showing the sign-on screen, e.g.
        // wrong password or CPF1220 device-session-limit), DO NOT mark
        // as authenticated. The caller still receives the screen so the
        // error message is visible to the user, but gracefulDestroy will
        // not attempt a futile SIGNOFF on the sign-on screen.
        return res.json({
          success: true,
          sessionId: session.id,
          ...result.screen,
        });
      }
    }

    // Wait for initial screen data
    await new Promise(resolve => setTimeout(resolve, session.screenTimeout));

    const screenData = session.getScreenData();
    res.json({
      success: true,
      sessionId: session.id,
      ...screenData,
    });
  } catch (err: any) {
    res.status(500).json({
      success: false,
      error: err.message || 'Connection failed',
    });
  }
});

// POST /disconnect — graceful teardown: SIGNOFF + TCP close for
// authenticated sessions, plain destroy otherwise.
router.post('/disconnect', async (req: Request, res: Response) => {
  const requestedId = req.headers['x-session-id'] as string || '(none)';
  const session = resolveSession(req);
  if (!session) {
    console.log(`[disconnect] No session found for id=${requestedId.slice(0, 8)}`);
    return res.json({ success: true }); // Already disconnected
  }

  console.log(`[disconnect] Destroying session ${session.id.slice(0, 8)} (requested=${requestedId.slice(0, 8)})`);
  await gracefullyDestroySession(session.id);
  res.json({ success: true });
});

// POST /disconnect-beacon — unload-friendly teardown endpoint for
// `navigator.sendBeacon`. Accepts a sessionId in the JSON body (beacon
// requests can't set custom headers reliably) and tears down the session
// whether it was created via REST or WebSocket. Fire-and-forget from the
// client's perspective; the response is primarily for manual testing.
router.post('/disconnect-beacon', async (req: Request, res: Response) => {
  const sessionId: string | undefined =
    (req.body && typeof req.body.sessionId === 'string' ? req.body.sessionId : undefined)
    || (req.query.sessionId as string | undefined);
  if (!sessionId) {
    return res.status(400).json({ success: false, error: 'sessionId is required' });
  }
  console.log(`[disconnect-beacon] Tearing down session ${sessionId.slice(0, 8)}`);
  try {
    // Run both teardown paths — each is a no-op if the session isn't in
    // that registry. WS-created sessions are NOT in the REST store.
    await Promise.allSettled([
      gracefullyDestroySession(sessionId),
      destroyWsSession(sessionId),
    ]);
    res.json({ success: true });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message || 'Beacon teardown failed' });
  }
});

// POST /reconnect
router.post('/reconnect', async (req: Request, res: Response) => {
  const session = resolveSession(req);
  if (!session) {
    return res.status(404).json({ success: false, error: 'No active session' });
  }

  try {
    await session.reconnect();
    await new Promise(resolve => setTimeout(resolve, 2000));
    const screenData = session.getScreenData();
    res.json({
      success: true,
      ...screenData,
    });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// GET /status
router.get('/status', (req: Request, res: Response) => {
  const session = resolveSession(req);
  if (!session) {
    return res.json({
      connected: false,
      status: 'disconnected' as const,
    });
  }
  res.json(session.status);
});

// GET /screen
router.get('/screen', (req: Request, res: Response) => {
  const session = resolveSession(req);
  if (!session) {
    return res.status(503).json(null);
  }

  if (!session.status.connected) {
    return res.status(503).json(null);
  }

  res.json(session.getScreenData());
});

// POST /session/resume — idempotent session-alive probe for REST clients.
//
// Given a session id (body or X-Session-Id header), checks whether the
// session still exists on the proxy and is connected. Returns the current
// screen + connection status on success, 404 otherwise. REST-only
// integrations use this on page reload to decide between "reattach the UI
// to existing state" vs "start a fresh /connect flow".
//
// The corresponding WebSocket mechanism is the `reattach` command plus the
// `session.resumed` / `session.lost` lifecycle events.
router.post('/session/resume', (req: Request, res: Response) => {
  const sessionId =
    (req.body && req.body.sessionId) ||
    (req.headers['x-session-id'] as string) ||
    (req.query.sessionId as string);
  if (!sessionId || typeof sessionId !== 'string') {
    return res.status(400).json({ success: false, error: 'sessionId is required' });
  }
  const session = getSession(sessionId);
  if (!session) {
    return res.status(404).json({ success: false, error: 'Session not found' });
  }
  session.touch();
  res.setHeader('X-Session-Id', session.id);
  const screenData = session.status.connected ? session.getScreenData() : null;
  res.json({
    success: true,
    sessionId: session.id,
    status: session.status,
    ...(screenData ? { screen: screenData } : {}),
  });
});

// POST /session/authenticated — flip the session status to 'authenticated'.
//
// Integrators that implement their own sign-on cascade (e.g. LegacyBridge,
// which needs to dismiss IBM i post-sign-on screens like QDSPSGNINF and
// legal notices) use this to notify the proxy when sign-on has completed.
// The proxy has no protocol-specific knowledge of what "signed-on" means,
// so the caller owns the decision. Emits a status event to all WS clients
// watching this session.
router.post('/session/authenticated', (req: Request, res: Response) => {
  const session = resolveSession(req);
  if (!session) {
    return res.status(404).json({ success: false, error: 'No active session' });
  }
  const { username } = req.body || {};
  if (!username || typeof username !== 'string') {
    return res.status(400).json({ success: false, error: 'username is required' });
  }
  session.markAuthenticated(username);
  res.json({ success: true, status: session.status });
});

// POST /wait-for-fields — wait until the current screen has at least N
// input fields (or timeout). Generic primitive that sign-on cascades use
// to robustly wait for a form to appear before typing credentials. Short-
// circuits when the screen already satisfies.
//
// Body:
//   { minFields: number, timeoutMs?: number (default 5000) }
router.post('/wait-for-fields', async (req: Request, res: Response) => {
  const session = resolveSession(req);
  if (!session) {
    return res.status(404).json({ success: false, error: 'No active session' });
  }
  const { minFields, timeoutMs = 5000 } = req.body || {};
  if (typeof minFields !== 'number' || minFields < 0) {
    return res.status(400).json({ success: false, error: 'minFields (number) is required' });
  }
  const screen = await session.waitForScreenWithFields(minFields, timeoutMs);
  const inputCount = (screen.fields || []).filter((f) => f.is_input).length;
  res.json({
    success: inputCount >= minFields,
    matched: inputCount >= minFields,
    inputFieldCount: inputCount,
    ...screen,
  });
});

// GET /read-mdt — cheap post-write verification primitive
//
// Returns just the input fields whose per-field modified-data-tag (MDT) bit
// is set, with their current cell values. Use case: after a batch of
// sendText/sendKey writes, the client wants to verify what actually landed
// without diffing the entire screen payload.
//
// Query params:
//   includeUnmodified=1 — also return input fields whose MDT bit is clear
//                         (useful when you want a snapshot of all input
//                         fields regardless of modification state).
//
// Protocols that don't track a per-field modified concept (VT, HP6530) will
// return an empty array — this is a TN5250-first primitive.
router.get('/read-mdt', (req: Request, res: Response) => {
  const session = resolveSession(req);
  if (!session) {
    return res.status(404).json({ success: false, error: 'No active session' });
  }
  const modifiedOnly = req.query.includeUnmodified !== '1';
  const values = session.readFieldValues(modifiedOnly);
  res.json({ success: true, modifiedOnly, fields: values });
});

// POST /set-cursor
router.post('/set-cursor', (req: Request, res: Response) => {
  const session = resolveSession(req);
  if (!session) {
    return res.status(404).json({ success: false, error: 'No active session' });
  }

  const { row, col } = req.body || {};
  if (typeof row !== 'number' || typeof col !== 'number') {
    return res.status(400).json({ success: false, error: 'row and col are required (numbers)' });
  }

  const ok = session.setCursor(row, col);
  const screenData = session.getScreenData();

  res.json({
    success: ok,
    cursor_row: screenData.cursor_row,
    cursor_col: screenData.cursor_col,
    error: ok ? undefined : 'Invalid cursor position',
  });
});

// POST /batch
router.post('/batch', async (req: Request, res: Response) => {
  const session = resolveSession(req);
  if (!session) {
    return res.status(404).json({ success: false, error: 'No active session' });
  }

  const { operations, readScreen = true } = req.body || {};
  if (!Array.isArray(operations) || operations.length === 0) {
    return res.status(400).json({ success: false, error: 'operations array is required' });
  }

  // Local-only keys that don't trigger a host roundtrip
  const localKeys = new Set([
    'Tab', 'Backtab', 'TAB', 'BACKTAB',
    'ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown',
    'LEFT', 'RIGHT', 'UP', 'DOWN',
    'Home', 'HOME', 'End', 'END',
    'Backspace', 'BACKSPACE', 'Delete', 'DELETE',
    'Insert', 'INSERT',
    'Reset', 'RESET',
    'FieldExit', 'FIELD_EXIT', 'FIELDEXIT',
  ]);

  let lastRemoteKey = false;

  try {
    for (const op of operations) {
      const repeat = op.repeat ?? 1;

      switch (op.type) {
        case 'key':
          for (let i = 0; i < repeat; i++) {
            const ok = session.sendKey(op.value);
            if (!ok) {
              return res.json({ success: false, error: `Unknown key: ${op.value}` });
            }
          }
          lastRemoteKey = !localKeys.has(op.value);
          break;

        case 'text':
          session.sendText(op.value);
          lastRemoteKey = false;
          break;

        case 'setCursor':
          session.setCursor(op.row, op.col);
          lastRemoteKey = false;
          break;

        default:
          return res.json({ success: false, error: `Unknown operation type: ${op.type}` });
      }
    }

    let screenData;
    if (readScreen && lastRemoteKey) {
      // Wait for host response after last remote key
      screenData = await session.waitForScreen(session.screenTimeout);
    } else {
      screenData = session.getScreenData();
    }

    // Broadcast to WebSocket clients so dashboard stays in sync
    broadcastScreenToSession(session.id, screenData);

    res.json({
      success: true,
      ...screenData,
    });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message || 'Batch operation failed' });
  }
});

// POST /send-text
router.post('/send-text', (req: Request, res: Response) => {
  const session = resolveSession(req);
  if (!session) {
    return res.status(404).json({ success: false, error: 'No active session' });
  }

  const { text } = req.body || {};
  if (typeof text !== 'string') {
    return res.status(400).json({ success: false, error: 'text is required' });
  }

  const ok = session.sendText(text);
  const screenData = session.getScreenData();

  // Broadcast to WebSocket clients so dashboard stays in sync
  if (ok) {
    broadcastScreenToSession(session.id, screenData);
  }

  res.json({
    success: ok,
    ...screenData,
    error: ok ? undefined : 'Cannot type at current cursor position',
  });
});

// Keys that are handled locally in the screen buffer (no host roundtrip needed).
// Must match the set in controller.ts handleKey() for consistent behavior.
const LOCAL_KEYS = new Set([
  'Tab', 'Backtab', 'TAB', 'BACKTAB',
  'ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown',
  'LEFT', 'RIGHT', 'UP', 'DOWN',
  'Home', 'HOME', 'End', 'END',
  'Backspace', 'BACKSPACE', 'Delete', 'DELETE',
  'Insert', 'INSERT',
  'Reset', 'RESET',
  'FieldExit', 'FIELD_EXIT', 'FIELDEXIT',
]);

// POST /send-key
router.post('/send-key', async (req: Request, res: Response) => {
  const session = resolveSession(req);
  if (!session) {
    return res.status(404).json({ success: false, error: 'No active session' });
  }

  const { key } = req.body || {};
  if (typeof key !== 'string') {
    return res.status(400).json({ success: false, error: 'key is required' });
  }

  if (!LOCAL_KEYS.has(key)) {
    // Remote key: race-free send + wait (listener set up before sendKey)
    const { ok, screen } = await session.sendKeyAndWait(key, session.screenTimeout);
    if (!ok) {
      return res.json({ success: false, error: `Unknown key: ${key}` });
    }
    // Broadcast to WebSocket clients so dashboard stays in sync
    broadcastScreenToSession(session.id, screen);
    return res.json({ success: true, ...screen });
  }

  // Local key: immediate response, no host round-trip
  const ok = session.sendKey(key);
  if (!ok) {
    return res.json({ success: false, error: `Unknown key: ${key}` });
  }
  const screenData = session.getScreenData();
  res.json({ success: true, ...screenData });
});

export default router;
