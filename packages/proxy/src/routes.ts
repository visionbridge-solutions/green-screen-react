import { Router, Request, Response, NextFunction } from 'express';
import {
  Session,
  createSession,
  getSession,
  getDefaultSession,
  getAllSessions,
  gracefullyDestroySession,
} from './session.js';
import { TN5250Handler } from './protocols/index.js';
import {
  broadcastScreenToSession,
  cancelOrphanReapOnRestActivity,
  destroyWsSession,
} from './websocket.js';
import { getKeyedSessionId, bindKey, withKeyLock } from './session-keys.js';
const router = Router();

/** Build the success payload for a connected session: its id, whether it was
 *  reused (vs freshly opened), the host's signed-on state, and the current
 *  screen. ``authenticated`` lets a connect-by-key caller tell "the proxy
 *  re-handed-me the existing signed-on session" from "I need to drive
 *  post-sign-on myself". */
function sessionConnectPayload(session: Session, reused: boolean): Record<string, unknown> {
  return {
    success: true,
    sessionId: session.id,
    reused,
    authenticated: session.status.status === 'authenticated',
    ...session.getScreenData(),
  };
}

interface FreshConnectOpts {
  host: string;
  port: number;
  protocol: string;
  terminalType?: string;
  /** EBCDIC code page (proxy EbcdicCodePage). Validated downstream by the handler. */
  codePage?: string;
  screenTimeout?: number;
  connectTimeout?: number;
  /** Stable display device name (TN5250E NEW_ENVIRON DEVNAME). When the caller
   *  passes the SAME name on every connect for one logical agent, IBM i
   *  re-associates a disconnected job to that device instead of auto-assigning a
   *  fresh QPADEVxxxx — so a reconnect reattaches the prior job rather than
   *  signing on anew, and the host stops accruing devices/jobs/sign-ons. Opaque
   *  here; the protocol handler applies it. */
  deviceName?: string;
}

/** Create a session and open its TCP connection (no sign-on). */
async function freshConnectSession(opts: FreshConnectOpts): Promise<Session> {
  const session = createSession(opts.protocol as any);
  console.log(`[connect] Created session ${session.id.slice(0, 8)} for ${opts.host}:${opts.port}`);
  if (typeof opts.screenTimeout === 'number' && opts.screenTimeout > 0) {
    session.screenTimeout = opts.screenTimeout;
  }
  const connectOptions: Record<string, unknown> = {};
  if (opts.terminalType) connectOptions.terminalType = opts.terminalType;
  if (opts.codePage) connectOptions.codePage = opts.codePage;
  if (typeof opts.connectTimeout === 'number' && opts.connectTimeout > 0) connectOptions.connectTimeout = opts.connectTimeout;
  if (opts.deviceName) connectOptions.deviceName = opts.deviceName;
  await session.connect(opts.host, opts.port, Object.keys(connectOptions).length > 0 ? connectOptions : undefined);
  return session;
}

/** Auto-sign-on if credentials were supplied and the session isn't already
 *  authenticated (the reuse path may hand back an already-signed-on session).
 *  Mirrors the legacy inline behaviour: failed sign-on leaves status as
 *  'connected' so the screen (with its CPF error) still reaches the caller. */
async function ensureSignedOn(session: Session, username?: string, password?: string): Promise<void> {
  if (!username || !password) {
    // No creds — give the host a beat to paint the initial screen.
    await new Promise((r) => setTimeout(r, session.screenTimeout));
    return;
  }
  if (session.status.status === 'authenticated') return;
  if (!(session.handler instanceof TN5250Handler)) return;
  const result = await session.handler.performAutoSignIn(username, password);
  if (result?.authenticated) session.markAuthenticated(username);
}

/** Resolve session from header, query param, or default. Resets idle
 *  timer on access AND cancels any pending orphan-reap — REST activity
 *  proves the client is still around, even if its WebSocket dropped. */
function resolveSession(req: Request): Session | undefined {
  const sessionId =
    (req.headers['x-session-id'] as string) ||
    (req.query.sessionId as string);

  const session = sessionId ? getSession(sessionId) : getDefaultSession();
  if (session) {
    session.touch();
    cancelOrphanReapOnRestActivity(session.id);
  }
  return session;
}

/** Delay between keystrokes when typing a field char-by-char. */
const KEYSTROKE_DELAY_MS = 15;

