import { createHash } from 'crypto';
import { DEFAULT_ROWS, DEFAULT_COLS } from './constants.js';
import type { ScreenData } from '../protocols/types.js';

/**
 * Character attributes for a single cell in the VT screen buffer.
 */
export interface CellAttrs {
  bold: boolean;
  dim: boolean;
  italic: boolean;
  underline: boolean;
  blink: boolean;
  reverse: boolean;
  hidden: boolean;
  strikethrough: boolean;
  fg: number; // 0-7 standard, 8 = default
  bg: number; // 0-7 standard, 8 = default
}

/** Create a default (reset) attribute set */
export function defaultAttrs(): CellAttrs {
  return {
    bold: false,
    dim: false,
    italic: false,
    underline: false,
    blink: false,
    reverse: false,
    hidden: false,
    strikethrough: false,
    fg: 8, // default
    bg: 8, // default
  };
}

/** Synthetic field detected from VT screen content */
export interface SyntheticField {
  row: number;
  col: number;
  length: number;
  is_input: boolean;
  is_protected: boolean;
  is_highlighted?: boolean;
  is_reverse?: boolean;
}

/**
 * VT terminal screen buffer.
 *
 * A simple character grid with per-cell attributes. No native field concept —
 * fields are detected synthetically by scanning for common patterns like
 * "Label: ____" or prompt strings.
 */
export class VTScreenBuffer {
  rows: number;
  cols: number;
  /** Character grid */
  buffer: string[];
  /** Per-cell attributes */
  attrs: CellAttrs[];
  cursorRow: number = 0;
  cursorCol: number = 0;

  /** Scroll region (top and bottom row, inclusive, 0-indexed) */
  scrollTop: number = 0;
  scrollBottom: number;

  /** Saved cursor state (DECSC / DECRC) */
  private savedCursor: { row: number; col: number; attrs: CellAttrs } | null = null;

  /** Current drawing attributes (applied to new characters) */
  currentAttrs: CellAttrs;

  /** Line-wrapping mode (DECAWM) */
  autoWrap: boolean = true;

  /** Origin mode (DECOM) — cursor addressing relative to scroll region */
  originMode: boolean = false;

  /** Pending wrap — the next printable char wraps to next line */
  pendingWrap: boolean = false;

  constructor(rows = DEFAULT_ROWS, cols = DEFAULT_COLS) {
    this.rows = rows;
    this.cols = cols;
    this.scrollBottom = rows - 1;
    const size = rows * cols;
    this.buffer = new Array(size).fill(' ');
    this.attrs = new Array(size);
    for (let i = 0; i < size; i++) {
      this.attrs[i] = defaultAttrs();
    }
    this.currentAttrs = defaultAttrs();
  }

  get size(): number {
    return this.rows * this.cols;
  }

  offset(row: number, col: number): number {
    return row * this.cols + col;
  }

  // ---------------------------------------------------------------------------
  // Character operations
  // ---------------------------------------------------------------------------

  /** Write a character at the current cursor position and advance cursor */
  writeChar(ch: string): void {
    if (this.pendingWrap) {
      if (this.autoWrap) {
        this.cursorCol = 0;
        this.lineFeed();
      }
      this.pendingWrap = false;
    }

    const off = this.offset(this.cursorRow, this.cursorCol);
    if (off >= 0 && off < this.size) {
      this.buffer[off] = ch;
      this.attrs[off] = { ...this.currentAttrs };
    }

    if (this.cursorCol < this.cols - 1) {
      this.cursorCol++;
    } else {
      // At last column — set pending wrap flag
      this.pendingWrap = true;
    }
  }

  /** Set a character at a specific position without moving cursor */
  setChar(row: number, col: number, ch: string, cellAttrs?: CellAttrs): void {
    const off = this.offset(row, col);
    if (off >= 0 && off < this.size) {
      this.buffer[off] = ch;
      if (cellAttrs) this.attrs[off] = { ...cellAttrs };
    }
  }

  getChar(row: number, col: number): string {
    const off = this.offset(row, col);
    return off >= 0 && off < this.size ? this.buffer[off] : ' ';
  }

  // ---------------------------------------------------------------------------
  // Cursor movement
  // ---------------------------------------------------------------------------

  setCursor(row: number, col: number): void {
    this.cursorRow = this.clampRow(row);
    this.cursorCol = this.clampCol(col);
    this.pendingWrap = false;
  }

  private clampRow(row: number): number {
    return Math.max(0, Math.min(this.rows - 1, row));
  }

  private clampCol(col: number): number {
    return Math.max(0, Math.min(this.cols - 1, col));
  }

  // ---------------------------------------------------------------------------
  // Line feed / scrolling
  // ---------------------------------------------------------------------------

  lineFeed(): void {
    if (this.cursorRow === this.scrollBottom) {
      this.scrollUp(1);
    } else if (this.cursorRow < this.rows - 1) {
      this.cursorRow++;
    }
  }

  reverseLineFeed(): void {
    if (this.cursorRow === this.scrollTop) {
      this.scrollDown(1);
    } else if (this.cursorRow > 0) {
      this.cursorRow--;
    }
  }

