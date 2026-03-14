import { Router, Request, Response } from 'express';
import { createHash } from 'crypto';

const router = Router();

// Mock screen state
interface MockState {
  currentScreen: 'signon' | 'menu';
  cursorRow: number;
  cursorCol: number;
  username: string;
  password: string;
  connected: boolean;
}

const state: MockState = {
  currentScreen: 'signon',
  cursorRow: 6,
  cursorCol: 53,
  username: '',
  password: '',
  connected: false,
};

function pad(str: string, len: number): string {
  return str.padEnd(len).substring(0, len);
}

function signonScreen(): string {
  const lines = [
    pad('                         Sign On', 80),
    pad('                                                         System  . . : PUB400', 80),
    pad('                                                         Subsystem . : QINTER', 80),
    pad('                                                         Display . . : QPADEV0001', 80),
    pad('', 80),
    pad('', 80),
    pad(' User  . . . . . . . . . . . . . .   ' + pad(state.username, 10), 80),
    pad(' Password  . . . . . . . . . . . .   ' + pad('', 10), 80),
    pad(' Program/procedure . . . . . . . .   ' + pad('', 10), 80),
    pad(' Menu  . . . . . . . . . . . . . .   ' + pad('', 10), 80),
    pad(' Current library . . . . . . . . .   ' + pad('', 10), 80),
    pad('', 80),
    pad('', 80),
    pad('', 80),
    pad('', 80),
    pad('', 80),
    pad('', 80),
    pad('', 80),
    pad('', 80),
    pad('', 80),
    pad('', 80),
    pad('', 80),
    pad('                  (C) COPYRIGHT IBM CORP. 1980, 2024.', 80),
    pad('', 80),
  ];
  return lines.join('\n');
}

function menuScreen(): string {
  const lines = [
    pad('  MAIN                        AS/400 Main Menu                                ', 80),
    pad('                                                        System:   PUB400', 80),
    pad(' Select one of the following:', 80),
    pad('', 80),
    pad('      1. User tasks', 80),
    pad('      2. Office tasks', 80),
    pad('      3. General system tasks', 80),
    pad('      4. Files, libraries, and folders', 80),
    pad('      5. Programming', 80),
    pad('      6. Communications', 80),
    pad('      7. Define or change the system', 80),
    pad('      8. Problem handling', 80),
    pad('      9. Display a menu', 80),
    pad('     10. Information Assistant options', 80),
    pad('     11. Client Access/400 tasks', 80),
    pad('', 80),
    pad('     90. Sign off', 80),
    pad('', 80),
    pad('', 80),
    pad(' Selection or command', 80),
    pad(' ===> ' + pad('', 74), 80),
    pad('', 80),
    pad(' F3=Exit   F4=Prompt   F9=Retrieve   F12=Cancel', 80),
    pad(' F13=Information Assistant   F23=Set initial menu', 80),
  ];
  return lines.join('\n');
}

function getScreenData() {
  const content = state.currentScreen === 'signon' ? signonScreen() : menuScreen();
  const hash = createHash('md5').update(content).digest('hex').substring(0, 12);

  const fields = state.currentScreen === 'signon'
    ? [
        { row: 6, col: 53, length: 10, is_input: true, is_protected: false },
        { row: 7, col: 53, length: 10, is_input: true, is_protected: false, is_reverse: true },
        { row: 8, col: 53, length: 10, is_input: true, is_protected: false },
        { row: 9, col: 53, length: 10, is_input: true, is_protected: false },
        { row: 10, col: 53, length: 10, is_input: true, is_protected: false },
      ]
    : [
        { row: 20, col: 7, length: 73, is_input: true, is_protected: false },
      ];

  return {
    content,
    cursor_row: state.cursorRow,
    cursor_col: state.cursorCol,
    rows: 24,
    cols: 80,
    fields,
    screen_signature: hash,
    timestamp: new Date().toISOString(),
  };
}

