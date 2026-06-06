/**
 * Stable semantic screen identity — scheme `sid2`.
 *
 * Anchors to DDS protocol-level field attribute bytes (FFW/FCW), NOT to
 * rendered text or field geometry. Every IBM i input field carries:
 *   - shift_type (FFW1 bits 0-2): alpha/numeric/digits_only/etc. — always present
 *   - length: protocol-mandatory for every field
 *   - mandatory_entry (FFW2 bit 3): DDS REQUIRE keyword
 *   - monocase (FFW2 bit 5): DDS MONO keyword
 *   - self_check_mod10/11 (FCW bits): DDS CHECK(ME10/ME11)
 *   - progression_id (FCW tab-sequence byte): DDS FLDORDER
 *
 * These bytes are defined in the DDS source and compiled into the display file.
 * They change only when the PROGRAMMER modifies the DDS source — they are
 * stable across field repositioning, IBM i PTFs, OS upgrades, and screen
 * text/label changes. This makes them a far more reliable identity anchor than
 * text extraction.
 *
 * The SEQUENCE of fields (sorted by DDS tab order / progression_id, then
 * row+col) encodes the logical structure of the form, which is unique to
 * each DDS record format.
 *
 * ALGORITHM (scheme `sid2`)
 * -------------------------
 *   1. If popup, work within window bounds.
 *   2. For each input (unprotected) field with row < footerCutoff, compute a
 *      token: "shift:length:mandatory:monocase:mod"
 *      where mod = "10"|"11"|"0" and shift/mandatory/monocase are normalized.
 *   3. Sort fields by progression_id (DDS tab order) if available, else row*1000+col.
 *   4. prefix = first non-space token of row 0, capped at 10 chars, lowercase
 *      (identifies the IBM i program/display file — strong IBM i convention)
 *   5. canonical = `sid2:${prefix}|${tokens.join(";")}|${rows}x${cols}`
 *   6. screen_id = sha256(canonical).hex()[:16]
 *
 * Display-only screens (no input fields): fall back to scheme `sid1` —
 * text-based hash of (normalized header + sorted labels + fkeys + dims),
 * which is the most stable text-anchored approach for read-only screens.
 *
 * The backend Python mirror is `ai/services/screen_id.py`.
 * Keep the two implementations in lockstep: bump both scheme tags together.
 *
 * PARITY VECTORS (pinned in screen-id.test.ts and test_screen_id_parity.py):
 *   sid2: fields=[(α:10:1:0:0), (N:8:0:0:0), (α:20:0:0:0)], prog="dnclaims", 24x80
 *   sid1: (display-only fallback) → same as previous sid1 test vector
 */
import { createHash } from 'crypto';
import type { Field } from 'green-screen-types';

// ── Constants ─────────────────────────────────────────────────────────────────
export const FOOTER_CUTOFF = 21;   // rows >= this are the transient F-key/status region

// ── sid2: DDS-attribute-based identity (for screens with input fields) ────────

interface FieldAttrs {
  row: number;
  col: number;
  length: number;
  is_protected: boolean;
  shift_type?: string;
  mandatory_entry?: boolean;
  monocase?: boolean;
  self_check_mod10?: boolean;
  self_check_mod11?: boolean;
  progression_id?: number;
}

function fieldToken(f: FieldAttrs): string {
  const shift    = f.shift_type ?? 'alpha';
  const mandatory = f.mandatory_entry ? '1' : '0';
  const mono     = f.monocase ? '1' : '0';
  const mod      = f.self_check_mod10 ? '10' : f.self_check_mod11 ? '11' : '0';
  return `${shift}:${f.length}:${mandatory}:${mono}:${mod}`;
}

function sortKey(f: FieldAttrs): number {
  // Prefer DDS tab order (progression_id); fall back to row/col position
  return f.progression_id != null ? f.progression_id : f.row * 1000 + f.col;
}

function programPrefix(contentLines: string[]): string {
  // IBM i convention: program/display file name occupies col 0–9 of row 0
  const row0 = contentLines[0] ?? '';
  const firstToken = row0.trim().split(/\s+/)[0] ?? '';
  return firstToken.substring(0, 10).toLowerCase();
}

function computeSid2(
  contentLines: string[],
  fields: Field[],
  effectiveRows: number,
  effectiveCols: number,
): string {
  const prefix = programPrefix(contentLines);
  const inputFields = fields
    .filter(f => !f.is_protected && f.row < FOOTER_CUTOFF)
    .sort((a, b) => sortKey(a) - sortKey(b));
  const tokens = inputFields.map(fieldToken);
  const canonical = `sid2:${prefix}|${tokens.join(';')}|${effectiveRows}x${effectiveCols}`;
  return createHash('sha256').update(canonical, 'utf8').digest('hex').substring(0, 16);
}

// ── sid1: text-based identity (fallback for display-only screens) ─────────────
// Mirrors extract_header / extract_static_labels / extract_function_keys
// from screen_signature_helpers.py.

