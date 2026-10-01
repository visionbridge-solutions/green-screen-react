import { ScreenBuffer, FieldDef } from './screen.js';
import { TELNET, KEY_TO_AID, AID, FFW, CMD, RECORD_H, RECORD_OPCODE } from './constants.js';
import { charToEbcdic, EBCDIC_SPACE } from '../encoding/ebcdic.js';
import { SI, SO, encodeDbcsPair, isDbcsGlyph } from '../encoding/ebcdic-jp.js';
import { aidTransmitsData } from './command-keys.js';
import type { TextEntryOptions } from '../protocols/types.js';

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
    // Single source of truth for the SOH key-mask decoding — also surfaced to
    // integrators via ScreenData.command_keys_no_transmit (command-keys.ts).
    return aidTransmitsData(this.screen.headerData, aidByte);
  }

  /**
   * Encode one single field's content to EBCDIC (no continuation walk).
   *
   * Walks CELLS, not the joined string, so DBCS content re-encodes with
   * wire identity: an SO/SI cell (dbcsShift) emits 0x0E/0x0F, a glyph
   * whose next cell is a continuation emits its byte pair (via the
   * decode registry's mirror), and total bytes === cell count by
   * construction. SBCS-only fields produce byte-identical output to the
   * previous string walk.
   */
  private encodeSingleField(field: FieldDef): Buffer {
    const start = this.screen.offset(field.row, field.col);
    const out: number[] = [];
    let pairConsumedNext = false;
    for (let i = 0; i < field.length && start + i < this.screen.size; i++) {
      const addr = start + i;
      const shift = this.screen.dbcsShift[addr];
      if (shift === 1) { out.push(SO); continue; }
      if (shift === 2) { out.push(SI); continue; }
      if (this.screen.dbcsCont[addr]) {
        // Second half of a pair — its glyph already emitted both bytes.
        // An orphan continuation (field boundary split a pair) still must
        // hold its cell on the wire.
        if (pairConsumedNext) { pairConsumedNext = false; continue; }
        out.push(0x40);
        continue;
      }
      pairConsumedNext = false;
      const ch = this.screen.buffer[addr];
      if (i + 1 < field.length && this.screen.dbcsCont[addr + 1]) {
        // DBCS space keeps the two-cell layout for unmapped glyphs.
        const pair = encodeDbcsPair(ch) ?? [0x40, 0x40];
        out.push(pair[0], pair[1]);
        pairConsumedNext = true;
        continue;
      }
      // Preserve NUL characters (stored in the buffer as char code 0).
      // The session code page MUST thread here (mirrors tn3270/encoder.ts):
      // without it a cp290 (Japan katakana) session silently encoded typed
      // text through the CP37 table — decode honored the code page, encode
      // did not, so round-tripped characters landed as the wrong bytes.
      const code = ch.charCodeAt(0);
      out.push(code === 0 ? 0x00 : charToEbcdic(ch, this.screen.codePage));
    }
    return Buffer.from(out);
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
   * Buffer offset of the last cell of the field the latest ``insertText``
   * filled — where it left the cursor parked, since a cursor cannot rest
   * past a field. The next character typed there is past the end of that
   * field, not a correction of its last cell. The handler clears it on every
   * key, cursor move and host record that rewrites the screen
   * (``clearFilledPark``); a direct cursor write elsewhere invalidates it by
   * position.
   */
  private filledParkAt: number | null = null;

  /** Forget the park: the cursor moved by some means other than typing. */
  clearFilledPark(): void {
    this.filledParkAt = null;
  }

  /**
   * Insert text at the current cursor position. Updates the screen buffer and
   * marks every field it types into as modified. Returns false when a
   * character could not be placed (no input field at the cursor, or the text
   * ran past the end of a field it may not leave).
   *
   * At the end of a field: with ``opts.advance`` (keyboard typing) the next
   * character moves on to the next input field in Tab order, as a 5250
   * keyboard does — the operator who types a 10-character user and goes on
   * typing gets the password in the Password field. Without it the text is a
   * field write and the overflow is refused. Either way the field's last
   * cell is never overwritten by text that runs past it: it used to be, once
   * per extra character, so "USER" + "PASS" into a 4-cell field read "USES".
   * The cursor stays parked on the full field (it does not jump on fill), so
   * a Tab or Field Exit sent after a full value still acts on that field.
   */
  insertText(text: string, opts: TextEntryOptions = {}): boolean {
    const atCursor = this.screen.getFieldAtCursor();
    if (!atCursor || !this.screen.isInputField(atCursor)) {
      this.filledParkAt = null;
      return false;
    }
    let field: FieldDef = atCursor;

    let fieldStart = this.screen.offset(field.row, field.col);
    let cursorOffset = this.screen.offset(this.screen.cursorRow, this.screen.cursorCol);
    let fieldEnd = fieldStart + field.length;
    let dbcsCapable = this.screen.isDbcsField(field);
    // Typing goes on where the previous keystroke filled this field.
    let pastEnd = this.filledParkAt === cursorOffset && cursorOffset === fieldEnd - 1;
    this.filledParkAt = null;
    let typedHere = false;
    let placedAll = true;
    // Fields one character has moved through without landing: a glyph no
    // field can hold must end the typing, not circle the screen.
    let hops = 0;

    const chars = [...text];
    for (let i = 0; i < chars.length;) {
      const ch = chars[i];
      if (pastEnd || cursorOffset >= fieldEnd) {
        const next: FieldDef | null = opts.advance ? this.advanceTarget(field) : null;
        if (!next || ++hops > this.screen.fields.length) { placedAll = false; break; }
        if (typedHere) this.screen.setFieldMdt(field);
        field = next;
        fieldStart = this.screen.offset(field.row, field.col);
        cursorOffset = fieldStart;
        fieldEnd = fieldStart + field.length;
        dbcsCapable = this.screen.isDbcsField(field);
        pastEnd = false;
        typedHere = false;
      }

      if (dbcsCapable && isDbcsGlyph(ch)) {
        const after = this.insertDbcsGlyph(field, ch, cursorOffset, fieldEnd);
        if (after < 0) { pastEnd = true; continue; } // no room left: as a full field
        cursorOffset = after;
        typedHere = true;
        hops = 0;
        i++;
        continue;
      }

      // An SBCS character typed while the cursor rests on a run's SI
      // belongs AFTER the run — overwriting the SI would unterminate it.
      if (dbcsCapable && this.screen.dbcsShift[cursorOffset] === 2) {
        cursorOffset++;
        if (cursorOffset >= fieldEnd) continue; // the run ends the field
      }

      // In insert mode, shift existing content right to make room
      // (per lib5250 dbuffer.c:790-835 dbuffer_ins)
      if (this.screen.insertMode && this.screen.buffer[cursorOffset] !== ' ') {
        for (let j = fieldEnd - 1; j > cursorOffset; j--) {
          this.screen.buffer[j] = this.screen.buffer[j - 1];
        }
      }
      this.screen.buffer[cursorOffset] = ch;
      // Cell-honest: an SBCS character overwrites any DBCS debris marks.
      this.screen.dbcsCont[cursorOffset] = false;
      this.screen.dbcsShift[cursorOffset] = 0;
      cursorOffset++;
      typedHere = true;
      hops = 0;
      i++;
    }

    // Update cursor position
    const newPos = this.screen.toRowCol(Math.min(cursorOffset, fieldEnd - 1));
    this.screen.cursorRow = newPos.row;
    this.screen.cursorCol = newPos.col;
    if (pastEnd || cursorOffset >= fieldEnd) this.filledParkAt = fieldEnd - 1;

    this.screen.setFieldMdt(field);
    return placedAll;
  }

  /**
   * The field a character typed past the end of ``full`` moves on to, or
   * null where a 5250 keyboard stops too: Field Exit Required, and a signed
   * numeric field, whose last cell is its sign (Field Exit / Field+ / Field−
   * end it). Auto Enter is not raised: the emulator never fires an AID on its
   * own, whatever it types. A screen whose only input field is this one has
   * nowhere to go.
   */
  private advanceTarget(full: FieldDef): FieldDef | null {
    if ((full.ffw2 & FFW.FER) !== 0) return null;
    if ((full.ffw1 & FFW.SHIFT_MASK) === FFW.SHIFT_SIGNED_NUM) return null;
    const next = this.screen.adjacentInputField(this.screen.offset(full.row, full.col), 1);
    return next && next !== full ? next : null;
  }

  /**
   * Insert one DBCS glyph at cursorOffset in a DBCS-capable field.
   *
   * Shifted fields (ideographic open/either): typing the first glyph
   * creates the 4-cell run SO+glyph+cont+SI; typing at an existing run's
   * SI appends glyph+cont before it (SI slides right 2 cells). Bare
   * fields (ideographic only/data): glyph+cont, no shift cells.
   *
   * Returns the new cursor offset (positioned ON the SI for shifted runs,
   * so consecutive glyphs chain into one run), or -1 if it did not fit.
   */
  private insertDbcsGlyph(
    field: FieldDef,
    ch: string,
    cursorOffset: number,
    fieldEnd: number,
  ): number {
    const s = this.screen;
    const writeCell = (addr: number, c: string, cont: boolean, shift: number): void => {
      s.buffer[addr] = c;
      s.dbcsCont[addr] = cont;
      s.dbcsShift[addr] = shift;
    };

    if (!s.fieldUsesShiftMarks(field)) {
      if (cursorOffset + 2 > fieldEnd) return -1;
      writeCell(cursorOffset, ch, false, 0);
      writeCell(cursorOffset + 1, '', true, 0);
      return cursorOffset + 2;
    }

    // Append inside an existing run: cursor sits on the run's SI cell.
    if (s.dbcsShift[cursorOffset] === 2) {
      if (cursorOffset + 3 > fieldEnd) return -1;
      writeCell(cursorOffset, ch, false, 0);
      writeCell(cursorOffset + 1, '', true, 0);
      writeCell(cursorOffset + 2, ' ', false, 2);
      return cursorOffset + 2; // cursor lands on the moved SI
    }

    // Create a fresh 4-cell run: SO + glyph + continuation + SI.
    if (cursorOffset + 4 > fieldEnd) return -1;
    writeCell(cursorOffset, ' ', false, 1);
    writeCell(cursorOffset + 1, ch, false, 0);
    writeCell(cursorOffset + 2, '', true, 0);
    writeCell(cursorOffset + 3, ' ', false, 2);
    return cursorOffset + 3; // cursor lands on the SI
  }

  /**
   * Field Exit: right-adjust field value per FFW2 bits and mark modified.
   * Does NOT advance cursor — caller should handle that (e.g., Tab).
   */
  fieldExit(): boolean {
    const field = this.screen.getFieldAtCursor();
    if (!field || !this.screen.isInputField(field)) return false;

    // Cell-honest guard: right-adjust is a character-cell shuffle that
    // would split glyph/continuation pairs and orphan SO/SI cells — and
    // adjust semantics are numeric/Latin anyway. DBCS content keeps its
    // layout; only the MDT is set.
    const start = this.screen.offset(field.row, field.col);
    for (let i = 0; i < field.length && start + i < this.screen.size; i++) {
      if (this.screen.dbcsCont[start + i] || this.screen.dbcsShift[start + i]) {
        this.screen.setFieldMdt(field);
        return true;
      }
    }

    const value = this.screen.getFieldValue(field);
    const trimmed = value.replace(/\s+$/, '');

    // FFW2 ADJUST bits per the 5250 Functions Reference (and this package's
    // own wire projection in screen.ts): 0x05 = right-adjust zero-fill,
    // 0x06 = right-adjust blank-fill. 0x07 is MANDATORY FILL — a validation
    // rule, not an adjust instruction — so it must not pad.
    const adjustType = field.ffw2 & FFW.RIGHT_ADJUST_MASK;
    if ((adjustType === 0x05 || adjustType === 0x06)
        && trimmed.length > 0 && trimmed.length < field.length) {
      const padChar = adjustType === 0x05 ? '0' : ' ';
      const adjusted = padChar.repeat(field.length - trimmed.length) + trimmed;
      this.screen.setFieldValue(field, adjusted);
    }

    this.screen.setFieldMdt(field);
    return true;
  }
}