  /** Scroll the scroll region up by n lines (new blank lines at bottom) */
  scrollUp(n: number): void {
    for (let i = 0; i < n; i++) {
      for (let r = this.scrollTop; r < this.scrollBottom; r++) {
        const dstOff = r * this.cols;
        const srcOff = (r + 1) * this.cols;
        for (let c = 0; c < this.cols; c++) {
          this.buffer[dstOff + c] = this.buffer[srcOff + c];
          this.attrs[dstOff + c] = this.attrs[srcOff + c];
        }
      }
      const bottomOff = this.scrollBottom * this.cols;
      for (let c = 0; c < this.cols; c++) {
        this.buffer[bottomOff + c] = ' ';
        this.attrs[bottomOff + c] = defaultAttrs();
      }
    }
  }

  /** Scroll the scroll region down by n lines (new blank lines at top) */
  scrollDown(n: number): void {
    for (let i = 0; i < n; i++) {
      for (let r = this.scrollBottom; r > this.scrollTop; r--) {
        const dstOff = r * this.cols;
        const srcOff = (r - 1) * this.cols;
        for (let c = 0; c < this.cols; c++) {
          this.buffer[dstOff + c] = this.buffer[srcOff + c];
          this.attrs[dstOff + c] = this.attrs[srcOff + c];
        }
      }
      const topOff = this.scrollTop * this.cols;
      for (let c = 0; c < this.cols; c++) {
        this.buffer[topOff + c] = ' ';
        this.attrs[topOff + c] = defaultAttrs();
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Erase operations
  // ---------------------------------------------------------------------------

  /** ED — Erase in Display */
  eraseInDisplay(mode: number): void {
    switch (mode) {
      case 0:
        this.eraseRange(this.offset(this.cursorRow, this.cursorCol), this.size);
        break;
      case 1:
        this.eraseRange(0, this.offset(this.cursorRow, this.cursorCol) + 1);
        break;
      case 2:
      case 3:
        this.eraseRange(0, this.size);
        break;
    }
  }

  /** EL — Erase in Line */
  eraseInLine(mode: number): void {
    const rowStart = this.cursorRow * this.cols;
    switch (mode) {
      case 0:
        this.eraseRange(this.offset(this.cursorRow, this.cursorCol), rowStart + this.cols);
        break;
      case 1:
        this.eraseRange(rowStart, this.offset(this.cursorRow, this.cursorCol) + 1);
        break;
      case 2:
        this.eraseRange(rowStart, rowStart + this.cols);
        break;
    }
  }

  /** ECH — Erase Characters */
  eraseCharacters(n: number): void {
    const start = this.offset(this.cursorRow, this.cursorCol);
    const end = Math.min(start + n, this.cursorRow * this.cols + this.cols);
    this.eraseRange(start, end);
  }

  private eraseRange(start: number, end: number): void {
    for (let i = start; i < end && i < this.size; i++) {
      this.buffer[i] = ' ';
      this.attrs[i] = defaultAttrs();
    }
  }

  // ---------------------------------------------------------------------------
  // Insert / Delete lines and characters
  // ---------------------------------------------------------------------------

  /** IL — Insert n blank lines at cursor row */
  insertLines(n: number): void {
    if (this.cursorRow < this.scrollTop || this.cursorRow > this.scrollBottom) return;
    const oldTop = this.scrollTop;
    this.scrollTop = this.cursorRow;
    this.scrollDown(n);
    this.scrollTop = oldTop;
  }

  /** DL — Delete n lines at cursor row */
  deleteLines(n: number): void {
    if (this.cursorRow < this.scrollTop || this.cursorRow > this.scrollBottom) return;
    const oldTop = this.scrollTop;
    this.scrollTop = this.cursorRow;
    this.scrollUp(n);
    this.scrollTop = oldTop;
  }

  /** ICH — Insert n blank characters at cursor */
  insertCharacters(n: number): void {
    const rowOff = this.cursorRow * this.cols;
    const curOff = rowOff + this.cursorCol;
    const endOff = rowOff + this.cols;
    for (let i = endOff - 1; i >= curOff + n; i--) {
      this.buffer[i] = this.buffer[i - n];
      this.attrs[i] = this.attrs[i - n];
    }
    for (let i = curOff; i < curOff + n && i < endOff; i++) {
      this.buffer[i] = ' ';
      this.attrs[i] = defaultAttrs();
    }
  }

  /** DCH — Delete n characters at cursor */
  deleteCharacters(n: number): void {
    const rowOff = this.cursorRow * this.cols;
    const curOff = rowOff + this.cursorCol;
    const endOff = rowOff + this.cols;
    for (let i = curOff; i < endOff - n; i++) {
      this.buffer[i] = this.buffer[i + n];
      this.attrs[i] = this.attrs[i + n];
    }
    for (let i = endOff - n; i < endOff; i++) {
      this.buffer[i] = ' ';
      this.attrs[i] = defaultAttrs();
    }
  }

  // ---------------------------------------------------------------------------
  // Cursor save / restore (DECSC / DECRC)
  // ---------------------------------------------------------------------------

  saveCursor(): void {
    this.savedCursor = {
      row: this.cursorRow,
      col: this.cursorCol,
      attrs: { ...this.currentAttrs },
    };
  }

  restoreCursor(): void {
    if (this.savedCursor) {
      this.cursorRow = this.savedCursor.row;
      this.cursorCol = this.savedCursor.col;
      this.currentAttrs = { ...this.savedCursor.attrs };
      this.pendingWrap = false;
    }
  }

  // ---------------------------------------------------------------------------
  // Full reset
  // ---------------------------------------------------------------------------

  reset(): void {
    this.buffer.fill(' ');
    for (let i = 0; i < this.size; i++) {
      this.attrs[i] = defaultAttrs();
    }
    this.cursorRow = 0;
    this.cursorCol = 0;
    this.scrollTop = 0;
    this.scrollBottom = this.rows - 1;
    this.currentAttrs = defaultAttrs();
    this.autoWrap = true;
    this.originMode = false;
    this.pendingWrap = false;
    this.savedCursor = null;
  }

  // ---------------------------------------------------------------------------
  // Tab stops
  // ---------------------------------------------------------------------------

  tabForward(): void {
    const nextTab = (Math.floor(this.cursorCol / 8) + 1) * 8;
    this.cursorCol = Math.min(nextTab, this.cols - 1);
    this.pendingWrap = false;
  }

  // ---------------------------------------------------------------------------
  // Synthetic field detection
  // ---------------------------------------------------------------------------

  /**
   * Detect synthetic fields from the screen content. Best-effort heuristic —
   * VT terminals have no native field concept.
   */
  detectFields(): SyntheticField[] {
    const fields: SyntheticField[] = [];

    for (let r = 0; r < this.rows; r++) {
      const rowStart = r * this.cols;
      const line = this.buffer.slice(rowStart, rowStart + this.cols).join('');

      // Pattern 1: Underscore runs (3+ consecutive underscores)
      const underscoreRe = /_{3,}/g;
      let match: RegExpExecArray | null;
      while ((match = underscoreRe.exec(line)) !== null) {
        fields.push({
          row: r,
          col: match.index,
          length: match[0].length,
          is_input: true,
          is_protected: false,
        });
      }

      // Pattern 2: Reverse-video runs (possible input fields)
      let inReverse = false;
      let reverseStart = 0;
      for (let c = 0; c < this.cols; c++) {
        const a = this.attrs[rowStart + c];
        if (a.reverse && !inReverse) {
          inReverse = true;
          reverseStart = c;
        } else if (!a.reverse && inReverse) {
          inReverse = false;
          const len = c - reverseStart;
          if (len >= 3) {
            fields.push({
              row: r,
              col: reverseStart,
              length: len,
              is_input: true,
              is_protected: false,
              is_reverse: true,
            });
          }
        }
      }
      if (inReverse) {
        const len = this.cols - reverseStart;
        if (len >= 3) {
          fields.push({
            row: r,
            col: reverseStart,
            length: len,
            is_input: true,
            is_protected: false,
            is_reverse: true,
          });
        }
      }

      // Pattern 3: Prompt detection
      const promptRe = /\b(Username|Login|Password|User|Passwd|Account|Host|Port)\s*:\s*/gi;
      let pm: RegExpExecArray | null;
      while ((pm = promptRe.exec(line)) !== null) {
        const afterPrompt = pm.index + pm[0].length;
        const remaining = line.substring(afterPrompt);
        const inputLen = remaining.length - remaining.trimEnd().length || remaining.length;
        if (inputLen > 0) {
          fields.push({
            row: r,
            col: afterPrompt,
            length: Math.min(inputLen, this.cols - afterPrompt),
            is_input: true,
            is_protected: false,
          });
        }
      }
    }

    // Deduplicate overlapping fields
    const deduped: SyntheticField[] = [];
    for (const f of fields) {
      const overlaps = deduped.some(
        (d) =>
          d.row === f.row &&
          f.col < d.col + d.length &&
          f.col + f.length > d.col
      );
      if (!overlaps) deduped.push(f);
    }

    return deduped;
  }

  // ---------------------------------------------------------------------------
  // Serialization
  // ---------------------------------------------------------------------------

  /** Convert to the protocol-agnostic ScreenData format */
  toScreenData(): ScreenData {
    const lines: string[] = [];
    for (let r = 0; r < this.rows; r++) {
      const start = r * this.cols;
      lines.push(this.buffer.slice(start, start + this.cols).join(''));
    }
    const content = lines.join('\n');

    const fields = this.detectFields();

    const hash = createHash('md5').update(content).digest('hex').substring(0, 12);

    return {
      content,
      cursor_row: this.cursorRow,
      cursor_col: this.cursorCol,
      rows: this.rows,
      cols: this.cols,
      fields,
      screen_signature: hash,
      timestamp: new Date().toISOString(),
    };
  }
}