const DYNAMIC_PATTERNS: RegExp[] = [
  /\b[A-Z]{2,4}-\d{6,}-\d{3,}\b/g,
  /\b[A-Z]{2,4}\d{8,}\b/g,
  /\d{1,2}[/-]\d{1,2}[/-]\d{2,4}/g,
  /\d{1,2}:\d{2}(:\d{2})?/g,
  /\b[A-Z]{2,}\d{4,}\b/g,
  /\b\d{6,}\b/g,
  /PAGE\s*\d+(\s*OF\s*\d+)?/gi,
  /RECORD\s*\d+(\s*OF\s*\d+)?/gi,
];

const LABEL_COLON_RE = /([A-Za-z][A-Za-z0-9 \-]{2,30}?)\s*[.]*\s*:/g;
const MENU_OPTION_RE = /(\d{1,2})[.=]\s*([A-Za-z][A-Za-z0-9 \-]{2,40})/g;
const FKEY_RE        = /F(\d{1,2})\s*=\s*([A-Za-z][A-Za-z0-9]*(?:\s(?!F\d)[A-Za-z0-9]+)*)/gi;

function stripDynamic(text: string): string {
  let out = text;
  for (const re of DYNAMIC_PATTERNS) { re.lastIndex = 0; out = out.replace(re, ''); }
  return out;
}

function extractLabels(bodyLines: string[]): string[] {
  const labels = new Set<string>();
  for (const line of bodyLines) {
    LABEL_COLON_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = LABEL_COLON_RE.exec(line)) !== null) {
      const label = m[1].trim();
      if (!/^\d+$/.test(label) && label.length > 2) labels.add(label);
    }
    MENU_OPTION_RE.lastIndex = 0;
    while ((m = MENU_OPTION_RE.exec(line)) !== null) {
      labels.add(`${m[1]}. ${m[2].trim()}`);
    }
    if (/SELECTION|CHOICE/i.test(line)) labels.add('SELECTION_LINE');
  }
  const cleaned = new Set<string>();
  for (const label of labels) {
    const stripped = stripDynamic(label).replace(/\s+/g, ' ').trim();
    if (stripped.length > 2) cleaned.add(stripped);
  }
  return Array.from(cleaned).sort().map(l => l.toLowerCase());
}

function extractFkeys(footerLines: string[]): string[] {
  const fkeys: string[] = [];
  for (const line of footerLines) {
    FKEY_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = FKEY_RE.exec(line)) !== null) {
      fkeys.push(`f${m[1]}=${m[2].trim().toLowerCase()}`);
    }
  }
  return Array.from(new Set(fkeys)).sort();
}

function computeSid1(
  contentLines: string[],
  effectiveRows: number,
  effectiveCols: number,
): string {
  const rawHeader = stripDynamic(contentLines.slice(0, 2).join(' '));
  const header    = rawHeader.replace(/\s+/g, ' ').trim().toLowerCase();
  const bodyEnd   = Math.max(2, effectiveRows - 4);
  const labels    = extractLabels(contentLines.slice(2, bodyEnd));
  const fkeys     = extractFkeys(contentLines.slice(Math.max(0, contentLines.length - 4)));
  const canonical = `sid1:${header}|${labels.join(';')}|${fkeys.join(';')}|${effectiveRows}x${effectiveCols}`;
  return createHash('sha256').update(canonical, 'utf8').digest('hex').substring(0, 16);
}

// ── Public interface ──────────────────────────────────────────────────────────

export interface WindowBounds {
  row: number;
  col: number;
  height: number;
  width: number;
}

/**
 * Compute the stable screen identity.
 *
 * Uses sid2 (DDS field attribute sequence) when input fields are present —
 * the most reliable anchor because FFW/FCW bytes are protocol-level DDS
 * definitions stable across field repositioning.
 *
 * Falls back to sid1 (normalized text: header + labels + fkeys) for
 * display-only screens with no input fields.
 *
 * @param content  `ScreenData.content` (newline-separated rendered rows)
 * @param rows     Screen height (typically 24)
 * @param cols     Screen width (typically 80)
 * @param fields   `ScreenData.fields` — carries FFW/FCW attribute bytes
 * @param window   Popup window bounds; when set, scopes to the window region
 */
export function computeScreenId(
  content: string,
  rows: number,
  cols: number,
  fields: Field[],
  window?: WindowBounds,
): string {
  let lines = content.split('\n').map(l => l.padEnd(cols).substring(0, cols));
  let scopedFields = fields;
  let effectiveRows = rows;
  let effectiveCols = cols;

  if (window) {
    lines = lines
      .slice(window.row, window.row + window.height)
      .map(l => l.substring(window.col, window.col + window.width).padEnd(window.width));
    effectiveRows  = window.height;
    effectiveCols  = window.width;
    // Scope fields to the window region
    scopedFields = fields.filter(
      f => f.row >= window.row && f.row < window.row + window.height
        && f.col >= window.col && f.col < window.col + window.width,
    ).map(f => ({ ...f, row: f.row - window.row, col: f.col - window.col }));
  }

  while (lines.length < 4) lines.push(' '.repeat(effectiveCols));

  const hasInputFields = scopedFields.some(f => !f.is_protected && f.row < FOOTER_CUTOFF);
  if (hasInputFields) {
    return computeSid2(lines, scopedFields, effectiveRows, effectiveCols);
  }
  return computeSid1(lines, effectiveRows, effectiveCols);
}
