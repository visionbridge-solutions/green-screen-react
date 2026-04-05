import { createHash } from 'crypto';
import { SCREEN } from './constants.js';
import type { EbcdicCodePage } from './ebcdic.js';
import type { ScreenData, Field, CellExtAttr } from 'green-screen-types';

/**
 * Per-cell extended attribute set from WEA (Write Extended Attribute, 0x12)
 * orders. Each component is optional and applies on top of the base field
 * attribute when rendering. 0 means "inherit from field attribute".
 *
 * Per 5250 Functions Reference, WEA types:
 *   0x01 — extended color (0x00..0x07: green/blue/red/pink/turquoise/yellow/white)
 *   0x02 — extended highlight (underscore/reverse/blink/column-sep)
 *   0x03 — character set (CGCS id)
 *   0x04 — transparency / field outlining
 */
export interface ExtAttr {
  color: number;      // extended color byte (0 = inherit)
  highlight: number;  // extended highlight byte (0 = inherit)
  charSet: number;    // character set id (0 = default)
}

interface SavedScreenState {
  buffer: string[];
  attrBuffer: number[];
  extAttrBuffer: (ExtAttr | null)[];
  dbcsCont: boolean[];
  fields: FieldDef[];
  cursorRow: number;
  cursorCol: number;
}

export interface WindowDef {
  row: number;       // 0-based top-left of border
  col: number;       // 0-based top-left of border
  height: number;    // content height (inside border)
  width: number;     // content width (inside border)
  title?: string;    // title text from Window Title/Footer minor structure
  footer?: string;   // footer text from Window Title/Footer minor structure
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
  /** Part of a continued (multi-line wrapping) field group. Per lib5250 field.h:66-70. */
  continuous?: boolean;
  /** First subfield of a continued field group (FCW 0x8601). */
  continuedFirst?: boolean;
  /** Middle subfield of a continued field group (FCW 0x8603). */
  continuedMiddle?: boolean;
  /** Last subfield of a continued field group (FCW 0x8602). */
  continuedLast?: boolean;
  /** Word-wrap enabled (FCW 0x8680). */
  wordwrap?: boolean;

  // --- FCW metadata (per lib5250 session.c:1577-1661) ---

  /** Resequence number (FCW 0x80xx) — non-zero means tab order follows this index. */
  resequence?: number;
  /** Cursor progression id (FCW 0x88xx) — alternate cursor progression target. */
  progressionId?: number;
  /** Highlight-on-entry attribute (FCW 0x89xx) — attribute byte applied when
   *  the cursor enters this field; reverts on exit. */
  highlightEntryAttr?: number;
  /** Transparency mode (FCW 0x84xx) — send bytes without EBCDIC translation. */
  transparency?: number;
  /** Pointer AID (FCW 0x8Axx) — AID byte sent on mouse click inside this field. */
  pointerAid?: number;
  /** Forward-edge trigger (FCW 0x8501) — auto-enter when cursor crosses right edge. */
  forwardEdge?: boolean;
  /** Self-check MOD10 validation required (FCW 0xB1A0). */
  selfCheckMod10?: boolean;
  /** Self-check MOD11 validation required (FCW 0xB140). */
  selfCheckMod11?: boolean;

  // --- Ideographic / DBCS FCWs (per lib5250 session.c:1597-1611) ---

  /** Ideographic-only input (FCW 0x8200) — DBCS characters only. */
  ideographicOnly?: boolean;
  /** Ideographic data type (FCW 0x8220) — DBCS data field. */
  ideographicData?: boolean;
  /** Ideographic either (FCW 0x8240) — DBCS or SBCS. */
  ideographicEither?: boolean;
  /** Ideographic open (FCW 0x8280 / 0x82C0) — DBCS with shift-in/out markers. */
  ideographicOpen?: boolean;

  // --- Peripheral input (not user-visible but preserved for completeness) ---
  magstripe?: boolean;
  lightpen?: boolean;
  magandlight?: boolean;
  lightandattn?: boolean;
}

