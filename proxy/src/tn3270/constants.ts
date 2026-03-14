// === Telnet Constants (shared with TN5250) ===
export { TELNET } from '../tn5250/constants.js';
import { TELNET } from '../tn5250/constants.js';

// === 3270 Command Codes ===
export const CMD3270 = {
  WRITE: 0xF1,                    // Write
  ERASE_WRITE: 0xF5,             // Erase/Write
  ERASE_WRITE_ALTERNATE: 0x7E,   // Erase/Write Alternate
  READ_BUFFER: 0xF2,             // Read Buffer
  READ_MODIFIED: 0xF6,           // Read Modified
  READ_MODIFIED_ALL: 0x6E,       // Read Modified All
  ERASE_ALL_UNPROTECTED: 0x6F,   // Erase All Unprotected
  WRITE_STRUCTURED_FIELD: 0xF3,  // Write Structured Field

  // SNA variants (without 0x40 bit set)
  SNA_WRITE: 0x01,
  SNA_ERASE_WRITE: 0x05,
  SNA_ERASE_WRITE_ALTERNATE: 0x0D,
  SNA_READ_BUFFER: 0x02,
  SNA_READ_MODIFIED: 0x06,
  SNA_READ_MODIFIED_ALL: 0x0E,
  SNA_ERASE_ALL_UNPROTECTED: 0x0F,
} as const;

// === 3270 Order Codes ===
export const ORDER3270 = {
  SBA: 0x11,    // Set Buffer Address
  SF: 0x1D,     // Start Field
  SFE: 0x29,    // Start Field Extended
  SA: 0x28,     // Set Attribute
  MF: 0x2C,     // Modify Field
  IC: 0x13,     // Insert Cursor
  PT: 0x05,     // Program Tab
  RA: 0x3C,     // Repeat to Address
  EUA: 0x12,    // Erase Unprotected to Address
  GE: 0x08,     // Graphic Escape
} as const;

// === WCC (Write Control Character) bits ===
export const WCC = {
  RESET_MDT: 0x02,           // Reset Modified Data Tags
  RESET_KEYBOARD: 0x40,      // Reset keyboard lock
  SOUND_ALARM: 0x04,         // Sound audible alarm
  RESET_PARTITION: 0x01,     // Reset partition characteristics
  START_PRINTER: 0x08,       // Start printer
} as const;

// === 3270 AID (Attention Identifier) bytes ===
export const AID3270 = {
  ENTER: 0x7D,
  PF1: 0xF1,  PF2: 0xF2,  PF3: 0xF3,  PF4: 0xF4,
  PF5: 0xF5,  PF6: 0xF6,  PF7: 0xF7,  PF8: 0xF8,
  PF9: 0xF9,  PF10: 0x7A, PF11: 0x7B, PF12: 0x7C,
  PF13: 0xC1, PF14: 0xC2, PF15: 0xC3, PF16: 0xC4,
  PF17: 0xC5, PF18: 0xC6, PF19: 0xC7, PF20: 0xC8,
  PF21: 0xC9, PF22: 0x4A, PF23: 0x4B, PF24: 0x4C,
  PA1: 0x6C,
  PA2: 0x6E,
  PA3: 0x6B,
  CLEAR: 0x6D,
  STRUCTURED_FIELD: 0x88,
  NO_AID: 0x60,
} as const;

// Map key names (from frontend) to AID bytes
export const KEY_TO_AID3270: Record<string, number> = {
  'Enter': AID3270.ENTER,
  'F1': AID3270.PF1,   'F2': AID3270.PF2,   'F3': AID3270.PF3,   'F4': AID3270.PF4,
  'F5': AID3270.PF5,   'F6': AID3270.PF6,   'F7': AID3270.PF7,   'F8': AID3270.PF8,
  'F9': AID3270.PF9,   'F10': AID3270.PF10, 'F11': AID3270.PF11, 'F12': AID3270.PF12,
  'F13': AID3270.PF13, 'F14': AID3270.PF14, 'F15': AID3270.PF15, 'F16': AID3270.PF16,
  'F17': AID3270.PF17, 'F18': AID3270.PF18, 'F19': AID3270.PF19, 'F20': AID3270.PF20,
  'F21': AID3270.PF21, 'F22': AID3270.PF22, 'F23': AID3270.PF23, 'F24': AID3270.PF24,
  'PA1': AID3270.PA1,
  'PA2': AID3270.PA2,
  'PA3': AID3270.PA3,
  'Clear': AID3270.CLEAR,
  'PageUp': AID3270.PF7,    // Common mapping
  'PageDown': AID3270.PF8,  // Common mapping
};

