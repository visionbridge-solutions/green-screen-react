import { ProtocolHandler } from './types.js';
import type { ScreenData, ProtocolOptions, ProtocolType, FieldValue } from './types.js';
import { TN5250Connection } from '../tn5250/connection.js';
import { ScreenBuffer, FieldDef } from '../tn5250/screen.js';
import { TN5250Parser } from '../tn5250/parser.js';
import { TN5250Encoder } from '../tn5250/encoder.js';
import { TERMINAL_TYPE, TERMINAL_TYPE_WIDE, TERMINAL_DIMENSIONS } from '../tn5250/constants.js';

/**
 * TN5250 protocol handler — implements the ProtocolHandler interface
 * for IBM i (AS/400) TN5250 terminal connections.
 */
export class TN5250Handler extends ProtocolHandler {
  readonly protocol: ProtocolType = 'tn5250';

  readonly connection: TN5250Connection;
  readonly screen: ScreenBuffer;
  readonly parser: TN5250Parser;
  readonly encoder: TN5250Encoder;

  constructor() {
    super();
    this.screen = new ScreenBuffer();
    this.connection = new TN5250Connection();
    this.parser = new TN5250Parser(this.screen);
    this.encoder = new TN5250Encoder(this.screen);

    this.connection.on('data', (record: Buffer) => this.onRecord(record));
    this.connection.on('disconnected', () => this.emit('disconnected'));
    this.connection.on('error', (err: Error) => this.emit('error', err));
  }

  get isConnected(): boolean {
    return this.connection.isConnected;
  }

  async connect(host: string, port: number, options?: ProtocolOptions): Promise<void> {
    // Resolve terminal type from options
    let termType = options?.terminalType || TERMINAL_TYPE;
    if (!options?.terminalType && options?.cols && options.cols > 80) {
      termType = TERMINAL_TYPE_WIDE;
    }

    // Resize screen buffer if dimensions differ from default
    const dims = TERMINAL_DIMENSIONS[termType] || TERMINAL_DIMENSIONS[TERMINAL_TYPE];
    if (dims.rows !== this.screen.rows || dims.cols !== this.screen.cols) {
      this.screen.resize(dims.rows, dims.cols);
    }

    // Resolve EBCDIC code page. Explicit option wins; otherwise derive from
    // the terminal type string (IBM-5555-* is the standard Japanese DBCS
    // terminal family) and fall back to CP37 for everything else.
    if (options?.codePage) {
      this.screen.codePage = options.codePage;
    } else if (/^IBM-5555/i.test(termType) || /KATAKANA/i.test(termType)) {
      this.screen.codePage = 'cp290';
    } else {
      this.screen.codePage = 'cp37';
    }

    // For Japanese sessions, register the built-in DBCS table so
    // hiragana/katakana/symbols render without further setup. A full
    // Kanji table can be layered on top via `registerDbcsTable(...)`.
    if (this.screen.codePage === 'cp290') {
      const { registerBuiltinDbcsTable } = await import('../tn5250/ebcdic-jp-builtin.js');
      registerBuiltinDbcsTable();
    }

    const connectTimeout = options?.connectTimeout as number | undefined;
    await this.connection.connect(host, port, termType, connectTimeout);
  }

  disconnect(): void {
    this.connection.disconnect();
  }

  getScreenData(): ScreenData {
    return this.screen.toScreenData();
  }

  readFieldValues(modifiedOnly: boolean = true): FieldValue[] {
    return this.screen.readFieldValues(modifiedOnly);
  }

  sendText(text: string): boolean {
    return this.encoder.insertText(text);
  }

