import { ScreenBuffer } from './screen.js';
import { TELNET, KEY_TO_AID, AID } from './constants.js';
import { charToEbcdic, EBCDIC_SPACE } from './ebcdic.js';

/**
 * Encodes client responses (aid keys + field data) into 5250 data stream
 * for sending back to the IBM i host.
 */
export class TN5250Encoder {
  private screen: ScreenBuffer;

  constructor(screen: ScreenBuffer) {
    this.screen = screen;
  }

  /**
   * Build a 5250 input response for an aid key press.
   * Collects modified field data and builds the response record.
   * Returns a Buffer ready to send over the TCP socket (with Telnet EOR framing).
   */
  buildAidResponse(keyName: string): Buffer | null {
    const aidByte = KEY_TO_AID[keyName];
    if (aidByte === undefined) return null;

    const parts: Buffer[] = [];

    const cursorRow = this.screen.cursorRow;
    const cursorCol = this.screen.cursorCol;

    // GDS header: length(2) + record_type(2) + var(1) + reserved(1) + opcode(1)
    parts.push(this.buildGDSHeader());

    // Cursor position + AID byte
    parts.push(Buffer.from([cursorRow, cursorCol, aidByte]));

    // For certain aid keys (like SysReq), no field data is sent
    if (aidByte === AID.SYS_REQUEST || aidByte === AID.CLEAR) {
      return this.wrapWithEOR(Buffer.concat(parts));
    }

    // Collect modified fields and append their data
    for (const field of this.screen.fields) {
      if (!field.modified) continue;
      if (!this.screen.isInputField(field)) continue;

      // SBA order to indicate field position
      parts.push(Buffer.from([0x11, field.row, field.col]));

      // Field data in EBCDIC
      const value = this.screen.getFieldValue(field);
      const ebcdicData = Buffer.alloc(value.length);
      for (let i = 0; i < value.length; i++) {
        ebcdicData[i] = charToEbcdic(value[i]);
      }

      // Trim trailing spaces and nulls
      let trimLen = ebcdicData.length;
      while (trimLen > 0 && (ebcdicData[trimLen - 1] === EBCDIC_SPACE || ebcdicData[trimLen - 1] === 0x00)) {
        trimLen--;
      }

      if (trimLen > 0) {
        parts.push(ebcdicData.subarray(0, trimLen));
      }
    }

    return this.wrapWithEOR(Buffer.concat(parts));
  }

  /**
   * Build a GDS header for a client response (matching tn5250j format).
   * 10-byte header:
   *   Bytes 0-1: record length (filled by wrapWithEOR)
   *   Bytes 2-3: record type 0x12A0 (SNA GDS Variable)
   *   Bytes 4-5: reserved 0x0000
   *   Byte 6: sub-header length 0x04
   *   Byte 7: flags 0x00
   *   Byte 8: reserved 0x00
   *   Byte 9: opcode 0x03 (PUT/GET response)
   */
  private buildGDSHeader(): Buffer {
    return Buffer.from([0x00, 0x00, 0x12, 0xA0, 0x00, 0x00, 0x04, 0x00, 0x00, 0x03]);
  }

  /**
   * Wrap data with Telnet IAC EOR framing.
   * Also escapes any 0xFF bytes in the data as IAC IAC.
   */
  private wrapWithEOR(data: Buffer): Buffer {
    // Update GDS record length in the first 2 bytes (includes itself)
    if (data.length >= 2) {
      const len = data.length;
      data[0] = (len >> 8) & 0xFF;
      data[1] = len & 0xFF;
    }
    // Escape IAC bytes in data and append IAC EOR
    const escaped: number[] = [];
    for (let i = 0; i < data.length; i++) {
      escaped.push(data[i]);
      if (data[i] === TELNET.IAC) {
        escaped.push(TELNET.IAC); // escape
      }
    }
    escaped.push(TELNET.IAC, TELNET.EOR);

    return Buffer.from(escaped);
  }

  /**
   * Insert text at the current cursor position in the current field.
   * Updates the screen buffer and marks the field as modified.
   * Returns true if text was successfully inserted.
   */
  insertText(text: string): boolean {
    const field = this.screen.getFieldAtCursor();
    if (!field || !this.screen.isInputField(field)) return false;

    const fieldStart = this.screen.offset(field.row, field.col);
    let cursorOffset = this.screen.offset(this.screen.cursorRow, this.screen.cursorCol);
    const fieldEnd = fieldStart + field.length;

    for (const ch of text) {
      if (cursorOffset >= fieldEnd) break; // Field is full

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