// POST /connect
router.post('/connect', (_req: Request, res: Response) => {
  state.connected = true;
  state.currentScreen = 'signon';
  state.cursorRow = 6;
  state.cursorCol = 53;
  state.username = '';
  state.password = '';

  const screen = getScreenData();
  res.json({
    success: true,
    sessionId: 'mock-session',
    cursor_row: screen.cursor_row,
    cursor_col: screen.cursor_col,
    content: screen.content,
    screen_signature: screen.screen_signature,
  });
});

// POST /disconnect
router.post('/disconnect', (_req: Request, res: Response) => {
  state.connected = false;
  state.currentScreen = 'signon';
  res.json({ success: true });
});

// POST /reconnect
router.post('/reconnect', (_req: Request, res: Response) => {
  state.connected = true;
  state.currentScreen = 'signon';
  state.cursorRow = 6;
  state.cursorCol = 53;
  state.username = '';
  state.password = '';

  const screen = getScreenData();
  res.json({
    success: true,
    cursor_row: screen.cursor_row,
    cursor_col: screen.cursor_col,
    content: screen.content,
    screen_signature: screen.screen_signature,
  });
});

// GET /status
router.get('/status', (_req: Request, res: Response) => {
  res.json({
    connected: state.connected,
    status: state.connected
      ? (state.currentScreen === 'menu' ? 'authenticated' : 'connected')
      : 'disconnected',
    host: state.connected ? 'mock-ibmi' : undefined,
    username: state.currentScreen === 'menu' ? (state.username || 'MOCKUSER') : undefined,
  });
});

// GET /screen
router.get('/screen', (_req: Request, res: Response) => {
  if (!state.connected) {
    return res.status(503).json(null);
  }
  res.json(getScreenData());
});

// POST /send-text
router.post('/send-text', (req: Request, res: Response) => {
  if (!state.connected) {
    return res.status(404).json({ success: false, error: 'Not connected' });
  }

  const { text } = req.body || {};
  if (typeof text !== 'string') {
    return res.status(400).json({ success: false, error: 'text is required' });
  }

  // Insert text at cursor
  if (state.currentScreen === 'signon') {
    if (state.cursorRow === 6) {
      state.username = (state.username + text).substring(0, 10);
      state.cursorCol = 53 + state.username.length;
    } else if (state.cursorRow === 7) {
      state.password = (state.password + text).substring(0, 10);
      state.cursorCol = 53 + state.password.length;
    }
  }

  const screen = getScreenData();
  res.json({
    success: true,
    cursor_row: state.cursorRow,
    cursor_col: state.cursorCol,
    content: screen.content,
    screen_signature: screen.screen_signature,
  });
});

// POST /send-key
router.post('/send-key', (req: Request, res: Response) => {
  if (!state.connected) {
    return res.status(404).json({ success: false, error: 'Not connected' });
  }

  const { key } = req.body || {};
  if (typeof key !== 'string') {
    return res.status(400).json({ success: false, error: 'key is required' });
  }

  if (key === 'Enter') {
    if (state.currentScreen === 'signon') {
      // Transition to menu
      state.currentScreen = 'menu';
      state.cursorRow = 20;
      state.cursorCol = 7;
    }
  } else if (key === 'Tab') {
    // Move to next field
    if (state.currentScreen === 'signon') {
      if (state.cursorRow < 10) {
        state.cursorRow++;
        state.cursorCol = 53;
      }
    }
  } else if (key === 'F3') {
    // Go back / sign off
    if (state.currentScreen === 'menu') {
      state.currentScreen = 'signon';
      state.cursorRow = 6;
      state.cursorCol = 53;
      state.username = '';
      state.password = '';
    }
  }

  const screen = getScreenData();
  res.json({
    success: true,
    cursor_row: state.cursorRow,
    cursor_col: state.cursorCol,
    content: screen.content,
    screen_signature: screen.screen_signature,
  });
});

export default router;
