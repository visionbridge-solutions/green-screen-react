import { createHash } from 'crypto';
import { SCREEN, ATTR } from './constants.js';

/** Display attribute for a single cell */
export interface CellAttr {
  halfBright: boolean;
  underline: boolean;
  blink: boolean;
  inverse: boolean;
}

const DEFAULT_ATTR: CellAttr = {
  halfBright: false,
  underline: false,
  blink: false,
  inverse: false,
};

/** Field definition derived from protected/unprotected transitions */
export interface HP6530Field {
  row: number;
  col: number;
  length: number;
  isProtected: boolean;
  modified: boolean;
}

/**
 * Screen buffer for an HP 6530 terminal.
 *
 * Characters are stored in ASCII (not EBCDIC). The screen tracks
 * protected/unprotected regions — input fields are the unprotected
 * regions between protected boundaries.
 */
export class HP6530Screen {
  rows: number;
  cols: number;

  /** Character buffer (one char per cell) */
  buffer: string[];

  /** Per-cell display attributes */
  attrs: CellAttr[];

  /** Per-cell protection state (true = protected) */
  protected: boolean[];

  /** Current cursor position */
  cursorRow: number = 0;
  cursorCol: number = 0;

  /** Current attribute state (applied to newly written characters) */
  currentAttr: CellAttr = { ...DEFAULT_ATTR };

  /** Current protection state (applied to newly written characters) */
  currentProtected: boolean = false;

  /** Derived field list */
  fields: HP6530Field[] = [];

  constructor(rows = SCREEN.ROWS, cols = SCREEN.COLS) {
    this.rows = rows;
    this.cols = cols;
    const size = rows * cols;
    this.buffer = new Array(size).fill(' ');
    this.attrs = new Array(size).fill(null).map(() => ({ ...DEFAULT_ATTR }));
    this.protected = new Array(size).fill(false);
  }

  get size(): number {
    return this.rows * this.cols;
  }

  offset(row: number, col: number): number {
    return row * this.cols + col;
  }

  toRowCol(offset: number): { row: number; col: number } {
    return {
      row: Math.floor(offset / this.cols),
      col: offset % this.cols,
    };
  }

  /** Set a character at the current cursor position and advance */
  putChar(char: string): void {
    const off = this.offset(this.cursorRow, this.cursorCol);
    if (off >= 0 && off < this.size) {
      this.buffer[off] = char;
      this.attrs[off] = { ...this.currentAttr };
      this.protected[off] = this.currentProtected;
    }
    this.advanceCursor();
  }

  /** Set a character at a specific position (no cursor advance) */
  setChar(row: number, col: number, char: string): void {
    const off = this.offset(row, col);
    if (off >= 0 && off < this.size) {
      this.buffer[off] = char;
    }
  }

  /** Get a character at a specific position */
  getChar(row: number, col: number): string {
    const off = this.offset(row, col);
    return off >= 0 && off < this.size ? this.buffer[off] : ' ';
  }

  /** Set cursor position */
  setCursor(row: number, col: number): void {
    this.cursorRow = Math.max(0, Math.min(row, this.rows - 1));
    this.cursorCol = Math.max(0, Math.min(col, this.cols - 1));
  }

  /** Advance cursor by one position, wrapping at end of line/screen */
  advanceCursor(): void {
    this.cursorCol++;
    if (this.cursorCol >= this.cols) {
      this.cursorCol = 0;
      this.cursorRow++;
      if (this.cursorRow >= this.rows) {
        this.cursorRow = 0; // wrap to top
      }
    }
  }

  /** Set current display attribute from an attribute code */
  setAttrFromCode(code: number): void {
    switch (code) {
      case ATTR.NORMAL:
        this.currentAttr = { ...DEFAULT_ATTR };
        break;
      case ATTR.HALF_BRIGHT:
        this.currentAttr = { ...DEFAULT_ATTR, halfBright: true };
        break;
      case ATTR.UNDERLINE:
        this.currentAttr = { ...DEFAULT_ATTR, underline: true };
        break;
      case ATTR.BLINK:
        this.currentAttr = { ...DEFAULT_ATTR, blink: true };
        break;
      case ATTR.INVERSE:
        this.currentAttr = { ...DEFAULT_ATTR, inverse: true };
        break;
      case ATTR.UNDERLINE_INVERSE:
        this.currentAttr = { ...DEFAULT_ATTR, underline: true, inverse: true };
        break;
    }
  }

  /** Enter protected mode */
  startProtected(): void {
    this.currentProtected = true;
  }

