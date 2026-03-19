import { ProtocolHandler } from './types.js';
import type { ScreenData, ProtocolOptions, ProtocolType } from './types.js';
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

    await this.connection.connect(host, port, termType);
  }

  disconnect(): void {
    this.connection.disconnect();
  }

  getScreenData(): ScreenData {
    return this.screen.toScreenData();
  }

  sendText(text: string): boolean {
    return this.encoder.insertText(text);
  }

  sendKey(keyName: string): boolean {
    // Normalize key names: frontend sends uppercase (ENTER, TAB) but
    // KEY_TO_AID uses mixed case (Enter, PageUp). Handle both.
    const normalizedKey = this.normalizeKeyName(keyName);

    // Tab/Backtab: local cursor movement to next/previous input field.
    if (normalizedKey === 'Tab' || normalizedKey === 'Backtab') {
      const inputFields = this.screen.fields
        .filter(f => this.screen.isInputField(f))
        .sort((a, b) => this.screen.offset(a.row, a.col) - this.screen.offset(b.row, b.col));
      if (inputFields.length === 0) return false;

      const cursorPos = this.screen.offset(this.screen.cursorRow, this.screen.cursorCol);
      if (normalizedKey === 'Tab') {
        const next = inputFields.find(f => this.screen.offset(f.row, f.col) > cursorPos);
        const target = next || inputFields[0]; // wrap around
        this.screen.cursorRow = target.row;
        this.screen.cursorCol = target.col;
      } else {
        const prev = [...inputFields].reverse().find(f => this.screen.offset(f.row, f.col) < cursorPos);
        const target = prev || inputFields[inputFields.length - 1];
        this.screen.cursorRow = target.row;
        this.screen.cursorCol = target.col;
      }
      return true;
    }

    const response = this.encoder.buildAidResponse(normalizedKey);
    if (!response) return false;
    this.connection.sendRaw(response);
    return true;
  }

  private normalizeKeyName(key: string): string {
    const map: Record<string, string> = {
      'ENTER': 'Enter', 'TAB': 'Tab', 'BACKTAB': 'Backtab',
      'PAGEUP': 'PageUp', 'PAGEDOWN': 'PageDown',
      'DELETE': 'Delete', 'CLEAR': 'Clear', 'HELP': 'Help', 'PRINT': 'Print',
      'UP': 'ArrowUp', 'DOWN': 'ArrowDown', 'LEFT': 'ArrowLeft', 'RIGHT': 'ArrowRight',
      'HOME': 'Home', 'END': 'End', 'INSERT': 'Insert',
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
  private waitForScreenWithFields(minFields: number, timeoutMs: number): Promise<ScreenData> {
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

  sendRaw(data: Buffer): void {
    this.connection.sendRaw(data);
  }

  destroy(): void {
    this.disconnect();
    this.removeAllListeners();
  }

  private onRecord(record: Buffer): void {
    const modified = this.parser.parseRecord(record);
    if (modified) {
      this.parser.calculateFieldLengths();
      this.emit('screenChange', this.screen.toScreenData());
    }
  }
}