const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Type `text` into the current field one character at a time, broadcasting a
 * screen frame after each keystroke so WS-attached dashboards render genuine
 * per-keystroke "typing" instead of the whole value snapping in at once.
 *
 * The cursor/field is validated per character: `sendText` (→ `insertText`)
 * returns false at a non-writable position, so a misplaced cursor fails fast
 * and the caller can abort the batch rather than silently dropping the value.
 * Keystrokes are KEYSTROKE_DELAY_MS apart with no trailing delay.
 *
 * Returns false if a character could not be written (nothing more is typed).
 */
async function typeTextAnimated(session: Session, text: string): Promise<boolean> {
  const chars = [...text];
  for (let i = 0; i < chars.length; i++) {
    const ok = session.sendText(chars[i]);
    if (!ok) return false;
    broadcastScreenToSession(session.id, session.getScreenData());
    if (i < chars.length - 1) await delay(KEYSTROKE_DELAY_MS);
  }
  return true;
}

// POST /connect
router.post('/connect', async (req: Request, res: Response) => {
  try {
    const { host = 'pub400.com', port = 23, protocol = 'tn5250', terminalType, codePage, screenTimeout, connectTimeout, username, password, key, forceNew, deviceName } = req.body || {};
    const opts: FreshConnectOpts = { host, port, protocol, terminalType, codePage, screenTimeout, connectTimeout, deviceName };

    // ── Connect-by-key: at most one live session per key ──
    // A burst of reconnects for one logical agent serialises on the per-key
    // mutex; the first opens the session, the rest observe it live and reuse
    // it. This defeats the "N reconnects → N host devices → LMTDEVSSN/CPF1220
    // contention" storm structurally, instead of relying on the integrator to
    // coordinate. The key is opaque — never interpreted here.
    if (typeof key === 'string' && key.length > 0) {
      return await withKeyLock(key, async () => {
        const existingId = forceNew ? undefined : getKeyedSessionId(key);
        const existing = existingId ? getSession(existingId) : undefined;
        let session: Session;
        let reused = false;
        if (existing && existing.status.connected) {
          session = existing;
          reused = true;
          session.touch();
        } else {
          // Release any prior keyed session's device (dead, or forceNew) before
          // replacing it, so the host's device pool stays clean.
          const priorId = getKeyedSessionId(key);
          if (priorId && getSession(priorId)) {
            void gracefullyDestroySession(priorId).catch(() => { /* best-effort */ });
          }
          session = await freshConnectSession(opts);
          bindKey(key, session.id);
        }
        // Sign on if creds were given and the session isn't already
        // authenticated — covers both a fresh session and a reused one that
        // was opened (via connect()) but not yet signed on.
        await ensureSignedOn(session, username, password);
        res.setHeader('X-Session-Id', session.id);
        return res.json(sessionConnectPayload(session, reused));
      });
    }

    // ── No key: legacy behaviour — sign off the caller's previous session
    // (by X-Session-Id only; other agents may legitimately hold concurrent
    // sessions to the same host), then open a fresh one. A graceful SIGNOFF
    // releases the IBM i QPADEV device; a hard drop would leave it hanging
    // until QDEVRCYACN reaps it, and under churn those trip QMAXSIGN/QAUTOVRT.
    const previousSessionId = req.headers['x-session-id'] as string;
    if (previousSessionId && getSession(previousSessionId)) {
      console.log(`[connect] Signing off caller's previous session ${previousSessionId.slice(0, 8)} for ${host}:${port} before new connect`);
      void gracefullyDestroySession(previousSessionId).catch(() => { /* best-effort */ });
    }
    const session = await freshConnectSession(opts);
    res.setHeader('X-Session-Id', session.id);
    await ensureSignedOn(session, username, password);
    return res.json(sessionConnectPayload(session, false));
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

// GET /sessions — list all active sessions (used by integrators to detect
// orphaned sessions on startup and decide whether to sweep them).
router.get('/sessions', (_req: Request, res: Response) => {
  const sessions = getAllSessions().map(s => ({
    id: s.id,
    status: s.status,
  }));
  res.json({ sessions, count: sessions.length });
});

// POST /disconnect-all — gracefully tear down every active session (SIGNOFF
// + TCP close). Used by integrators on startup to clean up orphaned sessions
// from a previous lifecycle and avoid CPF1220 device-session-limit errors.
router.post('/disconnect-all', async (_req: Request, res: Response) => {
  const sessions = getAllSessions();
  const count = sessions.length;
  if (count === 0) {
    return res.json({ success: true, destroyed: 0 });
  }

  console.log(`[disconnect-all] Tearing down ${count} session(s)`);
  await Promise.allSettled(
    sessions.map(s =>
      Promise.allSettled([
        gracefullyDestroySession(s.id),
        destroyWsSession(s.id),
      ])
    )
  );
  console.log(`[disconnect-all] Done — ${count} session(s) destroyed`);
  res.json({ success: true, destroyed: count });
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
//
// Two roles, distinguished by whether a session resolves:
//  - With a session (x-session-id / ?sessionId= / a single default session):
//    returns that session's ConnectionStatus. Used by the REST adapter and
//    the Python client.
//  - With no session resolved (the multi-session case — e.g. the Docker
//    healthcheck / integrator readiness probe hitting it bare): the proxy
//    has no single global connection state, so report SERVER liveness plus
//    the live session count instead of a misleading per-session
//    'disconnected' stub. Callers wanting per-session state must pass a
//    session id (or use /sessions).
router.get('/status', (req: Request, res: Response) => {
  const session = resolveSession(req);
  if (!session) {
    return res.json({
      ok: true,
      sessions: getAllSessions().length,
    });
  }
  res.json(session.status);
});

// GET /liveness — unambiguous half-open detection.
//
// Returns wall-clock ms timestamps of the most recent byte SENT to the
// host and the most recent byte RECEIVED from the host. The intended
// use: after writing an AID at time T, poll this endpoint after a
// short window and check whether ``lastReceivedAtMs > T``. If yes, the
// host responded → link alive. If no, the host has been silent since
// our send → link is half-open, treat as dead.
//
// This sidesteps the screen-state heuristic (kbd_locked) entirely.
// kbd_locked can stay true for legitimate reasons (error message
// awaiting Reset, host reply that omits CC2 unlock bit, etc.) and
// confuses any liveness check that reads it.
//
// 404 if no session — caller should treat that as "session is gone,
// reconnect from scratch".
router.get('/liveness', (req: Request, res: Response) => {
  const session = resolveSession(req);
  if (!session) {
    return res.status(404).json({ error: 'session not found' });
  }
  const liveness = session.handler.getLiveness();
  res.json({
    connected: session.status.connected,
    lastReceivedAtMs: liveness.lastReceivedAtMs,
    lastSentAtMs: liveness.lastSentAtMs,
    nowMs: Date.now(),
  });
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

        case 'text': {
          const typed = await typeTextAnimated(session, op.value);
          if (!typed) {
            return res.json({ success: false, error: `Cannot type "${op.value}" at current cursor position` });
          }
          lastRemoteKey = false;
          break;
        }

        case 'setCursor':
          session.setCursor(op.row, op.col);
          lastRemoteKey = false;
          break;

        case 'eraseEOF':
          session.eraseEOF();
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
router.post('/send-text', async (req: Request, res: Response) => {
  const session = resolveSession(req);
  if (!session) {
    return res.status(404).json({ success: false, error: 'No active session' });
  }

  const { text } = req.body || {};
  if (typeof text !== 'string') {
    return res.status(400).json({ success: false, error: 'text is required' });
  }

  // Type char-by-char (broadcasting each keystroke) so attached dashboards see
  // genuine typing; typeTextAnimated emits the per-keystroke frames itself.
  const ok = await typeTextAnimated(session, text);
  const screenData = session.getScreenData();

  // Final authoritative frame after the last keystroke.
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

  // Local key: immediate response, no host round-trip.
  // Buffer-modifying keys (Backspace, Delete, Insert, Reset, FieldExit) and
  // cursor-moving keys (Tab, arrows, Home, End) both update the local screen
  // state, so we must broadcast to any WebSocket clients attached to this
  // session (e.g. a dashboard using reattach) — otherwise they'd only learn
  // about the update when the next remote key triggers a host roundtrip,
  // and the terminal view would appear stuck on the pre-key state.
  const ok = session.sendKey(key);
  if (!ok) {
    return res.json({ success: false, error: `Unknown key: ${key}` });
  }
  const screenData = session.getScreenData();
  broadcastScreenToSession(session.id, screenData);
  res.json({ success: true, ...screenData });
});

export default router;
