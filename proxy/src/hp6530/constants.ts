// === Telnet Constants (reuse from TN5250) ===
export { TELNET } from '../tn5250/constants.js';

// === HP 6530 Terminal Constants ===

/** Terminal type string for Telnet TTYPE negotiation */
export const TERMINAL_TYPE = 'T6530';

/** Alternative terminal type */
export const TERMINAL_TYPE_ALT = 'HP700/96';

/** Screen dimensions */
export const SCREEN = {
  ROWS: 24,
  COLS: 80,
} as const;

// === Control Characters ===

export const CTRL = {
  NUL: 0x00,
  SOH: 0x01,    // Start of header
  STX: 0x02,    // Start of text
  ETX: 0x03,    // End of text
  EOT: 0x04,    // End of transmission
  ENQ: 0x05,    // Enquiry
  ACK: 0x06,    // Acknowledge
  BEL: 0x07,    // Bell
  BS: 0x08,     // Backspace
  HT: 0x09,     // Horizontal tab
  LF: 0x0A,     // Line feed
  VT: 0x0B,     // Vertical tab
  FF: 0x0C,     // Form feed
  CR: 0x0D,     // Carriage return
  SO: 0x0E,     // Shift out
  SI: 0x0F,     // Shift in
  DC1: 0x11,    // XON — Device control 1 (resume transmission)
  DC3: 0x13,    // XOFF — Device control 3 (pause transmission)
  ESC: 0x1B,    // Escape
  DEL: 0x7F,    // Delete
} as const;

// === 6530 Escape Sequences ===
// These are the byte sequences sent from the host to control the terminal.

/** Direct cursor address: ESC [ row ; col H (VT-style CUP) */
export const ESC_CUP_PREFIX = Buffer.from([0x1B, 0x5B]); // ESC [
export const ESC_CUP_SEP = 0x3B;    // ';'
export const ESC_CUP_SUFFIX = 0x48; // 'H'

/** Clear to end of display */
export const ESC_CLEAR_EOS = Buffer.from([0x1B, 0x4A]); // ESC J

/** Clear to end of line */
export const ESC_CLEAR_EOL = Buffer.from([0x1B, 0x4B]); // ESC K

/** Start protected field */
export const ESC_PROTECT_START = Buffer.from([0x1B, 0x29]); // ESC )

/** End protected field (start unprotected) */
export const ESC_PROTECT_END = Buffer.from([0x1B, 0x28]); // ESC (

// === Display Attribute Escape Sequences ===
// Format: ESC & d <code>

export const ATTR = {
  NORMAL: 0x40,       // '@' — Normal display / reset attributes
  HALF_BRIGHT: 0x42,  // 'B' — Dim
  UNDERLINE: 0x44,    // 'D' — Underline
  BLINK: 0x48,        // 'H' — Blink
  INVERSE: 0x4A,      // 'J' — Inverse video
  UNDERLINE_INVERSE: 0x4C, // 'L' — Underline + inverse
} as const;

/** Attribute escape sequence prefix: ESC & d */
export const ESC_ATTR_PREFIX = Buffer.from([0x1B, 0x26, 0x64]); // ESC & d

/** Map of attribute code to human-readable name */
export const ATTR_NAMES: Record<number, string> = {
  [ATTR.NORMAL]: 'normal',
  [ATTR.HALF_BRIGHT]: 'half_bright',
  [ATTR.UNDERLINE]: 'underline',
  [ATTR.BLINK]: 'blink',
  [ATTR.INVERSE]: 'inverse',
  [ATTR.UNDERLINE_INVERSE]: 'underline_inverse',
};

// === Function Key Escape Sequences ===
// Sequences sent from the terminal to the host when function keys are pressed.

/** F1–F8: ESC p through ESC w (0x70–0x77) */
/** F9–F16: ESC ` through ESC g (0x60–0x67) — varies by model */
/** SF1–SF16: shifted versions — ESC P through ESC W (0x50–0x57) for SF1-SF8,
 *  ESC H through ESC O (0x48–0x4F) for SF9-SF16 — varies by model */