export interface SelectionChoice {
  text: string;
  row: number;
  col: number;
}

export interface SelectionFieldDef {
  row: number;
  col: number;
  numRows: number;
  numCols: number;
  choices: SelectionChoice[];
}

/**
 * Scrollbar defined by a WDSF Define Scrollbar (0x53) structured field.
 * Per lib5250 scrollbar.h / session.c:3362-3451.
 */
export interface ScrollbarDef {
  row: number;        // 1-based screen row (per lib5250 convention)
  col: number;        // 1-based screen col
  direction: 0 | 1;   // 0 = vertical, 1 = horizontal
  rowscols: number;   // total rows/columns scrollable
  sliderpos: number;  // current slider position
  size: number;       // scrollbar size
}

export class ScreenBuffer {
  rows: number;
  cols: number;
  /** Character buffer stored as UTF-8 characters */
  buffer: string[];
  /** Attribute buffer (display attribute per cell) */
  attrBuffer: number[];
  /**
   * Extended attribute buffer (per-cell, nullable). Populated from WEA
   * orders — sparse/null when no extended attributes are set for a cell.
   */
  extAttrBuffer: (ExtAttr | null)[];
  /**
   * DBCS continuation marker: cells that hold the second half of a
   * double-byte Kanji character. The first cell holds the rendered glyph;
   * the second cell is rendered as empty but reserved for layout.
   */
  dbcsCont: boolean[];
  /** EBCDIC single-byte code page used to decode/encode character data. */
  codePage: EbcdicCodePage = 'cp37';
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
  screenStack: SavedScreenState[] = [];
  /** Active windows (for tracking; borders rendered directly into buffer) */
  windowList: WindowDef[] = [];
  /** Selection fields parsed from WDSF DEFINE_SELECTION_FIELD */
  selectionFields: SelectionFieldDef[] = [];
  /** Scrollbars parsed from WDSF DEFINE_SCROLL_BAR */
  scrollbarList: ScrollbarDef[] = [];
  /**
   * Start-of-Header data bytes from the last SOH order (per lib5250
   * dbuffer.h:66-67). Byte 3 (1-based) specifies the error message row.
   * Kept here so encoder/display can query the configured message line.
   */
  headerData: number[] = [];
  /**
   * Saved contents of the message line row, captured before
   * WRITE_ERROR_CODE painted an error message onto it. Restored on Reset
   * (when the INHIBIT indicator clears) per lib5250 display.c:1861-1876.
   */
  savedMsgLine: string[] | null = null;
  /** Row (0-based) where savedMsgLine was captured from. */
  savedMsgLineRow: number = -1;
  /**
   * Current Read command opcode — set when the host sends a Read command
   * (READ_INPUT_FIELDS, READ_MDT_FIELDS, READ_MDT_FIELDS_ALT, READ_IMMEDIATE,
   * READ_IMMEDIATE_ALT). Cleared to 0 when the client replies with an AID key.
   * Per lib5250 session.c:2353, session.c:381-433.
   */
  readOpcode: number = 0;

