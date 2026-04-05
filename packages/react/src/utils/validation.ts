/**
 * Client-side field validation helpers for 5250 input fields.
 *
 * These mirror the validation that a real 5250 display station performs
 * before letting the user Enter/submit. Running them in the browser avoids
 * a host round-trip for predictable errors.
 */

import type { Field } from '../adapters/types';

/**
 * Filter a single typed character against a field's 5250 shift-type.
 * Returns the character (possibly transformed, e.g. uppercased) if it is
 * allowed, or null if it should be rejected.
 *
 * Per 5250 Functions Reference:
 *   - alpha_only   — A-Z a-z , - . space
 *   - numeric_only — 0-9 + - , . space (and '+' is re-mapped by some hosts)
 *   - digits_only  — 0-9 only
 *   - signed_num   — 0-9 in all positions except the last, which accepts sign
 *   - katakana     — half-width katakana + ASCII digits (CP290 range)
 *   - ideographic  — DBCS characters only (handled separately via is_dbcs)
 * Other shift types accept anything.
 *
 * Monocase fields auto-uppercase ASCII letters.
 */
export function filterFieldChar(
  field: Field,
  ch: string,
  /** Is this character the last position in the field? (relevant for signed_num) */
  isLastPosition: boolean = false,
): string | null {
  // Monocase: convert before shift-type check so case-insensitive rules apply
  let out = ch;
  if (field.monocase) {
    out = out.toUpperCase();
  }

  const cp = out.charCodeAt(0);
  const isAsciiLetter = (cp >= 0x41 && cp <= 0x5A) || (cp >= 0x61 && cp <= 0x7A);
  const isAsciiDigit = cp >= 0x30 && cp <= 0x39;

  switch (field.shift_type) {
    case 'alpha_only': {
      if (isAsciiLetter || out === ',' || out === '-' || out === '.' || out === ' ') return out;
      return null;
    }
    case 'numeric_only': {
      if (isAsciiDigit || out === '-' || out === '+' || out === ',' || out === '.' || out === ' ') return out;
      return null;
    }
    case 'digits_only': {
      if (isAsciiDigit) return out;
      return null;
    }
    case 'signed_num': {
      // Sign nibble allowed only at the last position, digits elsewhere.
      if (isAsciiDigit) return out;
      if (isLastPosition && (out === '-' || out === '+')) return out;
      return null;
    }
    case 'katakana': {
      // Accept half-width katakana (U+FF61–U+FF9F), space, and ASCII digits.
      if ((cp >= 0xFF61 && cp <= 0xFF9F) || isAsciiDigit || out === ' ') return out;
      return null;
    }
    case 'alpha':
    case 'numeric_shift':
    case 'io':
    case undefined:
    default:
      return out;
  }
}

/**
 * Filter an entire typed string against a field's shift-type.
 * Returns the transformed string (drops rejected characters) and whether
 * any characters were rejected (so the caller can ring a visual bell).
 */
export function filterFieldInput(
  field: Field,
  input: string,
  /** Current column inside the field (0-based from field.col). */
  startOffset: number,
): { out: string; rejected: boolean } {
  let out = '';
  let rejected = false;
  for (let i = 0; i < input.length; i++) {
    const pos = startOffset + i;
    const isLast = pos === field.length - 1;
    const transformed = filterFieldChar(field, input[i], isLast);
    if (transformed === null) {
      rejected = true;
    } else {
      out += transformed;
    }
  }
  return { out, rejected };
}

/**
 * Validate a field value against the MOD10 (Luhn) self-check rule.
 * Used for credit-card numbers, account numbers, and similar fields.
 * The last digit of the value is the check digit.
 *
 * Returns true if valid or the value is empty/too short.
 */
export function validateMod10(value: string): boolean {
  const digits = value.replace(/\D/g, '');
  if (digits.length < 2) return true;

  let sum = 0;
  let alt = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let d = digits.charCodeAt(i) - 48;
    if (alt) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    alt = !alt;
  }
  return sum % 10 === 0;
}

/**
 * Validate a field value against the MOD11 self-check rule.
 * Used for ISBN-like identifiers and some account-number schemes.
 * The last digit is the check digit (X = 10 is NOT used in 5250).
 *
 * Returns true if valid or the value is empty/too short.
 */
export function validateMod11(value: string): boolean {
  const digits = value.replace(/\D/g, '');
  if (digits.length < 2) return true;

  const body = digits.slice(0, -1);
  const check = digits.charCodeAt(digits.length - 1) - 48;

  let sum = 0;
  let weight = 2;
  for (let i = body.length - 1; i >= 0; i--) {
    sum += (body.charCodeAt(i) - 48) * weight;
    weight++;
    if (weight > 7) weight = 2;
  }
  const remainder = sum % 11;
  const expected = remainder === 0 ? 0 : 11 - remainder;
  return expected === check;
}

/**
 * Return true if the code point is a DBCS (double-byte) character.
 * Covers CJK Unified Ideographs, Hiragana, Katakana (full-width),
 * Hangul, and common CJK punctuation / symbols.
 */
export function isDbcsChar(ch: string): boolean {
  const cp = ch.codePointAt(0);
  if (cp === undefined) return false;
  return (
    (cp >= 0x3000 && cp <= 0x303F) || // CJK Symbols and Punctuation
    (cp >= 0x3040 && cp <= 0x309F) || // Hiragana
    (cp >= 0x30A0 && cp <= 0x30FF) || // Katakana (full-width)
    (cp >= 0x3400 && cp <= 0x4DBF) || // CJK Unified Ideographs Ext A
    (cp >= 0x4E00 && cp <= 0x9FFF) || // CJK Unified Ideographs
    (cp >= 0xF900 && cp <= 0xFAFF) || // CJK Compatibility Ideographs
    (cp >= 0xFF00 && cp <= 0xFF60) || // Full-width ASCII
    (cp >= 0xFFE0 && cp <= 0xFFE6) || // Full-width signs
    cp >= 0x20000                      // CJK Ext B+
  );
}

/** Return true if every character in the value is DBCS (all CJK). */
export function isAllDbcs(value: string): boolean {
  if (value.length === 0) return true;
  for (const ch of value) {
    if (ch === ' ') continue;
    if (!isDbcsChar(ch)) return false;
  }
  return true;
}