export const FKEY_SEQUENCES: Record<string, Buffer> = {
  // F1–F8: ESC p through ESC w
  F1: Buffer.from([0x1B, 0x70]),   // ESC p
  F2: Buffer.from([0x1B, 0x71]),   // ESC q
  F3: Buffer.from([0x1B, 0x72]),   // ESC r
  F4: Buffer.from([0x1B, 0x73]),   // ESC s
  F5: Buffer.from([0x1B, 0x74]),   // ESC t
  F6: Buffer.from([0x1B, 0x75]),   // ESC u
  F7: Buffer.from([0x1B, 0x76]),   // ESC v
  F8: Buffer.from([0x1B, 0x77]),   // ESC w

  // F9–F16: ESC ` through ESC g
  F9:  Buffer.from([0x1B, 0x60]),  // ESC `
  F10: Buffer.from([0x1B, 0x61]), // ESC a
  F11: Buffer.from([0x1B, 0x62]), // ESC b
  F12: Buffer.from([0x1B, 0x63]), // ESC c
  F13: Buffer.from([0x1B, 0x64]), // ESC d
  F14: Buffer.from([0x1B, 0x65]), // ESC e
  F15: Buffer.from([0x1B, 0x66]), // ESC f
  F16: Buffer.from([0x1B, 0x67]), // ESC g

  // SF1–SF8 (shifted): ESC P through ESC W
  SF1: Buffer.from([0x1B, 0x50]),  // ESC P
  SF2: Buffer.from([0x1B, 0x51]),  // ESC Q
  SF3: Buffer.from([0x1B, 0x52]),  // ESC R
  SF4: Buffer.from([0x1B, 0x53]),  // ESC S
  SF5: Buffer.from([0x1B, 0x54]),  // ESC T
  SF6: Buffer.from([0x1B, 0x55]),  // ESC U
  SF7: Buffer.from([0x1B, 0x56]),  // ESC V
  SF8: Buffer.from([0x1B, 0x57]),  // ESC W

  // SF9–SF16 (shifted): ESC H through ESC O
  SF9:  Buffer.from([0x1B, 0x48]), // ESC H
  SF10: Buffer.from([0x1B, 0x49]), // ESC I
  SF11: Buffer.from([0x1B, 0x4A]), // ESC J (note: conflicts with clear EOS in host→terminal direction)
  SF12: Buffer.from([0x1B, 0x4B]), // ESC K
  SF13: Buffer.from([0x1B, 0x4C]), // ESC L
  SF14: Buffer.from([0x1B, 0x4D]), // ESC M
  SF15: Buffer.from([0x1B, 0x4E]), // ESC N
  SF16: Buffer.from([0x1B, 0x4F]), // ESC O
};

// === Arrow Key Sequences (terminal → host) ===

export const ARROW_SEQUENCES: Record<string, Buffer> = {
  UP:    Buffer.from([0x1B, 0x41]), // ESC A
  DOWN:  Buffer.from([0x1B, 0x42]), // ESC B
  RIGHT: Buffer.from([0x1B, 0x43]), // ESC C
  LEFT:  Buffer.from([0x1B, 0x44]), // ESC D
};

// === Combined key-to-sequence map ===

export const KEY_TO_SEQUENCE: Record<string, Buffer> = {
  ...FKEY_SEQUENCES,
  ...ARROW_SEQUENCES,
  ENTER: Buffer.from([CTRL.CR]),
  TAB: Buffer.from([CTRL.HT]),
  BACKSPACE: Buffer.from([CTRL.BS]),
  DELETE: Buffer.from([CTRL.DEL]),
};

// === Reverse lookup: sequence second byte → function key name (for F-keys only) ===

export const FKEY_BYTE_TO_NAME: Record<number, string> = {};
for (const [name, seq] of Object.entries(FKEY_SEQUENCES)) {
  FKEY_BYTE_TO_NAME[seq[1]] = name;
}