  /** Leave protected mode (start unprotected / input region) */
  endProtected(): void {
    this.currentProtected = false;
  }

  /** Clear from cursor to end of display */
  clearToEndOfScreen(): void {
    const start = this.offset(this.cursorRow, this.cursorCol);
    for (let i = start; i < this.size; i++) {
      this.buffer[i] = ' ';
      this.attrs[i] = { ...DEFAULT_ATTR };
      this.protected[i] = false;
    }
  }

  /** Clear from cursor to end of line */
  clearToEndOfLine(): void {
    const start = this.offset(this.cursorRow, this.cursorCol);
    const lineEnd = this.offset(this.cursorRow, this.cols - 1) + 1;
    for (let i = start; i < lineEnd && i < this.size; i++) {
      this.buffer[i] = ' ';
      this.attrs[i] = { ...DEFAULT_ATTR };
      this.protected[i] = false;
    }
  }

  /** Clear the entire screen */
  clear(): void {
    this.buffer.fill(' ');
    this.attrs = new Array(this.size).fill(null).map(() => ({ ...DEFAULT_ATTR }));
    this.protected.fill(false);
    this.fields = [];
    this.cursorRow = 0;
    this.cursorCol = 0;
    this.currentAttr = { ...DEFAULT_ATTR };
    this.currentProtected = false;
  }

  /**
   * Build the field list from protected/unprotected transitions.
   *
   * A "field" is a contiguous run of cells with the same protection state.
   * Input fields are the unprotected regions; label/output fields are protected.
   */
  buildFields(): void {
    this.fields = [];
    if (this.size === 0) return;

    let currentProt = this.protected[0];
    let startOff = 0;

    for (let off = 1; off <= this.size; off++) {
      const prot = off < this.size ? this.protected[off] : !currentProt; // force flush at end
      if (prot !== currentProt) {
        const pos = this.toRowCol(startOff);
        this.fields.push({
          row: pos.row,
          col: pos.col,
          length: off - startOff,
          isProtected: currentProt,
          modified: false,
        });
        currentProt = prot;
        startOff = off;
      }
    }
  }

  /** Get the value (text) of a field */
  getFieldValue(field: HP6530Field): string {
    const start = this.offset(field.row, field.col);
    return this.buffer.slice(start, start + field.length).join('');
  }

  /** Set the value of a field */
  setFieldValue(field: HP6530Field, value: string): void {
    const start = this.offset(field.row, field.col);
    for (let i = 0; i < field.length; i++) {
      this.buffer[start + i] = i < value.length ? value[i] : ' ';
    }
    field.modified = true;
  }

  /** Find the field containing the cursor */
  getFieldAtCursor(): HP6530Field | null {
    return this.getFieldAt(this.cursorRow, this.cursorCol);
  }

  /** Find the field containing a given position */
  getFieldAt(row: number, col: number): HP6530Field | null {
    const pos = this.offset(row, col);
    for (const field of this.fields) {
      const start = this.offset(field.row, field.col);
      if (pos >= start && pos < start + field.length) {
        return field;
      }
    }
    return null;
  }

  /** Convert screen to the ScreenData format for the frontend */
  toScreenData(): {
    content: string;
    cursor_row: number;
    cursor_col: number;
    rows: number;
    cols: number;
    fields: Array<{
      row: number;
      col: number;
      length: number;
      is_input: boolean;
      is_protected: boolean;
      is_highlighted?: boolean;
      is_reverse?: boolean;
    }>;
    screen_signature: string;
    timestamp: string;
  } {
    // Build content as newline-separated rows
    const lines: string[] = [];
    for (let r = 0; r < this.rows; r++) {
      const start = r * this.cols;
      lines.push(this.buffer.slice(start, start + this.cols).join(''));
    }
    const content = lines.join('\n');

    // Map fields to frontend format
    const fields = this.fields.map(f => {
      // Check if any cell in the field has special attributes
      const start = this.offset(f.row, f.col);
      let hasInverse = false;
      let hasHighlight = false;
      for (let i = start; i < start + f.length && i < this.size; i++) {
        if (this.attrs[i].inverse) hasInverse = true;
        if (this.attrs[i].halfBright) hasHighlight = true;
      }

      return {
        row: f.row,
        col: f.col,
        length: f.length,
        is_input: !f.isProtected,
        is_protected: f.isProtected,
        is_highlighted: hasHighlight || undefined,
        is_reverse: hasInverse || undefined,
      };
    });

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
