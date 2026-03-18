/**
 * VT100/VT220/VT320 terminal constants and escape sequences.
 */

// ---------------------------------------------------------------------------
// Control characters
// ---------------------------------------------------------------------------
export const ESC = 0x1b;
export const CSI_CHAR = 0x5b; // '['
export const CSI = '\x1b['; // Control Sequence Introducer

export const NUL = 0x00;
export const BEL = 0x07;
export const BS = 0x08;
export const HT = 0x09;
export const LF = 0x0a;
export const VT = 0x0b;
export const FF = 0x0c;
export const CR = 0x0d;
export const SO = 0x0e; // Shift Out (G1 charset)
export const SI = 0x0f; // Shift In (G0 charset)
export const DEL = 0x7f;

// ---------------------------------------------------------------------------
// Telnet constants (standard RFC 854 / RFC 855)
// ---------------------------------------------------------------------------
export const TELNET = {
  IAC: 0xff,
  DONT: 0xfe,
  DO: 0xfd,
  WONT: 0xfc,
  WILL: 0xfb,
  SB: 0xfa,
  SE: 0xf0,
  GA: 0xf9,
  NOP: 0xf1,

  // Options
  OPT_BINARY: 0x00,
  OPT_ECHO: 0x01,
  OPT_SGA: 0x03, // Suppress Go Ahead
  OPT_TTYPE: 0x18, // Terminal Type
  OPT_NAWS: 0x1f, // Negotiate About Window Size

  // Subnegotiation
  TTYPE_IS: 0x00,
  TTYPE_SEND: 0x01,
} as const;

// ---------------------------------------------------------------------------
// Screen defaults
// ---------------------------------------------------------------------------
export const DEFAULT_ROWS = 24;
export const DEFAULT_COLS = 80;

// ---------------------------------------------------------------------------
// Terminal type strings
// ---------------------------------------------------------------------------
export const TERMINAL_TYPES = {
  VT220: 'VT220',
  VT320: 'VT320',
  XTERM: 'xterm',
} as const;

export const DEFAULT_TERMINAL_TYPE = TERMINAL_TYPES.VT220;

// ---------------------------------------------------------------------------
// VT220 function key escape sequences (sent by client)
// ---------------------------------------------------------------------------
export const VT_KEYS: Record<string, string> = {
  // F1-F5 (VT220 sends SS3 sequences for F1-F4)
  F1: '\x1bOP',
  F2: '\x1bOQ',
  F3: '\x1bOR',
  F4: '\x1bOS',
  F5: '\x1b[15~',

  // F6-F12
  F6: '\x1b[17~',
  F7: '\x1b[18~',
  F8: '\x1b[19~',
  F9: '\x1b[20~',
  F10: '\x1b[21~',
  F11: '\x1b[23~',
  F12: '\x1b[24~',

  // F13-F24 (shifted function keys on VT220)
  F13: '\x1b[25~',
  F14: '\x1b[26~',
  F15: '\x1b[28~',
  F16: '\x1b[29~',
  F17: '\x1b[31~',
  F18: '\x1b[32~',
  F19: '\x1b[33~',
  F20: '\x1b[34~',

  // Arrow keys
  UP: '\x1b[A',
  DOWN: '\x1b[B',
  RIGHT: '\x1b[C',
  LEFT: '\x1b[D',

  // Editing keys
  HOME: '\x1b[1~',
  INSERT: '\x1b[2~',
  DELETE: '\x1b[3~',
  END: '\x1b[4~',
  PAGEUP: '\x1b[5~',
  PAGEDOWN: '\x1b[6~',

  // Special keys
  ENTER: '\r',
  TAB: '\t',
  BACKSPACE: '\x7f',
  ESCAPE: '\x1b',
};

// ---------------------------------------------------------------------------
// SGR (Select Graphic Rendition) attribute codes
// ---------------------------------------------------------------------------
export const SGR = {
  RESET: 0,
  BOLD: 1,
  DIM: 2,
  ITALIC: 3,
  UNDERLINE: 4,
  BLINK: 5,
  RAPID_BLINK: 6,
  REVERSE: 7,
  HIDDEN: 8,
  STRIKETHROUGH: 9,

  // Turn off attributes
  NORMAL_INTENSITY: 22,
  NO_ITALIC: 23,
  NO_UNDERLINE: 24,
  NO_BLINK: 25,
  NO_REVERSE: 27,
  NO_HIDDEN: 28,
  NO_STRIKETHROUGH: 29,

  // Foreground colors
  FG_BLACK: 30,
  FG_RED: 31,
  FG_GREEN: 32,
  FG_YELLOW: 33,
  FG_BLUE: 34,
  FG_MAGENTA: 35,
  FG_CYAN: 36,
  FG_WHITE: 37,
  FG_DEFAULT: 39,

  // Background colors
  BG_BLACK: 40,
  BG_RED: 41,
  BG_GREEN: 42,
  BG_YELLOW: 43,
  BG_BLUE: 44,
  BG_MAGENTA: 45,
  BG_CYAN: 46,
  BG_WHITE: 47,
  BG_DEFAULT: 49,

  // Bright foreground colors
  FG_BRIGHT_BLACK: 90,
  FG_BRIGHT_RED: 91,
  FG_BRIGHT_GREEN: 92,
  FG_BRIGHT_YELLOW: 93,
  FG_BRIGHT_BLUE: 94,
  FG_BRIGHT_MAGENTA: 95,
  FG_BRIGHT_CYAN: 96,
  FG_BRIGHT_WHITE: 97,

  // Bright background colors
  BG_BRIGHT_BLACK: 100,
  BG_BRIGHT_RED: 101,
  BG_BRIGHT_GREEN: 102,
  BG_BRIGHT_YELLOW: 103,
  BG_BRIGHT_BLUE: 104,
  BG_BRIGHT_MAGENTA: 105,
  BG_BRIGHT_CYAN: 106,
  BG_BRIGHT_WHITE: 107,
} as const;
