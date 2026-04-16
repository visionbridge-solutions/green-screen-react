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

    // Pass environment variables for NEW_ENVIRON negotiation.
    // DEVNAME is the IBM i display device name (per lib5250 telnetstr.c:632-664).
    const envVars: Record<string, string> = {};
    if (options?.deviceName && typeof options.deviceName === 'string') {
      envVars['DEVNAME'] = options.deviceName;
    }
    if (Object.keys(envVars).length > 0) {
      this.connection.setEnvVars(envVars);
    }

    const connectTimeout = options?.connectTimeout as number | undefined;
    await this.connection.connect(host, port, termType, connectTimeout);
  }

  disconnect(): void {
    this.connection.disconnect();
  }

  /**
   * Best-effort graceful sign-off. Types `SIGNOFF` on the screen's widest
   * input field (which is almost always the command line on IBM i menus)
   * and sends Enter, then waits briefly for the host to tear down the
   * interactive job. On a bare sign-on screen there is no command line to
   * type into — callers should only invoke this for authenticated sessions.
   * Returns true if a SIGNOFF command was sent, false if nothing was done.
   *
   * This avoids CPF1220 "device session limit reached" errors caused by
   * leaving the TN5250 TCP socket to rot: IBM i reaps the device job
   * almost immediately once it sees the host-side SIGNOFF, whereas a bare
   * TCP FIN leaves the job hanging until QDEVRCYACN picks it up.
   */
  async attemptSignOff(timeoutMs: number = 1500): Promise<boolean> {
    if (!this.connection.isConnected) return false;

    // Skip if we're on a sign-on screen. Detect structurally via field
    // attributes rather than screen text — sign-on screens across all IBM i
    // hosts (standard, PUB400, custom) share the same field layout:
    //   UNDERSCORE (0x24) input = username
    //   NON_DISPLAY (0x27) input = password
    // Post-sign-on UIM screens may have a stray NON_DISPLAY artifact field,
    // but never paired with an UNDERSCORE input field in the sign-on pattern.
    const ATTR_UNDERSCORE = 0x24;
    const ATTR_NON_DISPLAY = 0x27;
    const sortedInputs = this.screen.fields
      .filter(f => this.screen.isInputField(f))
      .sort((a, b) => this.screen.offset(a.row, a.col) - this.screen.offset(b.row, b.col));
    const hasUserField = sortedInputs.some(f => f.attribute === ATTR_UNDERSCORE);
    const hasPasswordField = sortedInputs.some(f => f.attribute === ATTR_NON_DISPLAY);
    if (hasUserField && hasPasswordField) return false;

    // Pick the widest non-password input field — on IBM i menus the
    // command line is consistently the longest input. Avoids typing
    // SIGNOFF into a small opt column or into a password field. We do
    // NOT require the field to have the UNDERSCORE attribute: many IBM i
    // panels render the command line via a colored/extended attribute
    // instead of the bare 0x24 byte, so hasNativeUnderscore() would miss
    // it.
    const inputs = this.screen.fields.filter(
      (f) => this.screen.isInputField(f) && !this.screen.hasNativeNonDisplay(f),
    );
    if (inputs.length === 0) return false;
    const target = inputs.reduce((a, b) => (b.length > a.length ? b : a));
    if (target.length < 7) return false; // "SIGNOFF" is 7 chars

    this.screen.cursorRow = target.row;
    this.screen.cursorCol = target.col;
    if (!this.encoder.insertText('SIGNOFF')) return false;

    const enterAid = this.encoder.buildAidResponse('Enter');
    if (!enterAid) return false;

    // Wait for the host's response to the SIGNOFF command. The host will
    // either send us back to a sign-on screen or close the TCP connection.
    // Either way, we've done our part once this resolves or times out.
    const done = new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, timeoutMs);
      const onDisc = () => { clearTimeout(timer); resolve(); };
      const onChange = () => { clearTimeout(timer); resolve(); };
      this.connection.once('disconnected', onDisc);
      this.once('screenChange', onChange);
    });

    this.connection.sendRaw(enterAid);
    await done;
    return true;
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

    // Arrow keys: move cursor one cell freely on the screen, with wrap at
    // edges. Matches lib5250 dbuffer.c:591-640 (dbuffer_up/down/left/right)
    // exactly — arrow keys do NOT care about fields. Typing outside a
    // non-bypass field is separately inhibited by the encoder.
    //
    // This is essential for list screens like WRKSPLF: the host defines a
    // single Opt input field at the first visible row, and the user arrows
    // down through the column to the row they want to act on. The cursor
    // position at Enter-time is what the host uses to know which row.
    if (normalizedKey === 'ArrowLeft' || normalizedKey === 'ArrowRight' ||
        normalizedKey === 'ArrowUp' || normalizedKey === 'ArrowDown') {
      const rows = this.screen.rows;
      const cols = this.screen.cols;
      if (normalizedKey === 'ArrowLeft') {
        if (--this.screen.cursorCol < 0) {
          this.screen.cursorCol = cols - 1;
          if (--this.screen.cursorRow < 0) this.screen.cursorRow = rows - 1;
        }
      } else if (normalizedKey === 'ArrowRight') {
        if (++this.screen.cursorCol >= cols) {
          this.screen.cursorCol = 0;
          if (++this.screen.cursorRow >= rows) this.screen.cursorRow = 0;
        }
      } else if (normalizedKey === 'ArrowUp') {
        if (--this.screen.cursorRow < 0) this.screen.cursorRow = rows - 1;
      } else {
        if (++this.screen.cursorRow >= rows) this.screen.cursorRow = 0;
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

    // Tab/Backtab: walk the non-bypass field list in spatial order
    // (per lib5250 display.c:2089 — set_cursor_next_logical_field / prev).
    // Resequence FCW 0x80xx overrides spatial order: fields with non-zero
    // resequence come first in resequence order, non-resequenced fields
    // follow in spatial order.
    //
    // NOTE: lib5250 does NOT filter fields by display attribute — every
    // non-bypass field is a valid tab target. Our parser's demotion pass
    // already removes UIM artifact fields (wide NON_DISPLAY on non-sign-on
    // screens) and decoration fields, so the `isInputField` check alone
    // is sufficient here.
    if (normalizedKey === 'Tab' || normalizedKey === 'Backtab') {
      const inputFields = this.screen.fields.filter(f => this.screen.isInputField(f));
      if (inputFields.length === 0) return false;

      const hasResequence = inputFields.some(f => f.resequence && f.resequence > 0);
      const orderOf = (f: FieldDef): number => {
        if (hasResequence) {
          const base = f.resequence && f.resequence > 0 ? f.resequence : 10000;
          return base * 1_000_000 + this.screen.offset(f.row, f.col);
        }
        return this.screen.offset(f.row, f.col);
      };
      inputFields.sort((a, b) => orderOf(a) - orderOf(b));

      const cursorPos = this.screen.offset(this.screen.cursorRow, this.screen.cursorCol);
      const curIdx = inputFields.findIndex(f => {
        const start = this.screen.offset(f.row, f.col);
        return cursorPos >= start && cursorPos < start + f.length;
      });

      let target: FieldDef;
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
   * Returns { screen, authenticated } — `authenticated` is true only if
   * the host accepted the credentials (no longer on the sign-on screen).
   * Returns null if the sign-on fields weren't found at all.
   */
  async performAutoSignIn(
    username: string,
    password: string,
  ): Promise<{ screen: ScreenData; authenticated: boolean } | null> {
    await this.waitForScreenWithFields(2, 5000);
    const ok = this.autoSignIn(username, password);
    if (!ok) return null;
    await this.waitForScreen(10000);
    this.restoreFields();
    let screen = this.getScreenData();

    // Success check: still on sign-on screen? Requires BOTH a NON_DISPLAY
    // password input field AND sign-on screen text. A plain NON_DISPLAY
    // check alone would mis-flag UIM artifact fields (e.g. the 1-row
    // NON_DISPLAY span at (1,2) on many post-sign-on screens).
    // Text matching is broadened beyond "Sign On" to cover hosts like
    // PUB400 ("Your user name:") and other custom sign-on displays.
    const isSignOnScreen = (s: ScreenData) => {
      const hasNonDisplay = (s.fields || []).some(f => f.is_input && f.is_non_display);
      if (!hasNonDisplay) return false;
      const text = s.content || '';
      return /Sign On/i.test(text)
          || /Your user name/i.test(text)
          || /Password\s*[\(.:]/i.test(text);
    };

    if (isSignOnScreen(screen)) {
      return { screen, authenticated: false };
    }

    // Auto-dismiss post-sign-on confirmation screens ("Sign-on
    // Information" / "Display Messages" / "Output queue waiting" / etc.)
    // until we reach a screen that exposes a usable command line — an
    // underscored input field wide enough for typical commands. This
    // guarantees that a subsequent gracefulDestroy() can type SIGNOFF and
    // actually terminate the interactive job, instead of leaving the
    // device hanging until QDEVRCYACN reaps it (which on LMTDEVSSN=*YES
    // user profiles counts against the quota → CPF1220 on next login).
    const hasCommandLine = (s: ScreenData) =>
      (s.fields || []).some(
        (f) => f.is_input && !f.is_non_display && (f.length || 0) >= 20,
      );
    for (let attempt = 0; attempt < 4 && !hasCommandLine(screen); attempt++) {
      const enterAid = this.encoder.buildAidResponse('Enter');
      if (!enterAid) break;
      this.connection.sendRaw(enterAid);
      await this.waitForScreen(5000);
      const next = this.getScreenData();
      // Bail out if the screen didn't change — we're stuck (likely an
      // error message waiting for Reset, or a prompt we don't know how to
      // answer). Don't press Enter into an unknown state.
      if ((next.content || '') === (screen.content || '')) break;
      screen = next;
      if (isSignOnScreen(screen)) {
        return { screen, authenticated: false };
      }
    }

    return { screen, authenticated: true };
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
   * Set cursor position (for click-to-position). Moves the cursor freely
   * to the requested cell, matching lib5250 dbuffer.c:485-497 behaviour —
   * no field snapping. Typing at a non-field cell is separately inhibited
   * by the encoder. Returns true always (the click landed somewhere).
   *
   * This is required for list screens like WRKSPLF: the user must be able
   * to click on any row's Opt column, even though only one SF input field
   * covers the entire list area.
   */
  setCursor(row: number, col: number): boolean {
    row = Math.max(0, Math.min(row, this.screen.rows - 1));
    col = Math.max(0, Math.min(col, this.screen.cols - 1));
    this.screen.cursorRow = row;
    this.screen.cursorCol = col;
    return true;
  }

  sendRaw(data: Buffer): void {
    this.connection.sendRaw(data);
  }

  destroy(): void {
    this.disconnect();
    this.removeAllListeners();
  }

  private onRecord(record: Buffer): void {
    const klBefore = this.screen.keyboardLocked;
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

      if (process.env.GS_DIAG_KL === '1') {
        const cmdBytes = Array.from(record.slice(0, Math.min(12, record.length)))
          .map((b) => b.toString(16).padStart(2, '0')).join(' ');
        console.log(
          `[KL] kl: ${klBefore} -> ${this.screen.keyboardLocked}  recLen=${record.length}  head=${cmdBytes}`,
        );
      }

      this.emit('screenChange', this.screen.toScreenData());
    } else if (process.env.GS_DIAG_KL === '1') {
      console.log(`[KL] record NOT modified  recLen=${record.length}  kl=${this.screen.keyboardLocked}`);
    }
  }
}
