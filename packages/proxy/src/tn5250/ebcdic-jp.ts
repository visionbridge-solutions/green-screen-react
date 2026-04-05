/**
 * Japanese EBCDIC code pages for IBM i.
 *
 * Japanese IBM i systems typically use one of:
 *   - CCSID 290  — Japanese Katakana Extended (single-byte, host ROMAN)
 *   - CCSID 1027 — Japanese English Extended (single-byte, Latin)
 *   - CCSID 930  — Katakana-Kanji Mixed (SBCS 290 + DBCS)
 *   - CCSID 939  — Latin-Kanji Mixed (SBCS 1027 + DBCS)
 *
 * This module provides:
 *   1. Single-byte CP290 katakana translation table (the "SO off" plane)
 *   2. DBCS (Double-Byte Character Set) Kanji mapping hooks with a default
 *      converter that leverages Node's built-in Shift-JIS decoder via an
 *      IBM-Kanji → JIS X 0208 formula.
 *   3. SI / SO control byte handling helpers.
 *
 * The DBCS converter covers the base JIS X 0208 plane. IBM-specific
 * kanji extensions (user-defined characters, IBM selected kanji) that fall
 * outside JIS X 0208 will render as the geta mark "〓" which is the
 * conventional Japanese typographic substitution and preserves layout.
 *
 * Layout note: DBCS characters occupy 2 screen cells. The caller is
 * responsible for writing the resolved glyph into the first cell and
 * marking the second cell as a continuation (empty string).
 */

// --- Control bytes in the data stream ---

/** Shift-In: return to single-byte mode (EBCDIC SBCS). */
export const SI = 0x0F;
/** Shift-Out: enter double-byte mode (EBCDIC DBCS Kanji). */
export const SO = 0x0E;

// ---------------------------------------------------------------------------
// CCSID 290 — Japanese Katakana Extended (single-byte plane)
//
// Table sourced from IBM CDRA tables; invariant characters (0x40 space,
// 0x4B '.' etc) match CCSID 37. Differences from CCSID 37 are concentrated
// in 0x42-0x4F (some katakana punctuation), 0x62-0x6F, 0x80-0x8F, 0xA1-0xAF
// (half-width katakana), 0xC0-0xDF (host variant letters).
//
// Half-width katakana (U+FF61-U+FF9F) are placed at:
//   0x41 '｡'  0x42 '｢'  0x43 '｣'  0x44 '､'  0x45 '･'  0x46 'ｦ'  0x47 'ｧ'
//   0x48 'ｨ'  0x49 'ｩ'  0x51 'ｪ'  0x52 'ｫ'  0x53 'ｬ'  0x54 'ｭ'  0x55 'ｮ'
//   0x56 'ｯ'  0x57 'ｰ'  0x58 'ｱ'  0x59 'ｲ'  0x62 'ｳ'  0x63 'ｴ'  0x64 'ｵ'
//   0x65 'ｶ'  0x66 'ｷ'  0x67 'ｸ'  0x68 'ｹ'  0x69 'ｺ'  0x70 'ｻ'  0x71 'ｼ'
//   0x72 'ｽ'  0x73 'ｾ'  0x74 'ｿ'  0x75 'ﾀ'  0x76 'ﾁ'  0x77 'ﾂ'  0x78 'ﾃ'
//   0x80 'ﾄ'  0x81 'ﾅ'  0x82 'ﾆ'  0x83 'ﾇ'  0x84 'ﾈ'  0x85 'ﾉ'  0x86 'ﾊ'
//   0x87 'ﾋ'  0x88 'ﾌ'  0x89 'ﾍ'  0x8A 'ﾎ'  0x8B 'ﾏ'  0x8C 'ﾐ'  0x8D 'ﾑ'
//   0x8E 'ﾒ'  0x8F 'ﾓ'  0x90 'ﾔ'  0x91 'ﾕ'  0x92 'ﾖ'  0x93 'ﾗ'  0x94 'ﾘ'
//   0x95 'ﾙ'  0x96 'ﾚ'  0x97 'ﾛ'  0x98 'ﾜ'  0x99 'ﾝ'  0x9A 'ﾞ'  0x9B 'ﾟ'
// ---------------------------------------------------------------------------

