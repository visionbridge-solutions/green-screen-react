// === Telnet Constants ===
export const TELNET = {
  IAC: 0xFF,   // Interpret As Command
  DONT: 0xFE,
  DO: 0xFD,
  WONT: 0xFC,
  WILL: 0xFB,
  SB: 0xFA,    // Subnegotiation Begin
  SE: 0xF0,    // Subnegotiation End
  EOR: 0xEF,   // End of Record
  NOP: 0xF1,

  // Telnet options
  OPT_BINARY: 0x00,
  OPT_ECHO: 0x01,
  OPT_SGA: 0x03,       // Suppress Go Ahead
  OPT_TTYPE: 0x18,     // Terminal Type
  OPT_EOR: 0x19,       // End of Record
  OPT_NAWS: 0x1F,      // Negotiate About Window Size
  OPT_NEW_ENVIRON: 0x27, // New Environment
  OPT_TN5250E: 0x28,   // TN5250E (40 decimal)

  // Terminal type subneg
  TTYPE_IS: 0x00,
  TTYPE_SEND: 0x01,
} as const;

// === 5250 Data Stream Constants ===

// Record types
export const RECORD_TYPE = {
  GDS: 0x12A0,   // General Data Stream
} as const;

// 5250 opcodes (in the header)
export const OPCODE = {
  NO_OP: 0x00,
  INVITE: 0x01,
  OUTPUT: 0x02,
  PUT_GET: 0x03,
  SAVE_SCREEN: 0x04,
  RESTORE_SCREEN: 0x05,
  READ_IMMEDIATE: 0x06,
  RESERVED: 0x07,
  READ_SCREEN: 0x08,
  CANCEL_INVITE: 0x0A,
  TURN_ON_MSG_LIGHT: 0x0B,
  TURN_OFF_MSG_LIGHT: 0x0C,
} as const;

// 5250 command codes (within WTD, etc.)
export const CMD = {
  CLEAR_UNIT: 0x40,
  CLEAR_FORMAT_TABLE: 0x50,
  CLEAR_UNIT_ALT: 0x20,
  WRITE_TO_DISPLAY: 0x11,   // WTD
  WRITE_ERROR_CODE: 0x21,
  WRITE_ERROR_CODE_WIN: 0x22,
  READ_MDT_FIELDS: 0x52,
  READ_INPUT_FIELDS: 0x42,
  READ_IMMEDIATE: 0x72,
  WRITE_STRUCTURED_FIELD: 0xF3,
  SAVE_SCREEN: 0x02,
  RESTORE_SCREEN: 0x12,
  ROLL: 0x23,
} as const;

// 5250 order codes
export const ORDER = {
  SBA: 0x11,   // Set Buffer Address
  IC: 0x13,    // Insert Cursor
  MC: 0x14,    // Move Cursor
  RA: 0x02,    // Repeat to Address
  EA: 0x03,    // Erase to Address
  SOH: 0x01,   // Start of Header
  TD: 0x10,    // Transparent Data
  WEA: 0x04,   // Write Extended Attribute
  SF: 0x1D,    // Start Field (used in field attribute)
  SA: 0x28,    // Set Attribute
} as const;

// 5250 Aid key bytes (sent from client to host)
export const AID = {
  ENTER: 0xF1,
  F1: 0x31,
  F2: 0x32,
  F3: 0x33,
  F4: 0x34,
  F5: 0x35,
  F6: 0x36,
  F7: 0x37,
  F8: 0x38,
  F9: 0x39,
  F10: 0x3A,
  F11: 0x3B,
  F12: 0x3C,
  F13: 0xB1,
  F14: 0xB2,
  F15: 0xB3,
  F16: 0xB4,
  F17: 0xB5,
  F18: 0xB6,
  F19: 0xB7,
  F20: 0xB8,
  F21: 0xB9,
  F22: 0xBA,
  F23: 0xBB,
  F24: 0xBC,
  PAGE_UP: 0xF4,    // Roll Down
  PAGE_DOWN: 0xF5,  // Roll Up
  CLEAR: 0xBD,
  HELP: 0xF3,
  PRINT: 0xF6,
  RECORD_BACKSPACE: 0xF8,
  SYS_REQUEST: 0x01, // Attention key
} as const;

// Map key names (from frontend) to AID bytes
export const KEY_TO_AID: Record<string, number> = {
  'Enter': AID.ENTER,
  'F1': AID.F1, 'F2': AID.F2, 'F3': AID.F3, 'F4': AID.F4,
  'F5': AID.F5, 'F6': AID.F6, 'F7': AID.F7, 'F8': AID.F8,
  'F9': AID.F9, 'F10': AID.F10, 'F11': AID.F11, 'F12': AID.F12,
  'F13': AID.F13, 'F14': AID.F14, 'F15': AID.F15, 'F16': AID.F16,
  'F17': AID.F17, 'F18': AID.F18, 'F19': AID.F19, 'F20': AID.F20,
  'F21': AID.F21, 'F22': AID.F22, 'F23': AID.F23, 'F24': AID.F24,
  'PageUp': AID.PAGE_UP,
  'PageDown': AID.PAGE_DOWN,
  'Clear': AID.CLEAR,
  'Help': AID.HELP,
  'Print': AID.PRINT,
};

// Field attribute bits (in the FFW - Field Format Word)
export const FFW = {
  BYPASS: 0x20,           // Bypass (protected/output-only)
  DUP_ENABLE: 0x10,
  MDT: 0x08,              // Modified Data Tag
  SHIFT_MASK: 0x07,       // Data type shift bits

  // Second byte flags
  AUTO_ENTER: 0x80,
  FER: 0x40,              // Field Exit Required
  MONOCASE: 0x20,
  MANDATORY_ENTRY: 0x08,
  RIGHT_ADJUST_MASK: 0x07,
} as const;

// Field attribute display attributes (SA order)
export const ATTR = {
  NORMAL: 0x20,
  REVERSE: 0x21,
  HIGH_INTENSITY: 0x22,
  UNDERSCORE: 0x24,
  BLINK: 0x25,
  NON_DISPLAY: 0x27,
  COLUMN_SEPARATOR: 0x23,
} as const;

// Screen dimensions
export const SCREEN = {
  ROWS_24: 24,
  COLS_80: 80,
  ROWS_27: 27,
  COLS_132: 132,
} as const;

// Terminal type strings for negotiation
export const TERMINAL_TYPE = 'IBM-3179-2';
export const TERMINAL_TYPE_WIDE = 'IBM-3477-FC';