  sendKey(keyName: string): boolean {
    // Normalize key names: frontend sends uppercase (ENTER, TAB) but
    // KEY_TO_AID uses mixed case (Enter, PageUp). Handle both.
    const normalizedKey = this.normalizeKeyName(keyName);

    // Arrow keys: local cursor movement within input fields.
    // Left/Right: move within current field, stop at field boundaries.
    // Up/Down: move to previous/next input field.
    if (normalizedKey === 'ArrowLeft' || normalizedKey === 'ArrowRight' ||
        normalizedKey === 'ArrowUp' || normalizedKey === 'ArrowDown') {
      const field = this.screen.getFieldAtCursor();
      if (!field || !this.screen.isInputField(field)) return true; // no-op outside input

      if (normalizedKey === 'ArrowLeft') {
        if (this.screen.cursorCol > field.col) {
          this.screen.cursorCol--;
        }
      } else if (normalizedKey === 'ArrowRight') {
        // Stop at end of data (last non-space char + 1), not end of field
        const fieldStart = this.screen.offset(field.row, field.col);
        let lastData = field.col;
        for (let i = 0; i < field.length; i++) {
          if (this.screen.buffer[fieldStart + i] !== ' ') lastData = field.col + i + 1;
        }
        const rightLimit = Math.min(lastData, field.col + field.length - 1);
        if (this.screen.cursorCol < rightLimit) {
          this.screen.cursorCol++;
        }
      } else {
        // Up/Down: move to prev/next input field (reuse Tab/Backtab logic)
        return this.sendKey(normalizedKey === 'ArrowUp' ? 'Backtab' : 'Tab');
      }
      return true;
    }

    // Backspace: move cursor left, delete character at new position (shift left)
    // Per lib5250 display.c:1970-1997, 1385-1389
    if (normalizedKey === 'Backspace') {
      const field = this.screen.getFieldAtCursor();
      if (!field || !this.screen.isInputField(field)) return true;
      // If at start of field, don't go further
      if (this.screen.cursorCol <= field.col) return true;
      // Move left
      this.screen.cursorCol--;
      // Delete character at cursor (shift remaining left, pad with space)
      this.deleteCharAtCursor(field);
      return true;
    }

    // Delete: delete character at cursor position (shift remaining left)
    // Per lib5250 display.c:2221-2244, dbuffer.c:693-737
    if (normalizedKey === 'Delete') {
      const field = this.screen.getFieldAtCursor();
      if (!field || !this.screen.isInputField(field)) return true;
      this.deleteCharAtCursor(field);
      return true;
    }

    // Home: move cursor to start of current input field
    if (normalizedKey === 'Home') {
      const field = this.screen.getFieldAtCursor();
      if (field && this.screen.isInputField(field)) {
        this.screen.cursorCol = field.col;
      }
      return true;
    }

    // End: move cursor to end of data in current input field
    if (normalizedKey === 'End') {
      const field = this.screen.getFieldAtCursor();
      if (field && this.screen.isInputField(field)) {
        const start = this.screen.offset(field.row, field.col);
        let lastData = field.col;
        for (let i = 0; i < field.length; i++) {
          if (this.screen.buffer[start + i] !== ' ') lastData = field.col + i + 1;
        }
        this.screen.cursorCol = Math.min(lastData, field.col + field.length - 1);
      }
      return true;
    }

    // Tab/Backtab: move cursor to next/previous input field.
    //
    // Keep only fields with a native interactive attribute byte — either
    // underscored (regular text input) or non-display (password input).
    // This matches `isVisibleInput()` in screen.ts and excludes UIM framework
    // artifact fields that are technically non-bypass but carry no visible
    // interactive attribute (e.g. the selection field at (1,2) on the main
    // menu produces "Type option number or command" error when navigated
    // into). Falls back to the last input field if nothing matches.
    //
    // IMPORTANT: password fields on IBM i sign-on screens are non-display
    // input fields by design (attribute byte lower bits = 0x07, so chars
    // don't echo). Any filter that broadly excludes non-display fields
    // will skip them on Tab and make sign-on impossible.
    //
    // Tab order: if ANY field has a non-zero `resequence` FCW (0x80xx), order
    // fields by resequence ascending (resequence=0 → spatial), matching the
    // IBM 5250 Functions Reference cursor progression rules. Otherwise fall
    // back to pure spatial order. Per lib5250 session.c:1577-1579 (which
    // stores the FCW but leaves sequencing as a FIXME).
    if (normalizedKey === 'Tab' || normalizedKey === 'Backtab') {
      const allInputs = this.screen.fields.filter(f => this.screen.isInputField(f));
      if (allInputs.length === 0) return false;

      // Determine ordering: resequence-aware if any field declares it.
      const hasResequence = allInputs.some(f => f.resequence && f.resequence > 0);
      const orderOf = (f: typeof allInputs[number]): number => {
        if (hasResequence) {
          // Resequenced fields come first in FCW order; non-resequenced
          // fields sort after them in spatial order. Spatial offset is
          // added as a tiebreaker within the same resequence value.
          const base = f.resequence && f.resequence > 0 ? f.resequence : 10000;
          return base * 1_000_000 + this.screen.offset(f.row, f.col);
        }
        return this.screen.offset(f.row, f.col);
      };
      allInputs.sort((a, b) => orderOf(a) - orderOf(b));

      // Keep fields that have a native underscore OR native non-display raw
      // attribute byte — both are legitimate interactive targets. Drops
      // UIM artifacts that have neither attribute set.
      const functional = allInputs.filter(f =>
        this.screen.hasNativeUnderscore(f) || this.screen.hasNativeNonDisplay(f)
      );
      const inputFields = functional.length > 0 ? functional
        : [allInputs[allInputs.length - 1]];

      // Find current field's index in the ordered list so we walk the
      // resequenced chain even if the cursor isn't at an exact field start.
      const cursorPos = this.screen.offset(this.screen.cursorRow, this.screen.cursorCol);
      const curIdx = inputFields.findIndex(f => {
        const start = this.screen.offset(f.row, f.col);
        return cursorPos >= start && cursorPos < start + f.length;
      });

      let target: typeof inputFields[number];
      if (normalizedKey === 'Tab') {
        target = curIdx >= 0 && curIdx + 1 < inputFields.length
          ? inputFields[curIdx + 1]
          : inputFields[0];
      } else {
        target = curIdx > 0
          ? inputFields[curIdx - 1]
          : inputFields[inputFields.length - 1];
      }
      this.screen.cursorRow = target.row;
      this.screen.cursorCol = target.col;
      return true;
    }

    // Field Exit: right-adjust field value, mark modified, advance to next field
    if (normalizedKey === 'FieldExit') {
      this.encoder.fieldExit();
      return this.sendKey('Tab');
    }

    // Reset: clear keyboard lock and restore message line (per lib5250
    // display.c:1861-1876: clearing the INHIBIT indicator restores
    // saved_msg_line). Client-side only — nothing sent to host.
    if (normalizedKey === 'Reset') {
      this.screen.keyboardLocked = false;
      if (this.screen.savedMsgLine) {
        this.screen.restoreMsgLine();
      } else {
        this.screen.clearErrorLine();
      }
      if (this.screen.savedCursorBeforeError) {
        this.screen.cursorRow = this.screen.savedCursorBeforeError.row;
        this.screen.cursorCol = this.screen.savedCursorBeforeError.col;
        this.screen.savedCursorBeforeError = null;
      }
      return true;
    }

    // Insert: toggle insert/overwrite mode (client-side only)
    if (normalizedKey === 'Insert') {
      this.screen.insertMode = !this.screen.insertMode;
      return true;
    }

    const response = this.encoder.buildAidResponse(normalizedKey);
    if (!response) return false;
    this.connection.sendRaw(response);
    return true;
  }

