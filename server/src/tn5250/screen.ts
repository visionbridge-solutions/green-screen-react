import { createHash } from 'crypto';
import { SCREEN } from './constants.js';

export interface FieldDef {
  row: number;
  col: number;
  length: number;
  ffw1: number;        // First FFW byte
  ffw2: number;        // Second FFW byte
  fcw1: number;        // First FCW byte (0 if no FCW)
  fcw2: number;        // Second FCW byte (0 if no FCW)
  attribute: number;   // Display attribute (SA value)
  modified: boolean;
}

export class ScreenBuffer {
  rows: number;
  cols: number;
  /** Character buffer stored as UTF-8 characters */
  buffer: string[];
  /** Attribute buffer (display attribute per cell) */
  attrBuffer: number[];
  fields: FieldDef[] = [];
  cursorRow: number = 0;
  cursorCol: number = 0;

  constructor(rows = SCREEN.ROWS_24, cols = SCREEN.COLS_80) {
    this.rows = rows;
    this.cols = cols;
    const size = rows * cols;
    this.buffer = new Array(size).fill(' ');
    this.attrBuffer = new Array(size).fill(0x20); // normal
  }

  get size(): number {
    return this.rows * this.cols;
  }

  /** Convert row,col to linear offset */
  offset(row: number, col: number): number {
    return row * this.cols + col;
  }

  /** Convert linear offset to row,col */
  toRowCol(offset: number): { row: number; col: number } {
    return {
      row: Math.floor(offset / this.cols),
      col: offset % this.cols,
    };
  }

  /** Set a character at row,col */
  setChar(row: number, col: number, char: string): void {
    const off = this.offset(row, col);
    if (off >= 0 && off < this.size) {
      this.buffer[off] = char;
    }
  }

  /** Get a character at row,col */
  getChar(row: number, col: number): string {
    const off = this.offset(row, col);
    return off >= 0 && off < this.size ? this.buffer[off] : ' ';
  }

  /** Set attribute at row,col */
  setAttr(row: number, col: number, attr: number): void {
    const off = this.offset(row, col);
    if (off >= 0 && off < this.size) {
      this.attrBuffer[off] = attr;
    }
  }

  /** Set character at a linear address */
  setCharAt(addr: number, char: string): void {
    if (addr >= 0 && addr < this.size) {
      this.buffer[addr] = char;
    }
  }

  /** Set attribute at a linear address */
  setAttrAt(addr: number, attr: number): void {
    if (addr >= 0 && addr < this.size) {
      this.attrBuffer[addr] = attr;
    }
  }

  /** Clear the entire screen */
  clear(): void {
    this.buffer.fill(' ');
    this.attrBuffer.fill(0x20);
    this.fields = [];
    this.cursorRow = 0;
    this.cursorCol = 0;
  }

  /** Fill range [start, end) with a character */
  fillRange(start: number, end: number, char: string): void {
    for (let i = start; i < end && i < this.size; i++) {
      this.buffer[i] = char;
    }
  }

  /** Get the content of a field as a string */
  getFieldValue(field: FieldDef): string {
    const start = this.offset(field.row, field.col);
    return this.buffer.slice(start, start + field.length).join('');
  }

  /** Set the content of a field */
  setFieldValue(field: FieldDef, value: string): void {
    const start = this.offset(field.row, field.col);
    for (let i = 0; i < field.length; i++) {
      this.buffer[start + i] = i < value.length ? value[i] : ' ';
    }
    field.modified = true;
  }

  /** Find the field at cursor position */
  getFieldAtCursor(): FieldDef | null {
    return this.getFieldAt(this.cursorRow, this.cursorCol);
  }

  /** Find the field containing a given position */
  getFieldAt(row: number, col: number): FieldDef | null {
    const pos = this.offset(row, col);
    for (const field of this.fields) {
      const start = this.offset(field.row, field.col);
      if (pos >= start && pos < start + field.length) {
        return field;
      }
    }
    return null;
  }

  /** Whether a field is an input field (not bypass/protected) */
  isInputField(field: FieldDef): boolean {
    return (field.ffw1 & 0x20) === 0; // BYPASS bit not set
  }

  /** Whether a field is highlighted (high intensity) */
  isHighlighted(field: FieldDef): boolean {
    return field.attribute === 0x22;
  }

  /** Whether a field is reverse video */
  isReverse(field: FieldDef): boolean {
    return field.attribute === 0x21;
  }

  /** Whether a field is non-display (password) */
  isNonDisplay(field: FieldDef): boolean {
    return field.attribute === 0x27;
  }

  /** Convert screen buffer to the ScreenData format expected by the frontend */
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
    const fields = this.fields.map(f => ({
      row: f.row,
      col: f.col,
      length: f.length,
      is_input: this.isInputField(f),
      is_protected: !this.isInputField(f),
      is_highlighted: this.isHighlighted(f) || undefined,
      is_reverse: this.isReverse(f) || undefined,
    }));

    // Generate screen signature
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
