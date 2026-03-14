import { Router, Request, Response, NextFunction } from 'express';
import {
  Session,
  createSession,
  getSession,
  getDefaultSession,
  destroySession,
} from './session.js';
import { bindSessionToWebSocket } from './websocket.js';

const router = Router();

/** Resolve session from header, query param, or default */
function resolveSession(req: Request): Session | undefined {
  const sessionId =
    (req.headers['x-session-id'] as string) ||
    (req.query.sessionId as string);

  if (sessionId) {
    return getSession(sessionId);
  }
  return getDefaultSession();
}

// POST /connect
router.post('/connect', async (req: Request, res: Response) => {
  try {
    const { host = 'pub400.com', port = 23, protocol = 'tn5250' } = req.body || {};

    const session = createSession(protocol);

    // Store session ID in response header
    res.setHeader('X-Session-Id', session.id);

    bindSessionToWebSocket(session);
    await session.connect(host, port);

    // Wait briefly for initial screen data
    await new Promise(resolve => setTimeout(resolve, 2000));

    const screenData = session.getScreenData();
    res.json({
      success: true,
      sessionId: session.id,
      cursor_row: screenData.cursor_row,
      cursor_col: screenData.cursor_col,
      content: screenData.content,
      screen_signature: screenData.screen_signature,
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
  const session = resolveSession(req);
  if (!session) {
    return res.json({ success: true }); // Already disconnected
  }

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
      cursor_row: screenData.cursor_row,
      cursor_col: screenData.cursor_col,
      content: screenData.content,
      screen_signature: screenData.screen_signature,
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

  res.json({
    success: ok,
    cursor_row: screenData.cursor_row,
    cursor_col: screenData.cursor_col,
    content: screenData.content,
    screen_signature: screenData.screen_signature,
    error: ok ? undefined : 'Cannot type at current cursor position',
  });
});

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

  const ok = session.sendKey(key);
  if (!ok) {
    return res.json({ success: false, error: `Unknown key: ${key}` });
  }

  // Wait for the host to respond with a new screen
  await new Promise(resolve => setTimeout(resolve, 1500));

  const screenData = session.getScreenData();
  res.json({
    success: true,
    cursor_row: screenData.cursor_row,
    cursor_col: screenData.cursor_col,
    content: screenData.content,
    screen_signature: screenData.screen_signature,
  });
});

export default router;