  /**
   * Delete character at current cursor position within a field.
   * Shifts all characters to the right of cursor one position left.
   * Pads the end of the field with a space. Marks field as modified.
   * Per lib5250 dbuffer.c:693-737 (dbuffer_del).
   */
  private deleteCharAtCursor(field: FieldDef): void {
    const fieldStart = this.screen.offset(field.row, field.col);
    const fieldEnd = fieldStart + field.length;
    const cursorAddr = this.screen.offset(this.screen.cursorRow, this.screen.cursorCol);

    // Shift characters left from cursor+1 to end of field
    for (let i = cursorAddr; i < fieldEnd - 1; i++) {
      this.screen.buffer[i] = this.screen.buffer[i + 1];
    }
    // Pad last position with space
    this.screen.buffer[fieldEnd - 1] = ' ';
    field.modified = true;
  }

  private normalizeKeyName(key: string): string {
    const map: Record<string, string> = {
      'ENTER': 'Enter', 'TAB': 'Tab', 'BACKTAB': 'Backtab',
      'PAGEUP': 'PageUp', 'PAGEDOWN': 'PageDown',
      'BACKSPACE': 'Backspace', 'DELETE': 'Delete',
      'CLEAR': 'Clear', 'HELP': 'Help', 'PRINT': 'Print',
      'UP': 'ArrowUp', 'DOWN': 'ArrowDown', 'LEFT': 'ArrowLeft', 'RIGHT': 'ArrowRight',
      'HOME': 'Home', 'END': 'End', 'INSERT': 'Insert',
      'RESET': 'Reset',
      'FIELD_EXIT': 'FieldExit', 'FIELDEXIT': 'FieldExit',
    };
    return map[key] || key;
  }

