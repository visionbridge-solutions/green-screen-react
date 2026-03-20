import { ScreenBuffer } from './screen.js';
import { TELNET, KEY_TO_AID, AID, FFW } from './constants.js';
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

    // Cursor position (1-based, per 5250 spec) + AID byte
    parts.push(Buffer.from([cursorRow + 1, cursorCol + 1, aidByte]));

    // For certain aid keys (like SysReq), no field data is sent
    if (aidByte === AID.SYS_REQUEST || aidByte === AID.CLEAR) {
      return this.wrapWithEOR(Buffer.concat(parts));
    }

    // Collect modified fields and append their data
    for (const field of this.screen.fields) {
      if (!field.modified) continue;
      if (!this.screen.isInputField(field)) continue;

      // SBA order to indicate field position (1-based, per 5250 spec)
      parts.push(Buffer.from([0x11, field.row + 1, field.col + 1]));

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
   * Build a 5250 Query Reply response.
   * Per lib5250 session.c:2367-2580. Tells the host our terminal capabilities,
   * including enhanced 5250 WDSF support (windows, selection fields, etc.).
   */
  buildQueryReply(terminalType = 'IBM-3179-2'): Buffer {
    const temp = Buffer.alloc(67, 0x00);

    temp[0] = 0x00; // Cursor Row (zero)
    temp[1] = 0x00; // Cursor Column (zero)
    temp[2] = 0x88; // Inbound Write Structured Field Aid

    // Length of query reply data (including these 2 bytes)
    temp[3] = 0x00;
    temp[4] = 0x40; // 64 bytes (enhanced mode)

    temp[5] = 0xD9; // Command class
    temp[6] = 0x70; // Command type — Query
    temp[7] = 0x80; // Flag byte

    temp[8] = 0x06; // Controller hardware class
    temp[9] = 0x00; // Other WSF / 5250 emulator

    temp[10] = 0x01; // Controller code level: Version 1 Release 1.0
    temp[11] = 0x01;
    temp[12] = 0x00;

    // Bytes 13-28: Reserved (already zero)

    temp[29] = 0x01; // Display emulation

    // Device type and model from terminal type string (e.g., "IBM-3179-2")
    const dashIdx = terminalType.indexOf('-');
    const suffix = dashIdx >= 0 ? terminalType.substring(dashIdx + 1) : '3179-2';
    const parts = suffix.split('-');
    const devType = (parts[0] || '3179').padStart(4, '0');
    const devModel = (parts[1] || '2').padStart(2, '0');

    // Convert device type/model to EBCDIC
    for (let i = 0; i < 4 && i < devType.length; i++) {
      temp[30 + i] = charToEbcdic(devType[i]);
    }
    temp[34] = charToEbcdic(' '); // separator
    for (let i = 0; i < 2 && i < devModel.length; i++) {
      temp[35 + i] = charToEbcdic(devModel[i]);
    }

    temp[37] = 0x02; // Standard keyboard
    temp[38] = 0x00; // Extended keyboard ID
    temp[39] = 0x00; // Reserved

    // Serial number (bytes 40-43)
    temp[40] = 0x00;
    temp[41] = 0x61;
    temp[42] = 0x50;
    temp[43] = 0x00;

    temp[44] = 0xFF; // Max input fields (high byte)
    temp[45] = 0xFF; // Max input fields (low byte)

    temp[46] = 0x00; // Control unit customization
    temp[47] = 0x00; // Reserved
    temp[48] = 0x00;

    temp[49] = 0x23; // Controller/Display capability
    temp[50] = 0x31;
    temp[51] = 0x00;
    temp[52] = 0x00;

    // Byte 53 bit 6: Enhanced 5250 FCW & WDSFs
    // Byte 53 bit 7: WRITE ERROR CODE TO WINDOW support
    temp[53] = 0x02;
    // Byte 54 bit 0: Enhanced UI level 2
    temp[54] = 0x80;

    // Bytes 55-66: Reserved (already zero)

    // Wrap in GDS header and Telnet EOR framing
    const gdsHeader = Buffer.from([
      0x00, 0x00,       // length placeholder
      0x12, 0xA0,       // record type GDS
      0x00, 0x00,       // reserved
      0x04,             // sub-header length
      0x00,             // flags
      0x00,             // reserved
      0x00,             // opcode NO_OP
    ]);

    const packet = Buffer.concat([gdsHeader, temp]);
    return this.wrapWithEOR(packet);
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

      // In insert mode, shift existing content right to make room
      // (per lib5250 dbuffer.c:790-835 dbuffer_ins)
      if (this.screen.insertMode && this.screen.buffer[cursorOffset] !== ' ') {
        for (let i = fieldEnd - 1; i > cursorOffset; i--) {
          this.screen.buffer[i] = this.screen.buffer[i - 1];
        }
      }
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

  /**
   * Field Exit: right-adjust field value per FFW2 bits and mark modified.
   * Does NOT advance cursor — caller should handle that (e.g., Tab).
   */
  fieldExit(): boolean {
    const field = this.screen.getFieldAtCursor();
    if (!field || !this.screen.isInputField(field)) return false;

    const value = this.screen.getFieldValue(field);
    const trimmed = value.replace(/\s+$/, '');

    const adjustType = field.ffw2 & FFW.RIGHT_ADJUST_MASK;
    if (adjustType !== 0 && trimmed.length > 0 && trimmed.length < field.length) {
      let padChar = ' ';
      if (adjustType === 1 || adjustType === 3) padChar = '0'; // zero fill
      // adjustType 2, 5 = blank fill (padChar stays ' ')

      const adjusted = padChar.repeat(field.length - trimmed.length) + trimmed;
      this.screen.setFieldValue(field, adjusted);
    }

    field.modified = true;
    return true;
  }
}
