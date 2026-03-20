import { createHash } from 'crypto';
import { SCREEN } from './constants.js';

interface SavedScreenState {
  buffer: string[];
  attrBuffer: number[];
  fields: FieldDef[];
  cursorRow: number;
  cursorCol: number;
}

export interface WindowDef {
  row: number;       // 0-based top-left of border
  col: number;       // 0-based top-left of border
  height: number;    // content height (inside border)
  width: number;     // content width (inside border)
}

export interface FieldDef {
  row: number;
  col: number;
  length: number;
  ffw1: number;        // First FFW byte
  ffw2: number;        // Second FFW byte
  fcw1: number;        // First FCW byte (0 if no FCW)
  fcw2: number;        // Second FCW byte (0 if no FCW)
  attribute: number;   // Display attribute (may include SA context)
  rawAttrByte: number; // Raw 0x20–0x3F attribute byte from data stream (0 if none)
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
  /** Keyboard locked by host (X SYSTEM indicator) */
  keyboardLocked: boolean = false;
  /** Insert mode (true) vs overwrite mode (false). Default is overwrite per real 5250. */
  insertMode: boolean = false;
  /** Cursor position saved before WRITE_ERROR_CODE moved it, for Reset to restore */
  savedCursorBeforeError: { row: number; col: number } | null = null;
  /** Message waiting indicator */
  messageWaiting: boolean = false;
  /** Pending alarm/beep from CC2 */
  pendingAlarm: boolean = false;
  /** Stack of saved screen states for SAVE_SCREEN / RESTORE_SCREEN */
  private screenStack: SavedScreenState[] = [];
  /** Active windows (for tracking; borders rendered directly into buffer) */
  windowList: WindowDef[] = [];

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

