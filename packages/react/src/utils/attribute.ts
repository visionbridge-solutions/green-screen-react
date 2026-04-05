/**
 * 5250 attribute byte decoding for the frontend.
 *
 * These helpers map raw attribute bytes from the host into CSS-friendly
 * color / decoration values. They are used for:
 *
 *   - `Field.highlight_entry_attr` (FCW 0x89xx) — replacement attribute
 *     applied when the cursor is inside the field.
 *   - `ScreenData.ext_attrs[]` — per-cell extended attributes set via WEA
 *     (Write Extended Attribute) orders.
 *
 * 5250 attribute byte layout (0x20–0x3F range):
 *   Bit 5 (0x20) is always set (marker bit).
 *   Bits 4-3 select the color group: 00=green, 01=red, 10=turq, 11=pink.
 *   Bit 2 (0x04): column separators.
 *   Bit 1 (0x02): intensity — HI shifts color group to its bright variant
 *                 (green→white, turq→yellow, pink→blue). Red stays red.
 *   Bit 0 (0x01): blink / non-display select bit within the 0x07 subfield.
 *
 * Lower 3 bits encode display type:
 *   0 normal, 1 column-separator, 2 hi-intensity, 3 col-sep + HI,
 *   4 underscore, 5 underscore + reverse, 6 underscore + HI, 7 non-display.
 */

import type { FieldColor, CellExtAttr } from '../adapters/types';

/** Decoded visual properties for a 5250 attribute byte. */
export interface DecodedAttr {
  color: FieldColor;
  highIntensity: boolean;
  underscore: boolean;
  reverse: boolean;
  blink: boolean;
  nonDisplay: boolean;
  columnSeparator: boolean;
}

/**
 * Decode a raw 5250 attribute byte (typically in 0x20–0x3F) into visual
 * properties usable for CSS rendering.
 */
export function decodeAttrByte(byte: number): DecodedAttr {
  const type = byte & 0x07;
  const colorGroup = byte & 0x18; // bits 4-3
  const highIntensity = (byte & 0x02) !== 0;

  // Color group → FieldColor
  let color: FieldColor = 'green';
  switch (colorGroup) {
    case 0x00: color = highIntensity ? 'white' : 'green'; break;
    case 0x08: color = 'red'; break; // red stays red at HI
    case 0x10: color = highIntensity ? 'yellow' : 'turquoise'; break;
    case 0x18: color = highIntensity ? 'blue' : 'pink'; break;
  }

  // Lower 3 bits encode display type
  const nonDisplay = type === 0x07;
  const underscore = type === 0x04 || type === 0x05 || type === 0x06;
  const reverse = type === 0x05; // underscore + reverse
  const columnSeparator = type === 0x01 || type === 0x03;
  const hiTypeBit = type === 0x02 || type === 0x03 || type === 0x06;

  return {
    color,
    highIntensity: highIntensity || hiTypeBit,
    underscore,
    reverse,
    blink: false, // 5250 has no base-attr blink; blink comes from WEA highlight
    nonDisplay,
    columnSeparator,
  };
}

/**
 * Decode a WEA "extended color" byte (WEA type 0x01) into a FieldColor.
 *
 * Per IBM 5250 Functions Reference the low nibble selects one of 8 base
 * colors; bit 3 (0x08) selects the "reverse image" pair (bright variant).
 *
 *   0x00  green          0x08  green (reverse)
 *   0x01  blue           0x09  blue (reverse)
 *   0x02  red            0x0A  red (reverse)
 *   0x03  pink           0x0B  pink (reverse)
 *   0x04  turquoise      0x0C  turquoise (reverse)
 *   0x05  yellow         0x0D  yellow (reverse)
 *   0x06  white          0x0E  white (reverse)
 *   0x07  default/inherit (returns undefined)
 *
 * The "reverse image" variants are the host-specified bright/alternate
 * shades; we map them to distinct FieldColor values where available so
 * the CSS layer can theme them independently.
 */
export function decodeExtColor(byte: number): FieldColor | undefined {
  switch (byte & 0x0F) {
    case 0x00: return 'green';
    case 0x01: return 'blue';
    case 0x02: return 'red';
    case 0x03: return 'pink';
    case 0x04: return 'turquoise';
    case 0x05: return 'yellow';
    case 0x06: return 'white';
    case 0x07: return undefined; // default — inherit
    // Reverse-image pairs: distinct tokens so themes can override
    case 0x08: return 'green';     // reverse green → typically same color, background flip
    case 0x09: return 'blue';
    case 0x0A: return 'red';
    case 0x0B: return 'pink';
    case 0x0C: return 'turquoise';
    case 0x0D: return 'yellow';
    case 0x0E: return 'white';
    case 0x0F: return undefined;
    default:   return undefined;
  }
}

/**
 * Return true if a WEA color byte uses the "reverse image" pair bit (0x08).
 * Callers can use this to apply a background swap in addition to `decodeExtColor`.
 */
export function extColorIsReverse(byte: number): boolean {
  const v = byte & 0x0F;
  return v >= 0x08 && v <= 0x0E;
}

/** Decoded extended-highlight properties from WEA type 0x02. */
export interface DecodedExtHighlight {
  underscore: boolean;
  reverse: boolean;
  blink: boolean;
  columnSeparator: boolean;
}

/**
 * Decode a WEA "extended highlight" byte (WEA type 0x02).
 * Bits are additive:
 *   0x01 underscore, 0x02 reverse, 0x04 blink, 0x08 column separators.
 */
export function decodeExtHighlight(byte: number): DecodedExtHighlight {
  return {
    underscore: (byte & 0x01) !== 0,
    reverse: (byte & 0x02) !== 0,
    blink: (byte & 0x04) !== 0,
    columnSeparator: (byte & 0x08) !== 0,
  };
}

/**
 * Merge a cell's extended attribute on top of a base field attribute,
 * producing the final visual properties for that specific cell.
 *
 * Absent fields in the extended attribute inherit from the base.
 */
export function mergeExtAttr(base: DecodedAttr, ext: CellExtAttr | undefined): DecodedAttr {
  if (!ext) return base;
  const out: DecodedAttr = { ...base };
  if (ext.color !== undefined) {
    const c = decodeExtColor(ext.color);
    if (c) out.color = c;
  }
  if (ext.highlight !== undefined) {
    const h = decodeExtHighlight(ext.highlight);
    if (h.underscore) out.underscore = true;
    if (h.reverse) out.reverse = true;
    if (h.blink) out.blink = true;
    if (h.columnSeparator) out.columnSeparator = true;
  }
  return out;
}

/**
 * Resolve a CSS color variable for a FieldColor using the `--gs-*` tokens.
 */
export function cssVarForColor(color: FieldColor | undefined): string {
  if (!color) return 'var(--gs-green, #10b981)';
  return `var(--gs-${color}, var(--gs-green, #10b981))`;
}