  constructor(rows = SCREEN.ROWS_24, cols = SCREEN.COLS_80) {
    this.rows = rows;
    this.cols = cols;
    const size = rows * cols;
    this.buffer = new Array(size).fill(' ');
    this.attrBuffer = new Array(size).fill(0x20); // normal
    this.extAttrBuffer = new Array(size).fill(null);
    this.dbcsCont = new Array(size).fill(false);
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
    this.extAttrBuffer = new Array(size).fill(null);
    this.dbcsCont = new Array(size).fill(false);
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

  /** Set (or clear) the extended attribute set at a linear address. */
  setExtAttrAt(addr: number, ext: ExtAttr | null): void {
    if (addr >= 0 && addr < this.size) {
      this.extAttrBuffer[addr] = ext;
    }
  }

  /** Clear the entire screen */
  clear(): void {
    this.buffer.fill(' ');
    this.attrBuffer.fill(0x20);
    this.extAttrBuffer.fill(null);
    this.dbcsCont.fill(false);
    this.fields = [];
    this.selectionFields = [];
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
    this.setFieldMdt(field);
  }

  /**
   * Mark a field's MDT bit. For continued subfields, propagates to the
   * "first" subfield of the group per lib5250 field.c:458-481.
   * Call this instead of `field.modified = true` directly.
   */
  setFieldMdt(field: FieldDef): void {
    if (field.continuous && !field.continuedFirst) {
      // Walk backward through the fields list to find the "first" subfield
      const idx = this.fields.indexOf(field);
      for (let i = idx - 1; i >= 0; i--) {
        const prev = this.fields[i];
        if (!prev.continuous) break;
        if (prev.continuedFirst) {
          prev.modified = true;
          return;
        }
      }
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

  /**
   * Determine which row to use as the operator error/message line.
   * Per lib5250 dbuffer.c:934-944: byte 3 of the SOH header (1-based) if
   * set, otherwise the last row.
   */
  msgLineRow(): number {
    if (this.headerData.length >= 4) {
      const l = this.headerData[3] - 1;
      if (l >= 0 && l <= this.rows - 1) return l;
    }
    return this.rows - 1;
  }

  /** Save the current contents of the message line row for later restore. */
  saveMsgLine(): void {
    const row = this.msgLineRow();
    const start = this.offset(row, 0);
    this.savedMsgLine = this.buffer.slice(start, start + this.cols);
    this.savedMsgLineRow = row;
  }

  /**
   * Restore the previously saved message line (called on Reset when the
   * keyboard unlocks after an error).
   */
  restoreMsgLine(): void {
    if (!this.savedMsgLine || this.savedMsgLineRow < 0) return;
    const start = this.offset(this.savedMsgLineRow, 0);
    for (let i = 0; i < this.cols && i < this.savedMsgLine.length; i++) {
      this.buffer[start + i] = this.savedMsgLine[i];
    }
    this.savedMsgLine = null;
    this.savedMsgLineRow = -1;
  }

  /** Whether a field has the underscore display attribute */
  isUnderscored(field: FieldDef): boolean {
    return field.attribute === 0x24;
  }

  /** Whether a field has the FFW mandatory entry flag (CHECK(ME)) */
  isMandatory(field: FieldDef): boolean {
    return (field.ffw2 & 0x08) !== 0;
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
      extAttrBuffer: this.extAttrBuffer.map(e => (e ? { ...e } : null)),
      dbcsCont: [...this.dbcsCont],
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
    this.extAttrBuffer = state.extAttrBuffer;
    this.dbcsCont = state.dbcsCont;
    this.fields = state.fields;
    this.cursorRow = state.cursorRow;
    this.cursorCol = state.cursorCol;
    return true;
  }

  /**
   * Synthesize a window when the host uses SAVE_SCREEN but no CREATE_WINDOW.
   * Detects the content area written to the cleared screen, restores the saved
   * screen as background, and overlays the content with a border.
   */
  synthesizeWindow(): void {
    if (this.screenStack.length === 0) return;

    // Find the bounding box of non-empty content in current buffer
    let minRow = this.rows, maxRow = -1, minCol = this.cols, maxCol = -1;
    for (let r = 0; r < this.rows; r++) {
      for (let c = 0; c < this.cols; c++) {
        if (this.buffer[this.offset(r, c)] !== ' ') {
          if (r < minRow) minRow = r;
          if (r > maxRow) maxRow = r;
          if (c < minCol) minCol = c;
          if (c > maxCol) maxCol = c;
        }
      }
    }
    if (maxRow < 0) return; // nothing written

    // Save the prompted command content and fields
    const contentBuf = [...this.buffer];
    const contentAttr = [...this.attrBuffer];
    const contentFields = this.fields.map(f => ({ ...f }));
    const contentCursorRow = this.cursorRow;
    const contentCursorCol = this.cursorCol;

    // Restore saved screen as background (peek, don't pop — RESTORE_SCREEN will pop)
    const saved = this.screenStack[this.screenStack.length - 1];
    this.buffer = [...saved.buffer];
    this.attrBuffer = [...saved.attrBuffer];

    // Check if there's room for borders (at least 1 cell of space on each side)
    const hasTopBorder = minRow > 0;
    const hasBotBorder = maxRow < this.rows - 1;
    const hasLeftBorder = minCol > 0;
    const hasRightBorder = maxCol < this.cols - 1;

    if (hasTopBorder || hasBotBorder || hasLeftBorder || hasRightBorder) {
      const bTop = hasTopBorder ? minRow - 1 : minRow;
      const bLeft = hasLeftBorder ? minCol - 1 : minCol;
      const bBot = hasBotBorder ? maxRow + 1 : maxRow;
      const bRight = hasRightBorder ? maxCol + 1 : maxCol;

      const setBorder = (r: number, c: number, ch: string) => {
        if (r >= 0 && r < this.rows && c >= 0 && c < this.cols) {
          const addr = this.offset(r, c);
          this.buffer[addr] = ch;
          this.attrBuffer[addr] = 0x22;
        }
      };

      // Horizontal edges
      if (hasTopBorder) for (let c = bLeft; c <= bRight; c++) setBorder(bTop, c, '.');
      if (hasBotBorder) for (let c = bLeft; c <= bRight; c++) setBorder(bBot, c, '.');

      // Vertical edges
      if (hasLeftBorder) for (let r = minRow; r <= maxRow; r++) setBorder(r, bLeft, ':');
      if (hasRightBorder) for (let r = minRow; r <= maxRow; r++) setBorder(r, bRight, ':');

      // Corners
      if (hasTopBorder && hasLeftBorder) setBorder(bTop, bLeft, '.');
      if (hasTopBorder && hasRightBorder) setBorder(bTop, bRight, '.');
      if (hasBotBorder && hasLeftBorder) setBorder(bBot, bLeft, ':');
      if (hasBotBorder && hasRightBorder) setBorder(bBot, bRight, ':');

      // Erase content area inside the border (clear saved screen artifacts)
      for (let r = minRow; r <= maxRow; r++) {
        for (let c = minCol; c <= maxCol; c++) {
          const addr = this.offset(r, c);
          this.buffer[addr] = ' ';
          this.attrBuffer[addr] = 0x20;
        }
      }
    }

    // Copy prompted command content into the area
    for (let r = minRow; r <= maxRow; r++) {
      for (let c = minCol; c <= maxCol; c++) {
        const addr = this.offset(r, c);
        this.buffer[addr] = contentBuf[addr];
        this.attrBuffer[addr] = contentAttr[addr];
      }
    }

    // Restore content fields and cursor
    this.fields = contentFields;
    this.cursorRow = contentCursorRow;
    this.cursorCol = contentCursorCol;

    // Track as a synthetic window
    this.windowList.push({
      row: Math.max(0, minRow - 1),
      col: Math.max(0, minCol - 1),
      height: maxRow - minRow + 1,
      width: maxCol - minCol + 1,
    });
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

  /** Render a window border with default characters */
  renderWindowBorder(row: number, col: number, height: number, width: number): void {
    this.renderWindowBorderCustom(row, col, height, width,
      { ul: '.', top: '.', ur: '.', left: ':', right: ':', ll: ':', bot: '.', lr: ':' },
      '', '');
  }

  /** Render a window border with custom characters and optional title/footer.
   *  Per lib5250 session.c:3129-3349. */
  renderWindowBorderCustom(
    row: number, col: number, height: number, width: number,
    chars: { ul: string; top: string; ur: string; left: string; right: string; ll: string; bot: string; lr: string },
    title: string, footer: string,
  ): void {
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
    setBorder(row, col, chars.ul);
    setBorder(row, rightCol, chars.ur);
    setBorder(botRow, col, chars.ll);
    setBorder(botRow, rightCol, chars.lr);

    // Top and bottom edges
    for (let c = col + 1; c < rightCol; c++) {
      setBorder(row, c, chars.top);
      setBorder(botRow, c, chars.bot);
    }

    // Left and right edges
    for (let r = row + 1; r < botRow; r++) {
      setBorder(r, col, chars.left);
      setBorder(r, rightCol, chars.right);
    }

    // Window title (centered on top border)
    if (title) {
      const startCol = col + 1 + Math.max(0, Math.floor((width - title.length) / 2));
      for (let i = 0; i < title.length && startCol + i < rightCol; i++) {
        setBorder(row, startCol + i, title[i]);
      }
    }

    // Window footer (centered on bottom border)
    if (footer) {
      const startCol = col + 1 + Math.max(0, Math.floor((width - footer.length) / 2));
      for (let i = 0; i < footer.length && startCol + i < rightCol; i++) {
        setBorder(botRow, startCol + i, footer[i]);
      }
    }
  }

  /**
   * Read the current value of input fields on the screen buffer. Used by
   * the proxy's /read-mdt primitive to give clients a cheap post-write
   * verification path: instead of diffing the whole screen, the client asks
   * "what's in the fields I just wrote to?"
   *
   * @param modifiedOnly — when true, only fields whose MDT bit is currently
   *   set are returned. When false, every input field (including unmodified)
   *   is returned. Protected fields are always excluded.
   */
  readFieldValues(modifiedOnly: boolean = true): import('green-screen-types').FieldValue[] {
    const out: import('green-screen-types').FieldValue[] = [];
    for (const f of this.fields) {
      if (!this.isInputField(f)) continue;
      if (modifiedOnly && !f.modified) continue;
      let value = '';
      for (let i = 0; i < f.length; i++) {
        const c = f.col + i;
        const r = f.row + Math.floor(c / this.cols);
        const cc = c % this.cols;
        value += this.getChar(r, cc);
      }
      out.push({
        row: f.row,
        col: f.col,
        length: f.length,
        value,
        modified: !!f.modified,
      });
    }
    return out;
  }

  /** Convert screen buffer to the ScreenData format expected by the frontend */
  toScreenData(): ScreenData {
    // Build content as newline-separated rows, sanitising control characters
    // and replacing 5250 indicator characters that the host sends without
    // an SA charset switch (common on pub400 and other non-GUI hosts).
    const lines: string[] = [];
    for (let r = 0; r < this.rows; r++) {
      const start = r * this.cols;
      let row = '';
      for (let c = 0; c < this.cols; c++) {
        const ch = this.buffer[start + c];
        const code = ch.charCodeAt(0);
        // Replace control characters (< 0x20) and DEL (0x7F) with space
        if (code < 0x20 || code === 0x7F || code >= 0x80 && code <= 0x9F) {
          row += ' ';
        } else {
          row += ch;
        }
      }
      lines.push(row);
    }

    // Clean up 5250 indicator artifacts in the rendered text:
    // - â/ê appearing as lone chars before "Bottom"/"More"/"Top" → replace with arrows
    // - & appearing as isolated chars (field attribute separators) → replace with space
    // - ( + ê appearing at end of indicator lines → replace with space
    let content = lines.join('\n');
    content = content.replace(/â(\s+(Bottom|More))/g, '↓$1');
    content = content.replace(/â(\s+(Top))/g, '↑$1');
    content = content.replace(/(\s)ê(\s)/g, '$1 $2');
    content = content.replace(/(\s)&(\s{2,})/g, '$1 $2');
    content = content.replace(/\(\s{2,}\+\s+ê/g, '               ');

    // Map fields to frontend format
    const fields: Field[] = this.fields.map(f => {
      const color = f.rawAttrByte ? ScreenBuffer.attrColor(f.rawAttrByte) : 'green';
      // DBCS: any ideographic FCW marks the field as DBCS-accepting.
      const isDbcs = !!(f.ideographicOnly || f.ideographicData || f.ideographicOpen);
      // Decode the shift-type (FFW1 lower 3 bits, per lib5250 field.h)
      const shiftMap: Record<number, Field['shift_type']> = {
        0x00: 'alpha',
        0x01: 'alpha_only',
        0x02: 'numeric_shift',
        0x03: 'numeric_only',
        0x04: 'katakana',
        0x05: 'digits_only',
        0x06: 'io',
        0x07: 'signed_num',
      };
      const shift_type = this.isInputField(f) ? shiftMap[f.ffw1 & 0x07] : undefined;
      const monocase = (f.ffw2 & 0x20) !== 0;
      const isInput = this.isInputField(f);
      return {
        row: f.row,
        col: f.col,
        length: f.length,
        is_input: isInput,
        is_protected: !isInput,
        is_highlighted: this.isHighlighted(f) || undefined,
        is_reverse: this.isReverse(f) || undefined,
        is_underscored: this.isUnderscored(f) || undefined,
        is_non_display: this.isNonDisplay(f) || undefined,
        color,
        highlight_entry_attr: f.highlightEntryAttr,
        resequence: f.resequence,
        progression_id: f.progressionId,
        pointer_aid: f.pointerAid,
        is_dbcs: isDbcs || undefined,
        is_dbcs_either: f.ideographicEither || undefined,
        self_check_mod10: f.selfCheckMod10,
        self_check_mod11: f.selfCheckMod11,
        shift_type,
        monocase: monocase || undefined,
        // MDT bit — only meaningful for input fields; leave undefined on
        // protected fields to keep the wire payload minimal.
        modified: isInput && f.modified ? true : undefined,
      };
    });

    // Build sparse extended-attribute map (only cells with non-null entries)
    let ext_attrs: Record<number, CellExtAttr> | undefined;
    for (let i = 0; i < this.extAttrBuffer.length; i++) {
      const e = this.extAttrBuffer[i];
      if (!e) continue;
      if (!e.color && !e.highlight && !e.charSet) continue;
      if (!ext_attrs) ext_attrs = {};
      const cell: CellExtAttr = {};
      if (e.color) cell.color = e.color;
      if (e.highlight) cell.highlight = e.highlight;
      if (e.charSet) cell.char_set = e.charSet;
      ext_attrs[i] = cell;
    }

    // DBCS continuation cells: offsets of the second half of each kanji.
    const dbcsContList: number[] = [];
    for (let i = 0; i < this.dbcsCont.length; i++) {
      if (this.dbcsCont[i]) dbcsContList.push(i);
    }
    const dbcs_cont = dbcsContList.length > 0 ? dbcsContList : undefined;

    // Generate screen signature
    const hash = createHash('md5').update(content).digest('hex').substring(0, 12);

    // Consume pending alarm (one-shot)
    const alarm = this.pendingAlarm;
    this.pendingAlarm = false;

    const windows = this.windowList.length > 0
      ? this.windowList.map(w => ({
          row: w.row,
          col: w.col,
          height: w.height,
          width: w.width,
          ...(w.title ? { title: w.title } : {}),
          ...(w.footer ? { footer: w.footer } : {}),
        }))
      : undefined;

    const selection_fields = this.selectionFields.length > 0
      ? this.selectionFields.map(sf => ({
          row: sf.row,
          col: sf.col,
          num_rows: sf.numRows,
          num_cols: sf.numCols,
          choices: sf.choices,
        }))
      : undefined;

    const screen_stack_depth = this.screenStack.length || undefined;
    const is_popup = this.screenStack.length > 0 || undefined;

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
      windows,
      selection_fields,
      screen_stack_depth,
      is_popup,
      ext_attrs,
      dbcs_cont,
      code_page: this.codePage,
    };
  }
}
