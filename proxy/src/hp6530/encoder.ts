import { HP6530Screen } from './screen.js';
import { KEY_TO_SEQUENCE, CTRL } from './constants.js';

/**
 * Encodes client input into HP 6530 wire-format data for sending
 * to an HP NonStop (Tandem) host.
 *
 * In block mode, the terminal collects all modified unprotected field
 * data and sends it as a single transmission when an action key
 * (ENTER, function key) is pressed.
 */
export class HP6530Encoder {
  private screen: HP6530Screen;

  constructor(screen: HP6530Screen) {
    this.screen = screen;
  }

  /**
   * Build a block-mode response for a key press.
   *
   * For action keys (ENTER, function keys), we:
   * 1. Send the function key escape sequence
   * 2. Preceded by all modified unprotected field data
   *
   * The field data format for block-mode transmission:
   *   DC1 (XON) signals start of block
   *   For each modified field: position + data
   *   Followed by the key sequence
   *   CR signals end of input
   *
   * Returns a Buffer ready to send, or null if the key is unknown.
   */
  buildKeyResponse(keyName: string): Buffer | null {
    const keySeq = KEY_TO_SEQUENCE[keyName];
    if (!keySeq) return null;

    const parts: Buffer[] = [];

    // For block-mode action keys (ENTER, function keys), collect field data
    const isActionKey = keyName === 'ENTER' ||
      keyName.startsWith('F') ||
      keyName.startsWith('SF');

    if (isActionKey && this.screen.fields.length > 0) {
      // Collect all modified unprotected field data
      for (const field of this.screen.fields) {
        if (field.isProtected || !field.modified) continue;

        const value = this.screen.getFieldValue(field);
        // Trim trailing spaces
        const trimmed = value.replace(/\s+$/, '');
        if (trimmed.length > 0) {
          parts.push(Buffer.from(trimmed, 'ascii'));
        }

        // Field separator: HT between fields
        parts.push(Buffer.from([CTRL.HT]));
      }
    }

    // Append the key sequence itself
    parts.push(keySeq);

    // For ENTER in block mode, append CR if not already the key sequence
    if (keyName !== 'ENTER' && isActionKey) {
      parts.push(Buffer.from([CTRL.CR]));
    }

    return Buffer.concat(parts);
  }

  /**
   * Insert text at the current cursor position in the current
   * unprotected field. Updates the screen buffer and marks the
   * field as modified.
   *
   * Returns true if text was successfully inserted.
   */
  insertText(text: string): boolean {
    const field = this.screen.getFieldAtCursor();
    if (!field || field.isProtected) return false;

    const fieldStart = this.screen.offset(field.row, field.col);
    let cursorOffset = this.screen.offset(
      this.screen.cursorRow,
      this.screen.cursorCol,
    );
    const fieldEnd = fieldStart + field.length;

    for (const ch of text) {
      if (cursorOffset >= fieldEnd) break;

      this.screen.buffer[cursorOffset] = ch;
      cursorOffset++;
    }

    // Update cursor position
    const newPos = this.screen.toRowCol(Math.min(cursorOffset, fieldEnd - 1));
    this.screen.cursorRow = newPos.row;
    this.screen.cursorCol = newPos.col;

    field.modified = true;
    return true;
  }
}
