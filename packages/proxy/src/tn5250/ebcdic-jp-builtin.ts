/**
 * Built-in minimum IBM-Kanji (CCSID 300) → Unicode table.
 *
 * This covers the **non-Kanji** portion of the IBM host double-byte code
 * set — the rows that contain the DBCS space, full-width ASCII, Hiragana,
 * Katakana (full-width), and common CJK punctuation / symbols.
 *
 * These are the characters you see on typical IBM i Japanese system
 * screens (menu titles, field labels, error messages), which are mostly
 * rendered in hiragana/katakana rather than kanji. The full Kanji plane
 * (~7000 characters in rows 0x4F–0xFE of CCSID 300) is NOT included here
 * — register the full table separately via `registerDbcsTable()` after
 * generating it with `scripts/generate-ibm-kanji-table.mjs`.
 *
 * Layout notes (per IBM CCSID 300 mapping):
 *   Row 0x41 — CJK/IBM special symbols
 *   Row 0x42 — DBCS space + full-width ASCII 0x20-0x7E (full-width)
 *   Row 0x43 — Hiragana (あ-ん + voiced)
 *   Row 0x44 — Katakana (ア-ン + voiced)
 *   Row 0x45 — Greek (Α-Ω, α-ω)
 *   Row 0x46 — Cyrillic
 *   Row 0x47 — Box-drawing characters
 *
 * The bytes that follow row bytes are 0x41..0xFE (column selector).
 * IBM CCSID 300 tables start at column 0x41 = JIS column 1.
 *
 * Rather than hand-transcribing every entry (error-prone), this file
 * builds the mapping arithmetically from the well-known Unicode ranges
 * using the IBM → JIS column offset of (byte2 - 0x41).
 */

import { registerDbcsTable } from './ebcdic-jp.js';

/** Build a range of entries from a starting Unicode code point. */
function range(
  ibmByte1: number,
  ibmCol1: number,
  ibmCol2: number,
  startCp: number,
  skip: number[] = [],
): Record<string, string> {
  const out: Record<string, string> = {};
  let cp = startCp;
  for (let c = ibmCol1; c <= ibmCol2; c++) {
    if (skip.includes(c)) continue;
    const key = ((ibmByte1 << 8) | c).toString(16).toUpperCase().padStart(4, '0');
    try {
      out[key] = String.fromCodePoint(cp);
    } catch {
      // invalid code point — skip
    }
    cp++;
  }
  return out;
}

/** Assemble the built-in table. */
function buildBuiltinTable(): Record<string, string> {
  const t: Record<string, string> = {};

  // --- Row 0x41 — CJK symbols + IBM specials ---
  // 0x4141 — DBCS space (ideographic space U+3000)
  t['4141'] = '\u3000';
  // Common CJK punctuation (subset — most-used entries)
  // 0x4144 → 、 (U+3001)
  // 0x4145 → 。 (U+3002)
  // 0x4146 → , (U+FF0C) — overlaps but shows intent
  // 0x4149 → 「 (U+300C)
  // 0x414A → 」 (U+300D)
  // 0x4150 → ・ (U+30FB)  middle dot
  t['4144'] = '\u3001'; // 、
  t['4145'] = '\u3002'; // 。
  t['4149'] = '\u300C'; // 「
  t['414A'] = '\u300D'; // 」
  t['4150'] = '\u30FB'; // ・
  // 0x4151 → ー (U+30FC) prolonged sound mark
  t['4151'] = '\u30FC';

  // --- Row 0x42 — Full-width ASCII ---
  // IBM col 0x4A = U+FF01 '!', col 0x4B = U+FF02 '"', ... through 0x7E range.
  // Standard JIS: full-width printable ASCII is U+FF01..U+FF5E mapped to
  // JIS row 3 columns 1..94. In IBM CCSID 300, these sit at row 0x42
  // columns 0x4A..0xA7 with some gaps. Use a safe arithmetic span:
  //   byte2 0x4B..0x7F → U+FF01..U+FF35 (letters + digits + basic punct)
  // This is an approximation — load the full JSON table for perfect
  // fidelity. Covers uppercase, digits, common punctuation.
  Object.assign(t, range(0x42, 0x4B, 0x7F, 0xFF01));
  // Full-width lowercase letters span the next block
  Object.assign(t, range(0x42, 0x81, 0xA9, 0xFF36));

  // --- Row 0x43 — Hiragana ---
  // JIS row 4 col 1 = U+3041 (ぁ) through col 83 = U+3093 (ん).
  // IBM layout puts these at 0x43 columns 0x4F..0xA2 (contiguous in practice).
  // We map the exact Unicode hiragana block starting at 0x3041.
  Object.assign(t, range(0x43, 0x4F, 0x4F + (0x3093 - 0x3041), 0x3041));

  // --- Row 0x44 — Katakana (full-width) ---
  // JIS row 5 col 1 = U+30A1 (ァ) through col 86 = U+30F6 (ヶ).
  // IBM: 0x44 columns 0x4F..0xA4 approximately.
  Object.assign(t, range(0x44, 0x4F, 0x4F + (0x30F6 - 0x30A1), 0x30A1));

  // --- Row 0x45 — Greek ---
  // JIS row 6 col 1 = U+0391 (Α, uppercase Alpha) through col 24 = U+03A9 (Ω),
  // then col 33 = U+03B1 (α) through col 56 = U+03C9 (ω).
  Object.assign(t, range(0x45, 0x41, 0x58, 0x0391));
  Object.assign(t, range(0x45, 0x62, 0x79, 0x03B1));

  // --- Row 0x46 — Cyrillic ---
  // JIS row 7 col 1 = U+0410 (А) .. col 32 = U+042F (Я),
  // then col 49 = U+0430 (а) .. col 80 = U+044F (я).
  Object.assign(t, range(0x46, 0x41, 0x60, 0x0410));
  Object.assign(t, range(0x46, 0x70, 0x8F, 0x0430));

  // --- Row 0x47 — Box drawing ---
  // JIS row 8 col 1 = U+2500 (─) .. col 32 = U+253F (broadly).
  // Not all positions are assigned in JIS X 0208; we map the first 32
  // contiguous characters as a best-effort. The built-in rendering via
  // the Japanese monospace fonts listed in terminal.css aligns well.
  Object.assign(t, range(0x47, 0x41, 0x60, 0x2500));

  return t;
}

/**
 * Register the built-in minimum IBM-Kanji table with the DBCS decoder.
 * Call this once at proxy startup to get hiragana/katakana/symbol
 * rendering without shipping the full Kanji table.
 *
 * The full Kanji plane (~7000 characters) still falls back to the geta
 * mark until you register a complete table via `registerDbcsTable()`.
 *
 * Idempotent — safe to call multiple times; later entries overwrite
 * earlier ones, so calling `registerDbcsTable(fullTable)` AFTER
 * `registerBuiltinDbcsTable()` will layer the full table on top of the
 * minimum.
 */
export function registerBuiltinDbcsTable(): void {
  registerDbcsTable(buildBuiltinTable());
}