  /** Resize the screen buffer, clearing all content and fields. */
  resize(rows: number, cols: number): void {
    this.rows = rows;
    this.cols = cols;
    const size = rows * cols;
    this.buffer = new Array(size).fill(' ');
    this.attrBuffer = new Array(size).fill(0x20);
    this.fields = [];
    this.cursorRow = 0;
    this.cursorCol = 0;
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

  /** Clear the error/message line (last row) */
  clearErrorLine(): void {
    const start = this.offset(this.rows - 1, 0);
    for (let i = start; i < start + this.cols; i++) {
      this.buffer[i] = ' ';
      this.attrBuffer[i] = 0x20;
    }
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

  /** Whether a field has the underscore display attribute */
  isUnderscored(field: FieldDef): boolean {
    return field.attribute === 0x24;
  }

  /** Whether an input field is visually interactive (underscored or password) */
  isVisibleInput(field: FieldDef): boolean {
    return this.isInputField(field) && (this.isUnderscored(field) || this.isNonDisplay(field));
  }

  /** Whether the field's OWN attribute byte indicates underscore (not inherited from SA context).
   *  Lower 3 bits: 4=UL, 5=UL+RI, 6=UL+HI. Excludes 7=ND. */
  hasNativeUnderscore(field: FieldDef): boolean {
    const type = field.rawAttrByte & 0x07;
    return type >= 0x04 && type < 0x07;
  }

  /** Whether the field's OWN attribute byte indicates non-display (lower 3 bits = 7). */
  hasNativeNonDisplay(field: FieldDef): boolean {
    return (field.rawAttrByte & 0x07) === 0x07;
  }

  /**
   * Decode the 5250 color from a raw field attribute byte (0x20-0x3F).
   *
   * 5250 color model:
   *   Bits 4-3 select color group, bit 1 selects intensity:
   *   | Bits 4-3 | Normal (bit1=0) | High Intensity (bit1=1) |
   *   |----------|-----------------|-------------------------|
   *   | 00 (0x20)| green           | white                   |
   *   | 01 (0x28)| red             | red                     |
   *   | 10 (0x30)| turquoise       | yellow                  |
   *   | 11 (0x38)| pink            | blue                    |
   */
  static attrColor(rawAttrByte: number): 'green' | 'white' | 'red' | 'turquoise' | 'yellow' | 'pink' | 'blue' {
    const colorGroup = rawAttrByte & 0x18; // bits 4-3
    const highIntensity = (rawAttrByte & 0x02) !== 0; // bit 1
    switch (colorGroup) {
      case 0x00: return highIntensity ? 'white' : 'green';
      case 0x08: return 'red';
      case 0x10: return highIntensity ? 'yellow' : 'turquoise';
      case 0x18: return highIntensity ? 'blue' : 'pink';
      default: return 'green';
    }
  }

  /** Save current screen state to the stack */
  saveState(): void {
    this.screenStack.push({
      buffer: [...this.buffer],
      attrBuffer: [...this.attrBuffer],
      fields: this.fields.map(f => ({ ...f })),
      cursorRow: this.cursorRow,
      cursorCol: this.cursorCol,
    });
  }

  /** Restore screen state from the stack. Returns false if stack is empty. */
  restoreState(): boolean {
    const state = this.screenStack.pop();
    if (!state) return false;
    this.buffer = state.buffer;
    this.attrBuffer = state.attrBuffer;
    this.fields = state.fields;
    this.cursorRow = state.cursorRow;
    this.cursorCol = state.cursorCol;
    return true;
  }

  /** Erase a rectangular region (inclusive bounds, 0-based) */
  eraseRegion(startRow: number, startCol: number, endRow: number, endCol: number): void {
    for (let r = startRow; r <= endRow; r++) {
      for (let c = startCol; c <= endCol; c++) {
        const addr = this.offset(r, c);
        if (addr >= 0 && addr < this.size) {
          this.buffer[addr] = ' ';
          this.attrBuffer[addr] = 0x20;
        }
      }
    }
  }

  /** Render a window border into the character buffer.
   *  (row, col) is the top-left corner of the border.
   *  Content area is (row+1, col+1) to (row+height, col+width). */
  renderWindowBorder(row: number, col: number, height: number, width: number): void {
    const botRow = row + height + 1;
    const rightCol = col + width + 1;

    const setBorder = (r: number, c: number, ch: string) => {
      if (r >= 0 && r < this.rows && c >= 0 && c < this.cols) {
        const addr = this.offset(r, c);
        this.buffer[addr] = ch;
        this.attrBuffer[addr] = 0x22; // high intensity for border
      }
    };

    // Corners
    setBorder(row, col, '.');
    setBorder(row, rightCol, '.');
    setBorder(botRow, col, ':');
    setBorder(botRow, rightCol, ':');

    // Top and bottom edges
    for (let c = col + 1; c < rightCol; c++) {
      setBorder(row, c, '.');
      setBorder(botRow, c, '.');
    }

    // Left and right edges
    for (let r = row + 1; r < botRow; r++) {
      setBorder(r, col, ':');
      setBorder(r, rightCol, ':');
    }
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
      is_underscored?: boolean;
      color?: 'green' | 'white' | 'red' | 'turquoise' | 'yellow' | 'pink' | 'blue';
    }>;
    screen_signature: string;
    timestamp: string;
    keyboard_locked?: boolean;
    message_waiting?: boolean;
    alarm?: boolean;
    insert_mode?: boolean;
  } {
    // Build content as newline-separated rows, sanitising control characters
    const lines: string[] = [];
    for (let r = 0; r < this.rows; r++) {
      const start = r * this.cols;
      let row = '';
      for (let c = 0; c < this.cols; c++) {
        const ch = this.buffer[start + c];
        const code = ch.charCodeAt(0);
        // Replace control characters (< 0x20) and DEL (0x7F) with space
        row += (code < 0x20 || code === 0x7F || code >= 0x80 && code <= 0x9F) ? ' ' : ch;
      }
      lines.push(row);
    }
    const content = lines.join('\n');

    // Map fields to frontend format
    const fields = this.fields.map(f => {
      const color = f.rawAttrByte ? ScreenBuffer.attrColor(f.rawAttrByte) : undefined;
      return {
        row: f.row,
        col: f.col,
        length: f.length,
        is_input: this.isInputField(f),
        is_protected: !this.isInputField(f),
        is_highlighted: this.isHighlighted(f) || undefined,
        is_reverse: this.isReverse(f) || undefined,
        is_underscored: this.isUnderscored(f) || undefined,
        color: color !== 'green' ? color : undefined, // only send non-default
      };
    });

    // Generate screen signature
    const hash = createHash('md5').update(content).digest('hex').substring(0, 12);

    // Consume pending alarm (one-shot)
    const alarm = this.pendingAlarm;
    this.pendingAlarm = false;

    return {
      content,
      cursor_row: this.cursorRow,
      cursor_col: this.cursorCol,
      rows: this.rows,
      cols: this.cols,
      fields,
      screen_signature: hash,
      timestamp: new Date().toISOString(),
      keyboard_locked: this.keyboardLocked || undefined,
      insert_mode: this.insertMode || undefined,
      message_waiting: this.messageWaiting || undefined,
      alarm: alarm || undefined,
    };
  }
}
