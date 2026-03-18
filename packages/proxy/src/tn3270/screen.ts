import { createHash } from 'crypto';
import { FA, SCREEN } from './constants.js';

export interface FieldDef3270 {
  /** Buffer address where the field attribute byte is */
  attrAddr: number;
  /** Buffer address where the field data starts (attrAddr + 1) */
  startAddr: number;
  /** Field attribute byte */
  attribute: number;
  /** Extended attributes (highlight, color, etc.) */
  extHighlight: number;
  extColor: number;
  /** Length of the field data (not including attribute byte) */
  length: number;
  /** Whether the MDT (Modified Data Tag) is set */
  modified: boolean;
}

export class ScreenBuffer3270 {
  rows: number;
  cols: number;
  /** Character buffer (EBCDIC decoded to UTF-8) */
  buffer: string[];
  /** Field attribute at each position (0 = no field attribute here) */
  attrBuffer: number[];
  /** Extended highlight per cell */
  highlightBuffer: number[];
  /** Extended color per cell */
  colorBuffer: number[];
  /** Field definitions */
  fields: FieldDef3270[] = [];
  cursorAddr: number = 0;

  /** Current buffer address for write operations */
  currentAddr: number = 0;

  constructor(rows = SCREEN.MODEL_2_ROWS, cols = SCREEN.MODEL_2_COLS) {
    this.rows = rows;
    this.cols = cols;
    const size = rows * cols;
    this.buffer = new Array(size).fill(' ');
    this.attrBuffer = new Array(size).fill(0);
    this.highlightBuffer = new Array(size).fill(0);
    this.colorBuffer = new Array(size).fill(0);
  }

  get size(): number {
    return this.rows * this.cols;
  }

  get cursorRow(): number {
    return Math.floor(this.cursorAddr / this.cols);
  }

  get cursorCol(): number {
    return this.cursorAddr % this.cols;
  }

  addrToRowCol(addr: number): { row: number; col: number } {
    return {
      row: Math.floor(addr / this.cols),
      col: addr % this.cols,
    };
  }

  rowColToAddr(row: number, col: number): number {
    return row * this.cols + col;
  }

  /** Clear entire screen */
  clear(): void {
    this.buffer.fill(' ');
    this.attrBuffer.fill(0);
    this.highlightBuffer.fill(0);
    this.colorBuffer.fill(0);
    this.fields = [];
    this.cursorAddr = 0;
    this.currentAddr = 0;
  }

  /** Clear all unprotected fields */
  clearUnprotected(): void {
    for (const field of this.fields) {
      if (!this.isProtected(field)) {
        for (let i = 0; i < field.length; i++) {
          const addr = (field.startAddr + i) % this.size;
          this.buffer[addr] = ' ';
        }
        field.modified = false;
      }
    }
  }

  /** Set character at buffer address */
  setCharAt(addr: number, char: string): void {
    const a = addr % this.size;
    this.buffer[a] = char;
  }

  /** Get character at buffer address */
  getCharAt(addr: number): string {
    return this.buffer[addr % this.size];
  }

  /** Place a field attribute at an address */
  setFieldAttribute(addr: number, attr: number): void {
    const a = addr % this.size;
    this.attrBuffer[a] = attr;
    this.buffer[a] = ' '; // attribute byte displays as space
  }

  /** Check if field is protected */
  isProtected(field: FieldDef3270): boolean {
    return (field.attribute & FA.PROTECTED) !== 0;
  }

  /** Check if field is numeric */
  isNumeric(field: FieldDef3270): boolean {
    return (field.attribute & FA.NUMERIC) !== 0;
  }

  /** Check if field is hidden (non-display) */
  isHidden(field: FieldDef3270): boolean {
    return (field.attribute & FA.DISPLAY_MASK) === FA.DISPLAY_HIDDEN;
  }

  /** Check if field is intensified */
  isIntensified(field: FieldDef3270): boolean {
    return (field.attribute & FA.DISPLAY_MASK) === FA.DISPLAY_INTENSIFIED;
  }

  /** Get the field containing the given address */
  getFieldAt(addr: number): FieldDef3270 | null {
    for (const field of this.fields) {
      const start = field.startAddr;
      const end = (start + field.length) % this.size;
      if (start <= end) {
        if (addr >= start && addr < end) return field;
      } else {
        // Field wraps around screen
        if (addr >= start || addr < end) return field;
      }
    }
    return null;
  }

  /** Get the field at cursor position */
  getFieldAtCursor(): FieldDef3270 | null {
    return this.getFieldAt(this.cursorAddr);
  }

  /** Get field value as string */
  getFieldValue(field: FieldDef3270): string {
    let value = '';
    for (let i = 0; i < field.length; i++) {
      value += this.buffer[(field.startAddr + i) % this.size];
    }
    return value;
  }

  /**
   * Rebuild field list from attribute bytes in the buffer.
   * Called after processing a write command.
   */
  rebuildFields(): void {
    this.fields = [];
    const attrPositions: number[] = [];

    // Find all field attribute positions
    for (let i = 0; i < this.size; i++) {
      if (this.attrBuffer[i] !== 0) {
        attrPositions.push(i);
      }
    }

    if (attrPositions.length === 0) return;

    // Build fields: each field goes from (attrPos + 1) to the next attrPos
    for (let i = 0; i < attrPositions.length; i++) {
      const attrAddr = attrPositions[i];
      const startAddr = (attrAddr + 1) % this.size;
      const nextAttrAddr = attrPositions[(i + 1) % attrPositions.length];

      let length: number;
      if (i + 1 < attrPositions.length) {
        length = nextAttrAddr - startAddr;
        if (length < 0) length += this.size;
      } else if (attrPositions.length > 1) {
        // Last field wraps to first attribute
        length = attrPositions[0] - startAddr;
        if (length < 0) length += this.size;
      } else {
        // Single field covers entire screen minus 1
        length = this.size - 1;
      }

      this.fields.push({
        attrAddr,
        startAddr,
        attribute: this.attrBuffer[attrAddr],
        extHighlight: 0,
        extColor: 0,
        length,
        modified: (this.attrBuffer[attrAddr] & FA.MDT) !== 0,
      });
    }
  }

  /** Convert to protocol-agnostic ScreenData for the frontend */
  toScreenData() {
    const lines: string[] = [];
    for (let r = 0; r < this.rows; r++) {
      const start = r * this.cols;
      lines.push(this.buffer.slice(start, start + this.cols).join(''));
    }
    const content = lines.join('\n');

    const fields = this.fields.map(f => {
      const { row, col } = this.addrToRowCol(f.startAddr);
      return {
        row,
        col,
        length: f.length,
        is_input: !this.isProtected(f),
        is_protected: this.isProtected(f),
        is_highlighted: this.isIntensified(f) || undefined,
        is_reverse: undefined,
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
