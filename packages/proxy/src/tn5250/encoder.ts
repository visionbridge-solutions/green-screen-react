import { ScreenBuffer, FieldDef } from './screen.js';
import { TELNET, KEY_TO_AID, AID, FFW, CMD, RECORD_H, RECORD_OPCODE } from './constants.js';
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
   * Dispatches based on the current read_opcode set by the most recent
   * Read command from the host, and handles special-AID cases (SysReq,
   * Attn, TestReq, Print) with the correct record header flags.
   * Returns a Buffer ready to send over the TCP socket (with Telnet EOR framing).
   */
  buildAidResponse(keyName: string): Buffer | null {
    const aidByte = KEY_TO_AID[keyName];
    if (aidByte === undefined) return null;

    // --- Special AID keys (lib5250 session.c:1241-1326) ---
    // These use distinct record-header flags/opcodes and send NO field data.

    if (aidByte === AID.SYS_REQUEST) {
      // Per session.c:1264-1281: send an empty record with flags=SRQ, opcode=NO_OP.
      this.screen.keyboardLocked = true;
      return this.buildEmptyRecord(RECORD_H.SRQ, RECORD_OPCODE.NO_OP);
    }

    if (aidByte === AID.ATTN) {
      // Per session.c:1290-1306: flags=ATN, opcode=NO_OP, no data.
      this.screen.keyboardLocked = true;
      return this.buildEmptyRecord(RECORD_H.ATN, RECORD_OPCODE.NO_OP);
    }

    if (aidByte === AID.TEST_REQUEST) {
      // Per session.c:1283-1288: flags=TRQ, opcode=NO_OP, no data.
      return this.buildEmptyRecord(RECORD_H.TRQ, RECORD_OPCODE.NO_OP);
    }

    if (aidByte === AID.PRINT || aidByte === AID.RECORD_BACKSPACE) {
      // Per session.c:1246-1262: send cursor + AID only, opcode=NO_OP.
      const cursorRow = this.screen.cursorRow;
      const cursorCol = this.screen.cursorCol;
      return this.buildPacket(
        RECORD_H.NONE,
        RECORD_OPCODE.NO_OP,
        Buffer.from([cursorRow + 1, cursorCol + 1, aidByte]),
      );
    }

    // --- Normal AID keys — dispatch on read_opcode ---
    // Per session.c:381-446 (tn5250_session_send_fields).

    const parts: Buffer[] = [];
    const cursorRow = this.screen.cursorRow;
    const cursorCol = this.screen.cursorCol;

    // Cursor position (1-based per 5250 spec) + AID byte
    parts.push(Buffer.from([cursorRow + 1, cursorCol + 1, aidByte]));

    // CLEAR is special — sends cursor + AID only, no field data
    // (per lib5250 it exits the read but produces no field data; hosts
    // check the AID code to react).
    if (aidByte === AID.CLEAR) {
      this.screen.readOpcode = 0;
      this.screen.keyboardLocked = true;
      return this.buildPacket(
        RECORD_H.NONE,
        RECORD_OPCODE.PUT_GET,
        Buffer.concat(parts),
      );
    }

    // Per lib5250 dbuffer.c:193-318: check the SOH header key mask to see
    // if field data should be sent for this AID key. If the mask says no,
    // send cursor+AID only (like CLEAR).
    if (!this.shouldSendDataForAid(aidByte)) {
      this.screen.readOpcode = 0;
      this.screen.keyboardLocked = true;
      return this.buildPacket(
        RECORD_H.NONE,
        RECORD_OPCODE.PUT_GET,
        Buffer.concat(parts),
      );
    }

    // Dispatch by read_opcode — each mode has different encoding rules for
    // modified flag selection, NUL handling, and sign-nibble handling.
    // If no read_opcode is set (host never issued a Read), fall back to
    // MDT-fields semantics — this keeps behavior sane for hosts that
    // simply issue a WTD with INVITE and expect any AID to return data.
    const readOp = this.screen.readOpcode || CMD.READ_MDT_FIELDS;

    switch (readOp) {
      case CMD.READ_INPUT_FIELDS:
      case CMD.READ_IMMEDIATE: {
        // Per session.c:382-406: if ANY field is modified, send data for ALL
        // input fields (inline, no SBA markers). Format: signed-num fields
        // have sign-nibble zone-shifted into the last digit; other fields
        // have embedded NULs translated to SPACE (0x40).
        const anyModified = this.screen.fields.some(f => f.modified);
        if (anyModified) {
          for (const field of this.screen.fields) {
            if (!this.screen.isInputField(field)) continue;
            // Continued subfields: only the "first" emits data; the rest are
            // skipped (their content is merged into the first's output).
            if (field.continuous && !field.continuedFirst) continue;
            parts.push(this.encodeFieldInline(field));
          }
        }
        break;
      }

      case CMD.READ_MDT_FIELDS:
      case CMD.READ_MDT_FIELDS_ALT:
      case CMD.READ_IMMEDIATE_ALT:
      default: {
        // Per session.c:408-424: send ONLY modified fields, each prefixed
        // with SBA (0x11 row col). Signed-num: sign position stripped, sign
        // nibble merged into last digit. READ_MDT_FIELDS: trailing AND
        // embedded NULs → SPACE (0x40). Alt commands: leave NULs as-is.
        const translateNuls = readOp === CMD.READ_MDT_FIELDS;
        for (const field of this.screen.fields) {
          if (!field.modified) continue;
          if (!this.screen.isInputField(field)) continue;
          // Continued subfields: only the "first" emits data. Per session.c
          // the modified flag propagates up the chain via set_mdt, so the
          // "first" will be marked modified if any subfield is modified.
          if (field.continuous && !field.continuedFirst) continue;
          parts.push(Buffer.from([0x11, field.row + 1, field.col + 1]));
          parts.push(this.encodeFieldMdt(field, translateNuls));
        }
        break;
      }
    }

    // Clear the read state — the host must issue a new Read command to
    // request more input.
    this.screen.readOpcode = 0;
    this.screen.keyboardLocked = true;

    return this.buildPacket(
      RECORD_H.NONE,
      RECORD_OPCODE.PUT_GET,
      Buffer.concat(parts),
    );
  }

  /**
   * Encode a field for Read Input Fields / Read Immediate (inline, no SBA).
   * Per lib5250 session.c:522-542.
   * - Embedded NULs → 0x40 (SPACE).
   * - Signed-num fields: trailing '-' is merged into the last digit's zone
   *   nibble (0xD0 | digit_low), and the sign position itself is omitted.
   */
  private encodeFieldInline(field: FieldDef): Buffer {
    const raw = this.getFieldEbcdicData(field);
    const size = raw.length;
    if (size === 0) return Buffer.alloc(0);

    const isSigned = (field.ffw1 & FFW.SHIFT_MASK) === FFW.SHIFT_SIGNED_NUM;

    if (isSigned && size >= 2) {
      // Send size-1 bytes (sign position dropped), NULs → SPACE.
      // The second-last byte gets zone-shifted if the sign byte is '-'.
      const out = Buffer.alloc(size - 1);
      for (let n = 0; n < size - 1; n++) {
        out[n] = raw[n] === 0x00 ? EBCDIC_SPACE : raw[n];
      }
      // If last byte is EBCDIC '-' (0x60), merge sign nibble into last digit
      if (raw[size - 1] === 0x60 && size >= 2) {
        out[size - 2] = 0xD0 | (raw[size - 2] & 0x0F);
      }
      return out;
    }

    // Non-signed: NULs → SPACE, send full length.
    const out = Buffer.alloc(size);
    for (let n = 0; n < size; n++) {
      out[n] = raw[n] === 0x00 ? EBCDIC_SPACE : raw[n];
    }
    return out;
  }

  /**
   * Encode a field for Read MDT Fields / Read MDT Fields Alt / Read Immediate Alt.
   * Per lib5250 session.c:544-596.
   * - Strips trailing NULs.
   * - Signed-num: drops sign position; merges zone nibble into last digit.
   * - Read MDT Fields (not Alt): embedded NULs → 0x40.
   * - Alt variants: embedded NULs preserved as-is.
   */
  private encodeFieldMdt(field: FieldDef, translateNuls: boolean): Buffer {
    const raw = this.getFieldEbcdicData(field);
    let size = raw.length;
    if (size === 0) return Buffer.alloc(0);

    const isSigned = (field.ffw1 & FFW.SHIFT_MASK) === FFW.SHIFT_SIGNED_NUM;

    // Last byte (with possible sign transformation)
    let lastByte = raw[size - 1];

    if (isSigned) {
      // Drop the sign position
      size--;
      lastByte = size > 0 ? raw[size - 1] : 0;
      if (size >= 1 && raw[size] === 0x60) {
        // Sign byte was '-': merge into the new last digit's zone nibble
        lastByte = 0xD0 | (lastByte & 0x0F);
      }
    }

    // Strip trailing NULs
    while (size > 0 && raw[size - 1] === 0x00) {
      size--;
      lastByte = size > 0 ? raw[size - 1] : 0;
    }
    if (size === 0) return Buffer.alloc(0);

    const out = Buffer.alloc(size);
    for (let n = 0; n < size - 1; n++) {
      if (translateNuls && raw[n] === 0x00) {
        out[n] = EBCDIC_SPACE;
      } else {
        out[n] = raw[n];
      }
    }
    // Last byte: apply NUL translation if requested
    out[size - 1] = (translateNuls && lastByte === 0x00) ? EBCDIC_SPACE : lastByte;
    return out;
  }

  /**
   * Extract a field's content as raw EBCDIC bytes (before any translation).
   * For continued-first fields, reconstructs the full concatenated content
   * by walking subsequent continued subfields in the fields list
   * (per lib5250 session.c:487-520).
   */
  private getFieldEbcdicData(field: FieldDef): Buffer {
    const pieces: Buffer[] = [this.encodeSingleField(field)];

    if (field.continuous && field.continuedFirst) {
      // Walk the fields list from this field forward, collecting all
      // subsequent continuous subfields until we hit the "last" one.
      // Per C: "Assumes for now that all the continued field are one after
      // the other and not distributed among other fields."
      const fields = this.screen.fields;
      const idx = fields.indexOf(field);
      if (idx >= 0) {
        for (let i = idx + 1; i < fields.length; i++) {
          const next = fields[i];
          if (!next.continuous) break;
          pieces.push(this.encodeSingleField(next));
          if (next.continuedLast) break;
        }
      }
    }

    return Buffer.concat(pieces);
  }

  /** Encode one single field's content to EBCDIC (no continuation walk). */
  /**
   * Check the SOH header key mask to determine if field data should be
   * sent for the given AID key. Per lib5250 dbuffer.c:193-318.
   *
   * The key mask is stored in SOH header bytes 4-6 (0-indexed).
   * Uses `header_data[byte] & (0x80 >> bit)` where bit descends from 7
   * for the first key in each group. If the masked bit is CLEAR (0),
   * data SHOULD be sent (result=1); if SET (1), data should NOT be sent.
   * For non-function-key AIDs (Enter, PageUp, etc.) data is always sent.
   */
  private shouldSendDataForAid(aidByte: number): boolean {
    const hdr = this.screen.headerData;
    // No key mask if header is too short (< 7 bytes)
    if (!hdr || hdr.length <= 6) return true;

    // Map F-key AID bytes to (byteIndex, bit) matching lib5250 exactly.
    // The C code uses: result = ((header_data[byte] & (0x80 >> bit)) == 0)
    // F1-F8: byte 6, bits 7..0
    // F9-F16: byte 5, bits 7..0
    // F17-F24: byte 4, bits 7..0
    const aidKeyMap: Record<number, [number, number]> = {
      [AID.F1]: [6, 7],  [AID.F2]: [6, 6],  [AID.F3]: [6, 5],  [AID.F4]: [6, 4],
      [AID.F5]: [6, 3],  [AID.F6]: [6, 2],  [AID.F7]: [6, 1],  [AID.F8]: [6, 0],
      [AID.F9]: [5, 7],  [AID.F10]: [5, 6], [AID.F11]: [5, 5], [AID.F12]: [5, 4],
      [AID.F13]: [5, 3], [AID.F14]: [5, 2], [AID.F15]: [5, 1], [AID.F16]: [5, 0],
      [AID.F17]: [4, 7], [AID.F18]: [4, 6], [AID.F19]: [4, 5], [AID.F20]: [4, 4],
      [AID.F21]: [4, 3], [AID.F22]: [4, 2], [AID.F23]: [4, 1], [AID.F24]: [4, 0],
    };

    const mapping = aidKeyMap[aidByte];
    if (!mapping) return true; // Non-F-key AIDs always send data

    const [byteIdx, bit] = mapping;
    // Per lib5250: bit CLEAR = send data; bit SET = don't send
    return (hdr[byteIdx] & (0x80 >> bit)) === 0;
  }

  /** Encode one single field's content to EBCDIC (no continuation walk). */
  private encodeSingleField(field: FieldDef): Buffer {
    const value = this.screen.getFieldValue(field);
    const buf = Buffer.alloc(value.length);
    for (let i = 0; i < value.length; i++) {
      // Preserve NUL characters (stored in the buffer as char code 0).
      const code = value.charCodeAt(i);
      buf[i] = code === 0 ? 0x00 : charToEbcdic(value[i]);
    }
    return buf;
  }

  /** Build an empty 10-byte record (no data) with the given flags/opcode. */
  private buildEmptyRecord(flags: number, opcode: number): Buffer {
    return this.buildPacket(flags, opcode, Buffer.alloc(0));
  }

  /** Build a full 5250 packet: 10-byte GDS header + data, then Telnet EOR. */
  private buildPacket(flags: number, opcode: number, data: Buffer): Buffer {
    const header = this.buildGDSHeader(flags, opcode);
    return this.wrapWithEOR(Buffer.concat([header, data]));
  }

  /**
   * Build a GDS header for a client response.
   * Per lib5250 telnetstr.c:860-895:
   *   Bytes 0-1: record length (filled by wrapWithEOR)
   *   Bytes 2-3: record type 0x12A0
   *   Bytes 4-5: flowtype (0x0000 = DISPLAY)
   *   Byte 6:    sub-header length 0x04
   *   Byte 7:    flags
   *   Byte 8:    reserved 0x00
   *   Byte 9:    opcode
   */
  private buildGDSHeader(
    flags: number = RECORD_H.NONE,
    opcode: number = RECORD_OPCODE.PUT_GET,
  ): Buffer {
    return Buffer.from([0x00, 0x00, 0x12, 0xA0, 0x00, 0x00, 0x04, flags, 0x00, opcode]);
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

    this.screen.setFieldMdt(field);
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

    this.screen.setFieldMdt(field);
    return true;
  }
}
