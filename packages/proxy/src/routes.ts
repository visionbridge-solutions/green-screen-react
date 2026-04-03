import { Router, Request, Response, NextFunction } from 'express';
import {
  Session,
  createSession,
  getSession,
  getDefaultSession,
  getAllSessions,
  destroySession,
} from './session.js';
import { TN5250Handler } from './protocols/index.js';
import { broadcastScreenToSession } from './websocket.js';
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
      const screen = await session.handler.performAutoSignIn(username, password);
      if (screen) {
        session.markAuthenticated(username);
        return res.json({
          success: true,
          sessionId: session.id,
          ...screen,
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

// POST /disconnect
router.post('/disconnect', (req: Request, res: Response) => {
  const requestedId = req.headers['x-session-id'] as string || '(none)';
  const session = resolveSession(req);
  if (!session) {
    console.log(`[disconnect] No session found for id=${requestedId.slice(0, 8)}`);
    return res.json({ success: true }); // Already disconnected
  }

  console.log(`[disconnect] Destroying session ${session.id.slice(0, 8)} (requested=${requestedId.slice(0, 8)})`);
  destroySession(session.id);
  res.json({ success: true });
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