  /**
   * Fill the first two input fields (username, password) and press Enter.
   * Replicates the exact same operations as manual typing:
   * cursor → field 0 start, insertText(username), cursor → field 1 start,
   * insertText(password), buildAidResponse('Enter'), sendRaw.
   */
  autoSignIn(username: string, password: string): boolean {
    // Find the username field (UNDERSCORE attribute = visible input) and
    // password field (NON_DISPLAY attribute = hidden input). This avoids
    // picking up non-visible input fields (ffw1=0x40, attr=NORMAL) that
    // some screens define but aren't part of the sign-on form.
    const ATTR_UNDERSCORE = 0x24;
    const ATTR_NON_DISPLAY = 0x27;

    const sortedFields = this.screen.fields
      .filter(f => this.screen.isInputField(f))
      .sort((a, b) => this.screen.offset(a.row, a.col) - this.screen.offset(b.row, b.col));

    const userField = sortedFields.find(f => f.attribute === ATTR_UNDERSCORE);
    const pwField = sortedFields.find(f => f.attribute === ATTR_NON_DISPLAY);

    if (!userField || !pwField) return false;
    this.screen.cursorRow = userField.row;
    this.screen.cursorCol = userField.col;

    // Type username (same as manual typing via insertText)
    this.encoder.insertText(username);

    // Move cursor to password field start (same as TAB to next field)
    this.screen.cursorRow = pwField.row;
    this.screen.cursorCol = pwField.col;

    // Type password (cursor ends up at end of password in pw field)
    this.encoder.insertText(password);

    // Snapshot field values before sending — so we can restore them on the
    // confirmation screen after the host clears the buffer with CLEAR_UNIT.
    // Password (NON_DISPLAY) is saved as asterisks for masked display.
    this.saveInputFields([ATTR_NON_DISPLAY]);

    // Build and send ENTER — cursor is in the password field, matching
    // exactly what happens during manual sign-in
    const response = this.encoder.buildAidResponse('Enter');
    if (!response) return false;
    this.connection.sendRaw(response);

    // Clear the password from the buffer (the AID already captured it).
    this.screen.setFieldValue(pwField, '');

    // Reset all modified flags so stale data isn't re-sent in subsequent AIDs.
    for (const f of this.screen.fields) {
      f.modified = false;
    }

    return true;
  }

  /** Saved input field values from before the last AID was sent */
  private savedFields: Array<{ row: number; col: number; attribute: number; value: string }> = [];

  /**
   * Snapshot all input field values. Called before sending an AID so
   * the values can be restored on the next screen if the host clears them.
   */
  private saveInputFields(maskAttributes?: number[]): void {
    this.savedFields = [];
    for (const f of this.screen.fields) {
      if (!this.screen.isInputField(f) || f.length === 0) continue;
      const start = this.screen.offset(f.row, f.col);
      let value = '';
      for (let i = start; i < start + f.length; i++) {
        value += this.screen.buffer[i];
      }
      if (value.trim().length === 0) continue;
      // For masked fields (e.g. NON_DISPLAY passwords), store asterisks
      const isMasked = maskAttributes?.includes(f.attribute);
      const trimmed = value.replace(/[\s\0]+$/, '');
      this.savedFields.push({
        row: f.row,
        col: f.col,
        attribute: f.attribute,
        value: isMasked ? '*'.repeat(trimmed.length) : value,
      });
    }
  }

  /**
   * Restore saved field values into matching empty fields on the current
   * screen.  Matches by field attribute (e.g. UNDERSCORE, NON_DISPLAY)
   * so it works even if exact positions shift between screens.
   */
  restoreFields(): void {
    for (const saved of this.savedFields) {
      const field = this.screen.fields.find(
        f => this.screen.isInputField(f)
          && f.attribute === saved.attribute
          && f.length > 0
          && this.isFieldEmpty(f),
      );
      if (!field) continue;
      this.screen.cursorRow = field.row;
      this.screen.cursorCol = field.col;
      this.encoder.insertText(saved.value.substring(0, field.length));
    }
  }

  private isFieldEmpty(field: FieldDef): boolean {
    const start = this.screen.offset(field.row, field.col);
    for (let i = start; i < start + field.length; i++) {
      if (this.screen.buffer[i] !== ' ' && this.screen.buffer[i] !== '\0') return false;
    }
    return true;
  }