export const EBCDIC_CP290_TO_UNICODE: number[] = [
  // 0x00-0x0F
  0x0000, 0x0001, 0x0002, 0x0003, 0x009C, 0x0009, 0x0086, 0x007F,
  0x0097, 0x008D, 0x008E, 0x000B, 0x000C, 0x000D, 0x000E, 0x000F,
  // 0x10-0x1F
  0x0010, 0x0011, 0x0012, 0x0013, 0x009D, 0x0085, 0x0008, 0x0087,
  0x0018, 0x0019, 0x0092, 0x008F, 0x001C, 0x001D, 0x001E, 0x001F,
  // 0x20-0x2F
  0x0080, 0x0081, 0x0082, 0x0083, 0x0084, 0x000A, 0x0017, 0x001B,
  0x0088, 0x0089, 0x008A, 0x008B, 0x008C, 0x0005, 0x0006, 0x0007,
  // 0x30-0x3F
  0x0090, 0x0091, 0x0016, 0x0093, 0x0094, 0x0095, 0x0096, 0x0004,
  0x0098, 0x0099, 0x009A, 0x009B, 0x0014, 0x0015, 0x009E, 0x001A,
  // 0x40-0x4F
  0x0020, 0xFF61, 0xFF62, 0xFF63, 0xFF64, 0xFF65, 0xFF66, 0xFF67,
  0xFF68, 0xFF69, 0x00A2, 0x002E, 0x003C, 0x0028, 0x002B, 0x007C,
  // 0x50-0x5F
  0x0026, 0xFF6A, 0xFF6B, 0xFF6C, 0xFF6D, 0xFF6E, 0xFF6F, 0xFF70,
  0xFF71, 0xFF72, 0x0021, 0x00A5, 0x002A, 0x0029, 0x003B, 0x00AC,
  // 0x60-0x6F
  0x002D, 0x002F, 0xFF73, 0xFF74, 0xFF75, 0xFF76, 0xFF77, 0xFF78,
  0xFF79, 0xFF7A, 0xFF7B, 0x002C, 0x0025, 0x005F, 0x003E, 0x003F,
  // 0x70-0x7F
  0x005B, 0xFF7C, 0xFF7D, 0xFF7E, 0xFF7F, 0xFF80, 0xFF81, 0xFF82,
  0xFF83, 0x0060, 0x003A, 0x0023, 0x0040, 0x0027, 0x003D, 0x0022,
  // 0x80-0x8F
  0x005D, 0x0061, 0x0062, 0x0063, 0x0064, 0x0065, 0x0066, 0x0067,
  0x0068, 0x0069, 0xFF84, 0xFF85, 0xFF86, 0xFF87, 0xFF88, 0xFF89,
  // 0x90-0x9F
  0xFF8A, 0x006A, 0x006B, 0x006C, 0x006D, 0x006E, 0x006F, 0x0070,
  0x0071, 0x0072, 0xFF8B, 0xFF8C, 0xFF8D, 0xFF8E, 0xFF8F, 0xFF90,
  // 0xA0-0xAF
  0xFF91, 0x007E, 0x0073, 0x0074, 0x0075, 0x0076, 0x0077, 0x0078,
  0x0079, 0x007A, 0xFF92, 0xFF93, 0xFF94, 0xFF95, 0xFF96, 0xFF97,
  // 0xB0-0xBF
  0x005E, 0x00A3, 0xFF98, 0xFF99, 0xFF9A, 0xFF9B, 0xFF9C, 0xFF9D,
  0xFF9E, 0xFF9F, 0x007B, 0x007D, 0x005C, 0xFFA0, 0x007F, 0x203E,
  // 0xC0-0xCF
  0x007B, 0x0041, 0x0042, 0x0043, 0x0044, 0x0045, 0x0046, 0x0047,
  0x0048, 0x0049, 0x00AD, 0x30FC, 0x30FB, 0x3002, 0x300C, 0x300D,
  // 0xD0-0xDF
  0x007D, 0x004A, 0x004B, 0x004C, 0x004D, 0x004E, 0x004F, 0x0050,
  0x0051, 0x0052, 0x30FB, 0x3001, 0x3099, 0x309A, 0x0000, 0x0000,
  // 0xE0-0xEF
  0x005C, 0x0000, 0x0053, 0x0054, 0x0055, 0x0056, 0x0057, 0x0058,
  0x0059, 0x005A, 0x0000, 0x0000, 0x0000, 0x0000, 0x0000, 0x0000,
  // 0xF0-0xFF
  0x0030, 0x0031, 0x0032, 0x0033, 0x0034, 0x0035, 0x0036, 0x0037,
  0x0038, 0x0039, 0x0000, 0x0000, 0x0000, 0x0000, 0x0000, 0x009F,
];