// === 3270 Field Attribute Byte ===
// Bit layout (bit 7 = MSB):
//   Bit 7: always 1 (attribute indicator, but occupies buffer position as 0x00 display)
//   Bit 6: protected (1) / unprotected (0)
//   Bit 5: numeric (1) / alphanumeric (0)
//   Bits 4-3: display - 00=normal/pen-detectable, 01=normal/pen-detectable,
//             10=high-intensity/selector-pen, 11=non-display
//   Bit 2: reserved
//   Bit 1: MDT (Modified Data Tag)
//   Bit 0: reserved
export const FIELD_ATTR = {
  PROTECTED: 0x20,      // Bit 5 in attribute byte (bit 6 of logical layout)
  NUMERIC: 0x10,        // Bit 4
  DISPLAY_MASK: 0x0C,   // Bits 3-2
  DISPLAY_NORMAL: 0x00,
  DISPLAY_NORMAL_PEN: 0x04,
  DISPLAY_HIGH: 0x08,
  DISPLAY_NON: 0x0C,
  MDT: 0x01,            // Bit 0 as stored (bit 1 of logical layout)
} as const;

// === Extended Attribute Types (for SFE/SA/MF) ===
export const EXTENDED_ATTR = {
  HIGHLIGHT: 0x41,
  COLOR: 0x42,
  CHARSET: 0x43,
  FIELD_OUTLINING: 0xC5,
  TRANSPARENCY: 0x46,
  ALL: 0x00,            // Reset all
} as const;

// Highlight values
export const HIGHLIGHT = {
  DEFAULT: 0x00,
  NORMAL: 0xF0,
  BLINK: 0xF1,
  REVERSE: 0xF2,
  UNDERSCORE: 0xF4,
} as const;

// Color values
export const COLOR = {
  DEFAULT: 0x00,
  BLUE: 0xF1,
  RED: 0xF2,
  PINK: 0xF3,
  GREEN: 0xF4,
  TURQUOISE: 0xF5,
  YELLOW: 0xF6,
  WHITE: 0xF7,
} as const;

// === 3270 Buffer Address Encoding ===
// 12-bit/14-bit/16-bit address encoding lookup table
// Each 6-bit value (0-63) maps to a specific byte value
export const ADDRESS_TABLE: number[] = [
  0x40, 0xC1, 0xC2, 0xC3, 0xC4, 0xC5, 0xC6, 0xC7,
  0xC8, 0xC9, 0x4A, 0x4B, 0x4C, 0x4D, 0x4E, 0x4F,
  0x50, 0xD1, 0xD2, 0xD3, 0xD4, 0xD5, 0xD6, 0xD7,
  0xD8, 0xD9, 0x5A, 0x5B, 0x5C, 0x5D, 0x5E, 0x5F,
  0x60, 0x61, 0xE2, 0xE3, 0xE4, 0xE5, 0xE6, 0xE7,
  0xE8, 0xE9, 0x6A, 0x6B, 0x6C, 0x6D, 0x6E, 0x6F,
  0xF0, 0xF1, 0xF2, 0xF3, 0xF4, 0xF5, 0xF6, 0xF7,
  0xF8, 0xF9, 0x7A, 0x7B, 0x7C, 0x7D, 0x7E, 0x7F,
];