  /**
   * Full auto-sign-in flow: wait for sign-in fields, fill credentials,
   * submit, wait for confirmation screen, and restore field values.
   * Returns the final screen data, or null if sign-in fields weren't found.
   */
  async performAutoSignIn(username: string, password: string): Promise<ScreenData | null> {
    await this.waitForScreenWithFields(2, 5000);
    const ok = this.autoSignIn(username, password);
    if (!ok) return null;
    await this.waitForScreen(10000);
    this.restoreFields();
    return this.getScreenData();
  }

  /** Wait for the next screenChange event (or timeout with current screen). */
  private waitForScreen(timeoutMs: number): Promise<ScreenData> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => resolve(this.getScreenData()), timeoutMs);
      this.once('screenChange', (data: ScreenData) => {
        clearTimeout(timer);
        resolve(data);
      });
    });
  }

  /** Wait until the screen has at least `minFields` input fields, or timeout. */
  waitForScreenWithFields(minFields: number, timeoutMs: number): Promise<ScreenData> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => resolve(this.getScreenData()), timeoutMs);
      const check = (data: ScreenData) => {
        const inputFields = (data.fields || []).filter((f: any) => f.is_input);
        if (inputFields.length >= minFields) {
          clearTimeout(timer);
          this.removeListener('screenChange', check);
          resolve(data);
        }
      };
      // Check current state first
      const current = this.getScreenData();
      const currentInputs = (current.fields || []).filter((f: any) => f.is_input);
      if (currentInputs.length >= minFields) {
        clearTimeout(timer);
        resolve(current);
        return;
      }
      this.on('screenChange', check);
    });
  }

  /**
   * Set cursor position (for click-to-position). Validates the target is
   * inside an input field; if not, finds the nearest input field.
   * Returns true if the cursor was repositioned.
   */
  setCursor(row: number, col: number): boolean {
    // Clamp to screen bounds
    row = Math.max(0, Math.min(row, this.screen.rows - 1));
    col = Math.max(0, Math.min(col, this.screen.cols - 1));

    // Check if target is directly in an input field
    const field = this.screen.getFieldAt(row, col);
    if (field && this.screen.isInputField(field)) {
      this.screen.cursorRow = row;
      this.screen.cursorCol = col;
      return true;
    }

    // Find nearest input field (prefer same row, then closest overall)
    const inputFields = this.screen.fields.filter(f => this.screen.isInputField(f) && this.screen.hasNativeUnderscore(f));
    if (inputFields.length === 0) return false;

    const targetPos = this.screen.offset(row, col);
    let bestField: FieldDef | null = null;
    let bestDist = Infinity;

    for (const f of inputFields) {
      const fStart = this.screen.offset(f.row, f.col);
      const fEnd = fStart + f.length - 1;
      // Distance: 0 if inside, else distance to nearest edge
      const dist = targetPos < fStart ? fStart - targetPos
        : targetPos > fEnd ? targetPos - fEnd : 0;
      if (dist < bestDist) {
        bestDist = dist;
        bestField = f;
      }
    }

    if (bestField) {
      this.screen.cursorRow = bestField.row;
      this.screen.cursorCol = bestField.col;
      return true;
    }
    return false;
  }

  sendRaw(data: Buffer): void {
    this.connection.sendRaw(data);
  }

  destroy(): void {
    this.disconnect();
    this.removeAllListeners();
  }

  private onRecord(record: Buffer): void {
    const modified = this.parser.parseRecord(record);

    // Send query reply if host sent a 5250 Query WSF
    if (this.parser.pendingQueryReply) {
      this.parser.pendingQueryReply = false;
      const reply = this.encoder.buildQueryReply();
      if (reply) this.connection.sendRaw(reply);
    }

    if (modified) {
      this.parser.calculateFieldLengths();

      // If we're in a SAVE_SCREEN context but the host didn't send CREATE_WINDOW,
      // synthesize a window by overlaying the content on the saved screen.
      // Check if a real CREATE_WINDOW was used (parser sets winRowOff/winColOff).
      if (this.screen.screenStack.length > 0 && this.parser.winRowOff === 0 && this.parser.winColOff === 0) {
        this.screen.synthesizeWindow();
      }

      this.emit('screenChange', this.screen.toScreenData());
    }
  }
}