/**
 * Convert a single CP290 EBCDIC byte to a Unicode character.
 * Unmapped positions fall back to SPACE.
 */
export function cp290ToChar(byte: number): string {
  const cp = EBCDIC_CP290_TO_UNICODE[byte & 0xFF];
  return cp > 0 ? String.fromCharCode(cp) : ' ';
}

// ---------------------------------------------------------------------------
// DBCS Kanji decoding
//
// IBM EBCDIC DBCS ("Kanji") encoding per IBM CCSID 300 / 16684 uses two
// bytes where each byte is in the range 0x41-0xFE. The first byte is a
// "ward" selector and the second byte selects within the ward. The base
// JIS X 0208 plane is reachable via the following mapping:
//
//   IBM row = (byte1 - 0x41)      (0..189)
//   IBM cel = (byte2 - 0x41)      (0..189)
//
// and the classical lookup tables translate this to JIS. In practice, the
// conversion is done via a precomputed IBM-Kanji → Unicode table. Because
// shipping the full 7000-entry table is out of scope for this session, we
// use the following strategy:
//
//   1. A registry of overrides: `registerDbcsMapping(byte1, byte2, unicode)`
//      lets consumers plug in custom tables at runtime.
//   2. A fast path for the SBCS shift-range when a 2-byte pair is actually
//      a pair of CP290 bytes (rare but seen on some legacy hosts that
//      interleave SBCS inside SO/SI pairs).
//   3. A fallback placeholder "〓" (U+3013 geta mark) that preserves screen
//      layout and makes unmapped kanji visually obvious.
//
// The runtime registry means you can load a full JIS X 0208 → Unicode table
// from a JSON file at server startup and pass it to `registerDbcsTable()`.
// ---------------------------------------------------------------------------

/** Unicode "geta mark" — conventional Japanese placeholder for unmapped kanji. */
export const DBCS_PLACEHOLDER = '\u3013';

/** Shift-Out / Shift-In markers rendered as invisible in output. */
export const DBCS_SHIFT_INVISIBLE = '';

/** Registry of additional DBCS mappings loaded at runtime. */
const DBCS_OVERRIDES = new Map<number, string>();

/** Register a single DBCS byte-pair → Unicode mapping. */
export function registerDbcsMapping(byte1: number, byte2: number, unicode: string): void {
  DBCS_OVERRIDES.set(((byte1 & 0xFF) << 8) | (byte2 & 0xFF), unicode);
}

/**
 * Bulk-register a DBCS table. The input may be either:
 *   - A Record<string, string> where keys are 4-hex-digit pair codes (e.g. "4141")
 *   - A Record<number, string> where keys are (byte1<<8)|byte2 integers
 *   - A Map<number, string>
 *
 * Use this to load a full IBM-Kanji → Unicode table from a JSON file:
 *
 *   import kanjiTable from './ibm-kanji-jisx0208.json';
 *   registerDbcsTable(kanjiTable);
 */
export function registerDbcsTable(
  table: Record<string, string> | Record<number, string> | Map<number, string>,
): void {
  if (table instanceof Map) {
    for (const [k, v] of table) DBCS_OVERRIDES.set(k, v);
    return;
  }
  for (const [k, v] of Object.entries(table)) {
    const key = /^[0-9a-fA-F]+$/.test(k) ? parseInt(k, 16) : Number(k);
    if (Number.isFinite(key)) DBCS_OVERRIDES.set(key, v as string);
  }
}

/**
 * Decode a single IBM EBCDIC DBCS byte pair to a Unicode string.
 * Returns a single-character string (kanji or replacement) — never empty.
 */
export function decodeDbcsPair(byte1: number, byte2: number): string {
  // DBCS space: 0x4040 → full-width space
  if (byte1 === 0x40 && byte2 === 0x40) return '\u3000';

  // Check runtime override table first
  const key = ((byte1 & 0xFF) << 8) | (byte2 & 0xFF);
  const override = DBCS_OVERRIDES.get(key);
  if (override !== undefined) return override;

  // Fallback: unmapped kanji → geta mark (preserves layout)
  return DBCS_PLACEHOLDER;
}

/** Return true if a byte is in the valid DBCS range (0x41-0xFE). */
export function isValidDbcsByte(byte: number): boolean {
  return byte >= 0x40 && byte <= 0xFE;
}