// Build reverse lookup: encoded byte -> 6-bit value
export const ADDRESS_REVERSE = new Map<number, number>();
for (let i = 0; i < ADDRESS_TABLE.length; i++) {
  ADDRESS_REVERSE.set(ADDRESS_TABLE[i], i);
}

/**
 * Decode a 3270 buffer address from 2 bytes.
 * Supports 12-bit (bits 7-6 of first byte are 00) and 14-bit addressing.
 */
export function decodeBufferAddress(byte1: number, byte2: number): number {
  // Check addressing mode from high bits of first byte
  if ((byte1 & 0xC0) === 0x00) {
    // 14-bit binary address
    return ((byte1 & 0x3F) << 8) | byte2;
  } else {
    // 12-bit encoded address (standard for 24x80)
    const high = ADDRESS_REVERSE.get(byte1) ?? 0;
    const low = ADDRESS_REVERSE.get(byte2) ?? 0;
    return (high << 6) | low;
  }
}

/**
 * Encode a buffer address into 2 bytes using 12-bit encoding.
 */
export function encodeBufferAddress12(address: number): [number, number] {
  const high = (address >> 6) & 0x3F;
  const low = address & 0x3F;
  return [ADDRESS_TABLE[high], ADDRESS_TABLE[low]];
}

/**
 * Encode a buffer address into 2 bytes using 14-bit binary encoding.
 */
export function encodeBufferAddress14(address: number): [number, number] {
  return [(address >> 8) & 0x3F, address & 0xFF];
}

// === Screen Dimensions ===
export const SCREEN3270 = {
  // Model 2: 24x80 (standard)
  MODEL2_ROWS: 24,
  MODEL2_COLS: 80,
  // Model 3: 32x80
  MODEL3_ROWS: 32,
  MODEL3_COLS: 80,
  // Model 4: 43x80
  MODEL4_ROWS: 43,
  MODEL4_COLS: 80,
  // Model 5: 27x132
  MODEL5_ROWS: 27,
  MODEL5_COLS: 132,
} as const;

// Terminal type strings
export const TERMINAL_TYPE_3270 = 'IBM-3278-2';          // Model 2 (24x80)
export const TERMINAL_TYPE_3270_M3 = 'IBM-3278-3';       // Model 3 (32x80)
export const TERMINAL_TYPE_3270_M4 = 'IBM-3278-4';       // Model 4 (43x80)
export const TERMINAL_TYPE_3270_M5 = 'IBM-3278-5';       // Model 5 (27x132)
export const TERMINAL_TYPE_3270E = 'IBM-3278-2-E';       // TN3270E variant

// TN3270E option code (RFC 2355)
export const OPT_TN3270E = 0x28;

// TN3270E subnegotiation types
export const TN3270E = {
  CONNECT: 0x01,
  DEVICE_TYPE: 0x02,
  FUNCTIONS: 0x03,
  IS: 0x04,
  REASON: 0x05,
  REJECT: 0x06,
  REQUEST: 0x07,
  SEND: 0x08,

  // Function request flags
  FUNC_BIND_IMAGE: 0x00,
  FUNC_DATA_STREAM_CTL: 0x01,
  FUNC_RESPONSES: 0x02,
  FUNC_SCS_CTL_CODES: 0x03,
  FUNC_SYSREQ: 0x04,

  // Data header types (when TN3270E mode is active)
  DT_3270_DATA: 0x00,
  DT_SCS_DATA: 0x01,
  DT_RESPONSE: 0x02,
  DT_BIND_IMAGE: 0x03,
  DT_UNBIND: 0x04,
  DT_NVT_DATA: 0x05,
  DT_REQUEST: 0x06,
  DT_SSCP_LU_DATA: 0x07,
  DT_PRINT_EOJ: 0x08,

  // Response flags
  NO_RESPONSE: 0x00,
  ERROR_RESPONSE: 0x01,
  ALWAYS_RESPONSE: 0x02,
  POSITIVE_RESPONSE: 0x00,
  NEGATIVE_RESPONSE: 0x01,
} as const;
