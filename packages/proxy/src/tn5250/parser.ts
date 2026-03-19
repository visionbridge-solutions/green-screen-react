import { ScreenBuffer, FieldDef } from './screen.js';
import { CMD, ORDER, OPCODE, ATTR } from './constants.js';
import { ebcdicToChar, ebcdicSymbolChar, EBCDIC_SPACE } from './ebcdic.js';

/**
 * Parses 5250 data stream records and updates the screen buffer.
 */
export class TN5250Parser {
  private screen: ScreenBuffer;
  /** When true, the next SF order should clear stale fields first */
  private pendingFieldsClear = false;

  constructor(screen: ScreenBuffer) {
    this.screen = screen;
  }

  /**
   * Parse a complete 5250 record (after Telnet framing is removed).
   * Returns true if the screen was modified.
   */
  parseRecord(record: Buffer): boolean {
    if (record.length < 2) return false;

    // 5250 record header:
    // Bytes 0-1: record length
    // Byte 2: record type (high byte)
    // Byte 3: record type (low byte) — together 0x12A0 for GDS
    // Byte 4: reserved (variable flag)
    // Byte 5: reserved
    // Byte 6: opcode
    // Remaining: data

    // Some records may be shorter or have different formats
    // Try to parse the GDS header
    if (record.length < 7) {
      // Too short for a full GDS header — might be a short record
      return false;
    }

    const recordLen = (record[0] << 8) | record[1];
    const recordType = (record[2] << 8) | record[3];

    // Check for GDS record type
    if (recordType !== 0x12A0) {
      return this.tryParseRawData(record);
    }

    // Determine header layout: standard 10-byte header has a 4-byte sub-header
    // at bytes 6-9: [sub_header_len=0x04][flags][reserved][opcode]
    // Data starts at byte 10. Older/simpler records may use 7-byte layout.
    let opcode: number;
    let dataOffset: number;

    if (record.length >= 10 && record[6] === 0x04) {
      // 10-byte header with 4-byte sub-header
      opcode = record[9];
      dataOffset = 10;
    } else {
      // 7-byte header (opcode at byte 6)
      opcode = record[6];
      dataOffset = 7;
    }

    let modified = false;

    switch (opcode) {
      case OPCODE.OUTPUT:
      case OPCODE.PUT_GET:
        // Use parseCommandsFromOffset to scan for CLEAR_UNIT/WTD within the data.
        // The data may contain sub-record markers (0x04) before the actual commands,
        // which parseCommands would misinterpret. parseCommandsFromOffset handles this
        // by scanning for known command bytes.
        if (record.length > dataOffset) {
          modified = this.parseCommandsFromOffset(record, dataOffset);
        }
        break;

      case OPCODE.INVITE:
        break;

      case OPCODE.SAVE_SCREEN:
      case OPCODE.RESTORE_SCREEN:
        if (record.length > dataOffset) {
          modified = this.parseCommandsFromOffset(record, dataOffset);
        }
        break;

      default:
        if (record.length > dataOffset) {
          modified = this.parseCommandsFromOffset(record, dataOffset);
        }
        break;
    }

    return modified;
  }

  /** Try to parse data that doesn't have a proper GDS header */
  private tryParseRawData(record: Buffer): boolean {
    // Some servers send command data without the full GDS wrapper
    return this.parseCommands(record, 0);
  }

  /**
   * Handle records with non-standard framing (e.g. opcode 0x04 from
   * pub400.com). These records contain valid commands (CLEAR_UNIT, WTD)
   * but with extra sub-record marker bytes (0x04) between the GDS header
   * and the actual commands.  We scan for the first known command byte,
   * skipping 0x04 markers, and hand off to parseCommands.
   */
  private parseCommandsFromOffset(data: Buffer, start: number): boolean {
    for (let i = start; i < data.length; i++) {
      // Skip sub-record markers (0x04)
      if (data[i] === 0x04) continue;
      // Known command bytes — hand off to normal parsing
      if (data[i] === CMD.WRITE_TO_DISPLAY ||
          data[i] === CMD.CLEAR_UNIT ||
          data[i] === CMD.CLEAR_UNIT_ALT ||
          data[i] === CMD.WRITE_STRUCTURED_FIELD ||
          data[i] === CMD.WRITE_ERROR_CODE ||
          data[i] === CMD.WRITE_ERROR_CODE_WIN) {
        return this.parseCommands(data, i);
      }
    }
    return false;
  }

  /** Parse one or more 5250 commands starting at offset */
  private parseCommands(data: Buffer, offset: number): boolean {
    let pos = offset;
    let modified = false;

    while (pos < data.length) {
      const cmd = data[pos];

      switch (cmd) {
        case CMD.CLEAR_UNIT:
        case CMD.CLEAR_UNIT_ALT:
          this.screen.clear();
          pos++;
          modified = true;
          break;

        case CMD.CLEAR_FORMAT_TABLE:
          this.screen.fields = [];
          pos++;
          modified = true;
          break;

        case CMD.WRITE_TO_DISPLAY: {
          pos++; // skip command byte
          // WTD has a CC (control character) — 2 bytes
          if (pos + 1 < data.length) {
            const cc1 = data[pos++];
            const cc2 = data[pos++];

            // CC1 upper 3 bits (0xE0 mask) control MDT reset + null fill.
            // Per lib5250 session.c:820-851, this is a 7-value switch:
            let resetNonBypassMdt = false;
            let resetAllMdt = false;
            let nullNonBypassMdt = false;
            let nullNonBypass = false;

            switch (cc1 & 0xE0) {
              case 0x00: break; // no action (unlock keyboard only)
              case 0x20: break; // reserved / no action in lib5250
              case 0x40: resetNonBypassMdt = true; break;
              case 0x60: resetAllMdt = true; break;
              case 0x80: nullNonBypassMdt = true; break;
              case 0xA0: resetNonBypassMdt = true; nullNonBypass = true; break;
              case 0xC0: resetNonBypassMdt = true; nullNonBypassMdt = true; break;
              case 0xE0: resetAllMdt = true; nullNonBypass = true; break;
            }

            for (const f of this.screen.fields) {
              const isInput = this.screen.isInputField(f);
              // Null fill: clear input field content
              if (isInput && (nullNonBypass || (nullNonBypassMdt && f.modified))) {
                const start = this.screen.offset(f.row, f.col);
                for (let i = start; i < start + f.length; i++) {
                  this.screen.buffer[i] = ' ';
                }
              }
              // MDT reset
              if (resetAllMdt || (resetNonBypassMdt && isInput)) {
                f.modified = false;
              }
            }

            // Mark that subsequent SF orders in this WTD should clear stale fields
            if (resetAllMdt || resetNonBypassMdt) {
              this.pendingFieldsClear = true;
            }
          }
          // Parse orders and data following WTD
          pos = this.parseOrders(data, pos);
          modified = true;
          break;
        }

        case CMD.WRITE_ERROR_CODE:
        case CMD.WRITE_ERROR_CODE_WIN: {
          pos++; // skip command byte
          // Skip the error line data — just advance past it
          // Error code commands are followed by data until next command
          pos = this.parseOrders(data, pos);
          modified = true;
          break;
        }

        case CMD.WRITE_STRUCTURED_FIELD: {
          pos++;
          // Structured fields have their own length prefix
          if (pos + 1 < data.length) {
            const sfLen = (data[pos] << 8) | data[pos + 1];
            pos += sfLen; // skip the entire structured field
          }
          break;
        }

        case CMD.ROLL: {
          // ROLL: 3 bytes — direction, topRow(1-based), bottomRow(1-based)
          // Per lib5250 session.c:1463-1487
          pos++;
          if (pos + 2 < data.length) {
            const direction = data[pos++];
            const top = data[pos++] - 1; // convert 1-based to 0-based
            const bot = data[pos++] - 1;
            let lines = direction & 0x1F;
            if ((direction & 0x80) === 0) {
              lines = -lines; // scroll up (negative)
            }
            if (lines !== 0 && top >= 0 && bot >= top && bot < this.screen.rows) {
              this.rollBuffer(top, bot, lines);
            }
            modified = true;
          }
          break;
        }

        default:
          // Not a recognized command at this position
          // Try treating remaining data as orders/text
          pos = this.parseOrders(data, pos);
          modified = true;
          break;
      }
    }

    return modified;
  }

  /**
   * Parse orders and text data within a WTD (or similar) command.
   * Updates the screen buffer and returns the new position.
   */
  private parseOrders(data: Buffer, pos: number): number {
    let currentAddr = this.screen.offset(this.screen.cursorRow, this.screen.cursorCol);
    let currentAttr: number = ATTR.NORMAL;
    let useSymbolCharSet = false; // SA type 0x22 can switch to APL/symbol CGCS
    let afterSBA = false; // Track if we just processed an SBA order (field attrs follow SBA)
    let pendingICRow = -1; // IC stores pending cursor position, applied after WTD
    let pendingICCol = -1;

    while (pos < data.length) {
      const byte = data[pos];

      // Within a WTD, all bytes are orders or EBCDIC data.
      // Command bytes like CLEAR_UNIT (0x40 = EBCDIC space) and WTD (0x11 = SBA)
      // overlap with valid order/data values, so we cannot break on them.
      // parseOrders consumes data until the end of the buffer.

      switch (byte) {
        case ORDER.SBA: {
          // Set Buffer Address: 2 bytes follow (row, col) — 1-based from host
          if (pos + 2 >= data.length) return data.length;
          pos++;
          const row = data[pos++] - 1; // convert 1-based to 0-based
          const col = data[pos++] - 1;
          currentAddr = this.screen.offset(row, col);
          afterSBA = true; // Field attribute may follow
          continue; // skip the afterSBA = false at end of loop
        }

        case ORDER.IC: {
          // Insert Cursor: 2 bytes follow (row, col) — 1-based from host.
          // Per lib5250, IC stores a pending position applied after WTD.
          if (pos + 2 >= data.length) return data.length;
          pos++;
          const icRow = data[pos++] - 1; // convert 1-based to 0-based
          const icCol = data[pos++] - 1;
          pendingICRow = icRow;
          pendingICCol = icCol;
          break;
        }

        case ORDER.MC: {
          // Move Cursor: 2 bytes follow (row, col) — 1-based from host
          if (pos + 2 >= data.length) return data.length;
          pos++;
          const mcRow = data[pos++] - 1; // convert 1-based to 0-based
          const mcCol = data[pos++] - 1;
          this.screen.cursorRow = mcRow;
          this.screen.cursorCol = mcCol;
          currentAddr = this.screen.offset(mcRow, mcCol);
          break;
        }

        case ORDER.RA: {
          // Repeat to Address: 3 bytes (row, col, char) — 1-based address
          if (pos + 3 >= data.length) return data.length;
          pos++;
          const raRow = data[pos++] - 1; // convert 1-based to 0-based
          const raCol = data[pos++] - 1;
          const charByte = data[pos++];
          const targetAddr = this.screen.offset(raRow, raCol);
          const ch = ebcdicToChar(charByte);
          // lib5250 uses addch which wraps; we fill up to target (inclusive of current pos)
          if (targetAddr >= currentAddr) {
            while (currentAddr < targetAddr && currentAddr < this.screen.size) {
              this.screen.setCharAt(currentAddr, ch);
              currentAddr++;
            }
          } else {
            // Wrap-around: fill to end of screen, then from start to target
            while (currentAddr < this.screen.size) {
              this.screen.setCharAt(currentAddr, ch);
              currentAddr++;
            }
            currentAddr = 0;
            while (currentAddr < targetAddr && currentAddr < this.screen.size) {
              this.screen.setCharAt(currentAddr, ch);
              currentAddr++;
            }
          }
          break;
        }

        case ORDER.EA: {
          // Erase to Address: row(1-based), col(1-based), length, attr bytes
          // Per lib5250: reads 3+ bytes — row, col, then a length byte
          // indicating how many more bytes follow (attribute types).
          if (pos + 3 >= data.length) return data.length;
          pos++;
          const eaRow = data[pos++] - 1; // convert 1-based to 0-based
          const eaCol = data[pos++] - 1;
          const eaLen = data[pos++]; // length of attribute list (includes itself)
          // Consume attribute type bytes (eaLen - 1 more bytes)
          const attrBytesToSkip = Math.max(0, eaLen - 1);
          let eaAttr = 0xFF; // default: erase all
          for (let ai = 0; ai < attrBytesToSkip && pos < data.length; ai++) {
            eaAttr = data[pos++];
          }
          const eaTarget = this.screen.offset(eaRow, eaCol);
          // Erase from current to target (lib5250 only erases when attr==0xFF)
          if (eaAttr === 0xFF) {
            if (eaTarget >= currentAddr) {
              while (currentAddr < eaTarget && currentAddr < this.screen.size) {
                this.screen.setCharAt(currentAddr, ' ');
                currentAddr++;
              }
            } else {
              // Wrap-around
              while (currentAddr < this.screen.size) {
                this.screen.setCharAt(currentAddr, ' ');
                currentAddr++;
              }
              currentAddr = 0;
              while (currentAddr < eaTarget && currentAddr < this.screen.size) {
                this.screen.setCharAt(currentAddr, ' ');
                currentAddr++;
              }
            }
          }
          // EA sets current address to target+1 (per spec)
          currentAddr = eaTarget;
          break;
        }

        case ORDER.SOH: {
          // Start of Header: variable-length header for input fields.
          // Per lib5250: SOH clears format table and pending insert cursor.
          // Format: [0x01] [length] [data...]
          // The length byte includes SOH byte + itself, so remaining = length - 2.
          if (pos + 1 >= data.length) return data.length;
          pos++;
          this.screen.fields = [];
          pendingICRow = -1;
          pendingICCol = -1;
          const hdrLen = data[pos++];
          pos += Math.max(0, hdrLen - 2);
          break;
        }

        case ORDER.TD: {
          // Transparent Data: length byte followed by raw data
          if (pos + 1 >= data.length) return data.length;
          pos++;
          const tdLen = data[pos++];
          for (let i = 0; i < tdLen && pos < data.length; i++) {
            this.screen.setCharAt(currentAddr++, ebcdicToChar(data[pos++]));
          }
          break;
        }

        case ORDER.WEA: {
          // Write Extended Attribute: 2 bytes (attr type + value)
          if (pos + 2 >= data.length) return data.length;
          pos++;
          const attrType = data[pos++];
          const attrValue = data[pos++];
          // Apply attribute at current position
          this.screen.setAttrAt(currentAddr, attrValue);
          // Preserve afterSBA — WEA can appear between SBA and a field attribute
          continue;
        }

        case ORDER.SA: {
          // Set Attribute: 2 bytes (attr type + value)
          // Type 0x00 = all/reset, 0x20 = extended highlighting,
          // 0x21 = foreground color, 0x22 = character set (CGCS).
          // Only update display attribute for types that affect it.
          if (pos + 2 >= data.length) return data.length;
          pos++;
          const saType = data[pos++];
          const saValue = data[pos++];
          if (saType === 0x00) {
            currentAttr = saValue;
            useSymbolCharSet = false; // reset
          } else if (saType === 0x20) {
            currentAttr = saValue;
          } else if (saType === 0x22) {
            // Character set (CGCS) — non-default means APL/symbol glyphs
            useSymbolCharSet = saValue !== 0x00;
          }
          // Preserve afterSBA — SA sets color/highlight context before a field attribute
          continue;
        }

        case ORDER.SF: {
          // Start Field: explicit SF order with FFW + optional FCW
          pos++;
          pos = this.parseStartField(data, pos, currentAddr, currentAttr);
          currentAddr++; // attribute byte occupies one screen position
          break;
        }

        default: {
          // Field attribute bytes (0x20-0x3F) only appear immediately after SBA
          if (afterSBA && byte >= 0x20 && byte <= 0x3F) {
            pos = this.parseFieldAttribute(data, pos, currentAddr, currentAttr);
            currentAddr++; // attribute byte occupies one screen position
          } else {
            // Regular EBCDIC character data
            const ch = useSymbolCharSet ? ebcdicSymbolChar(byte) : ebcdicToChar(byte);
            if (currentAddr < this.screen.size) {
              this.screen.setCharAt(currentAddr, ch);
              this.screen.setAttrAt(currentAddr, currentAttr);
              currentAddr++;
            }
            pos++;
          }
          break;
        }
      }
      afterSBA = false;
    }

    // Apply deferred IC cursor position (last IC wins, per lib5250)
    if (pendingICRow >= 0 && pendingICCol >= 0) {
      this.screen.cursorRow = pendingICRow;
      this.screen.cursorCol = pendingICCol;
    }

    return pos;
  }

  /**
   * Parse a bare field attribute byte (0x20-0x3F) that appears after SBA.
   * In basic 5250, this is just 1 byte — no FFW/FCW follows.
   * FFW/FCW are only present with explicit SF (Start Field, 0x1D) order.
   */
  private parseFieldAttribute(data: Buffer, pos: number, addr: number, displayAttr: number): number {
    const attrByte = data[pos++];

    // The attribute byte occupies a position on screen (but is not displayed)
    if (addr < this.screen.size) {
      this.screen.setCharAt(addr, ' ');
    }

    const fieldStartAddr = addr + 1;
    const { row, col } = this.screen.toRowCol(fieldStartAddr);

    // Map attribute byte to display characteristic, falling back to SA context.
    const fieldDisplayAttr = this.decodeDisplayAttr(attrByte, displayAttr);

    // Determine input vs protected from the SA-decoded display attribute.
    // UNDERSCORE and NON_DISPLAY = input fields; everything else = protected.
    const isInput = fieldDisplayAttr === ATTR.UNDERSCORE || fieldDisplayAttr === ATTR.NON_DISPLAY;

    const field: FieldDef = {
      row,
      col,
      length: 0, // Calculated later
      ffw1: isInput ? 0x00 : 0x20, // BYPASS bit set for output fields
      ffw2: 0,
      fcw1: 0,
      fcw2: 0,
      attribute: fieldDisplayAttr,
      rawAttrByte: attrByte,
      modified: false,
    };

    this.clearStaleFieldsOnce();
    this.screen.fields.push(field);
    return pos;
  }

  /**
   * Parse SF (Start Field) order.
   * Per lib5250 session.c:1499-1797:
   *   First byte: if (byte & 0xE0) != 0x20 → input field with FFW
   *               if (byte & 0xE0) == 0x20 → output field, byte IS the attribute
   *   Input field: FFW1, FFW2, then loop reading FCW pairs while (byte & 0xE0) != 0x20,
   *                then attribute byte (0x20-0x3F), then 2-byte field length.
   *   Output field: attribute byte, then 2-byte field length.
   */
  private parseStartField(data: Buffer, pos: number, addr: number, displayAttr: number): number {
    if (addr < this.screen.size) {
      this.screen.setCharAt(addr, ' ');
    }

    if (pos >= data.length) return pos;
    let curByte = data[pos++];

    let ffw1 = 0, ffw2 = 0, fcw1 = 0, fcw2 = 0;
    let inputField = false;

    if ((curByte & 0xE0) !== 0x20) {
      // Input field: curByte is FFW1
      inputField = true;
      ffw1 = curByte;
      if (pos >= data.length) return pos;
      ffw2 = data[pos++];

      // Read FCW pairs: keep reading while next byte is NOT in attribute range
      if (pos >= data.length) return pos;
      curByte = data[pos++];
      while ((curByte & 0xE0) !== 0x20 && pos < data.length) {
        fcw1 = curByte;
        fcw2 = data[pos++];
        if (pos >= data.length) return pos;
        curByte = data[pos++];
      }
    }
    // else: output field, curByte is already the attribute byte

    // curByte is now the attribute byte (0x20-0x3F)
    const rawAttrByte = curByte;
    const fieldDisplayAttr = this.decodeDisplayAttr(rawAttrByte, displayAttr);

    // Read 2-byte field length (always present after attribute byte per lib5250)
    let fieldLength = 0;
    if (pos + 1 < data.length) {
      fieldLength = (data[pos] << 8) | data[pos + 1];
      pos += 2;
    }

    const fieldStartAddr = addr + 1;
    const { row, col } = this.screen.toRowCol(fieldStartAddr);

    const field: FieldDef = {
      row,
      col,
      length: fieldLength,
      ffw1: inputField ? ffw1 : 0x20, // BYPASS bit for output fields
      ffw2,
      fcw1,
      fcw2,
      attribute: fieldDisplayAttr,
      rawAttrByte,
      modified: false,
    };

    this.clearStaleFieldsOnce();
    this.screen.fields.push(field);
    return pos;
  }

  /**
   * Decode a display attribute byte (0x20–0x3F) into an ATTR constant.
   *
   * 5250 field attribute byte layout (bits of lower nibble):
   *   Lower 3 bits (0x07) determine display type:
   *     0 = normal, 1 = column separator, 2 = high intensity,
   *     3 = column separator + HI, 4 = underscore, 5 = underscore + reverse,
   *     6 = underscore + HI, 7 = non-display
   *   Bit 3 (0x08): when set, indicates color field (RED, TURQ, etc.)
   *     Color is determined by the full byte value (0x28=RED, 0x30=TURQ, etc.)
   *     For color fields, the lower 3 bits still encode the display type.
   */
  private decodeDisplayAttr(attrByte: number, displayAttr: number = ATTR.NORMAL): number {
    const type = attrByte & 0x07;
    if (type === 0x07) return ATTR.NON_DISPLAY;
    if (type >= 0x04) return ATTR.UNDERSCORE; // 4, 5, 6 all have underscore
    if (type === 0x02 || type === 0x03) return ATTR.HIGH_INTENSITY;
    if (type === 0x01) return ATTR.COLUMN_SEPARATOR;
    // type === 0x00: normal or color field
    // Bit 3 (0x08) set = color field, treat as normal display (green on most terminals)
    return ATTR.NORMAL;
  }

  /**
   * Roll (scroll) screen buffer rows within [top, bot] by `lines` rows.
   * Negative = scroll up, positive = scroll down.
   * Per lib5250 dbuffer.c:869-899.
   */
  private rollBuffer(top: number, bot: number, lines: number): void {
    const cols = this.screen.cols;
    if (lines < 0) {
      // Scroll up: move rows upward
      for (let r = top; r <= bot; r++) {
        if (r + lines >= top) {
          const dstOff = (r + lines) * cols;
          const srcOff = r * cols;
          for (let c = 0; c < cols; c++) {
            this.screen.buffer[dstOff + c] = this.screen.buffer[srcOff + c];
          }
        }
      }
      // Clear vacated rows at bottom
      for (let r = bot + lines + 1; r <= bot; r++) {
        if (r >= top) {
          const off = r * cols;
          for (let c = 0; c < cols; c++) {
            this.screen.buffer[off + c] = ' ';
          }
        }
      }
    } else {
      // Scroll down: move rows downward
      for (let r = bot; r >= top; r--) {
        if (r + lines <= bot) {
          const dstOff = (r + lines) * cols;
          const srcOff = r * cols;
          for (let c = 0; c < cols; c++) {
            this.screen.buffer[dstOff + c] = this.screen.buffer[srcOff + c];
          }
        }
      }
      // Clear vacated rows at top
      for (let r = top; r < top + lines; r++) {
        if (r <= bot) {
          const off = r * cols;
          for (let c = 0; c < cols; c++) {
            this.screen.buffer[off + c] = ' ';
          }
        }
      }
    }
  }

  /** Clear stale fields when the first SF order arrives after a Reset MDT WTD */
  private clearStaleFieldsOnce(): void {
    if (this.pendingFieldsClear) {
      this.screen.fields = [];
      this.pendingFieldsClear = false;
    }
  }

  /**
   * After parsing a complete screen, calculate field lengths.
   * Call this after all records for a screen have been parsed.
   */
  calculateFieldLengths(): void {
    const fields = this.screen.fields;
    if (fields.length === 0) return;

    // Sort fields by screen position for correct length calculation
    fields.sort((a, b) => {
      const posA = this.screen.offset(a.row, a.col);
      const posB = this.screen.offset(b.row, b.col);
      return posA - posB;
    });

    for (let i = 0; i < fields.length; i++) {
      const current = fields[i];

      // If the field already has an explicit length from SF order, keep it
      if (current.length > 0) continue;

      // Otherwise infer length from adjacent field positions (bare field attributes)
      const currentStart = this.screen.offset(current.row, current.col);

      if (i + 1 < fields.length) {
        const next = fields[i + 1];
        const nextStart = this.screen.offset(next.row, next.col);
        // Length extends to just before the next field's attribute byte
        // (the attribute byte is 1 position before the next field's start)
        current.length = Math.max(0, nextStart - currentStart - 1);
      } else {
        // Last field wraps to first field (5250 screen is circular)
        const firstStart = this.screen.offset(fields[0].row, fields[0].col);
        current.length = Math.max(0, (this.screen.size - currentStart) + firstStart - 1);
        // Cap at a reasonable maximum
        if (current.length > this.screen.cols * 2) {
          current.length = this.screen.cols - current.col;
        }
      }

      // Ensure minimum length of 1
      if (current.length <= 0) current.length = 1;
    }

    // Ensure cursor is in a functional input field. Skip UIM framework
    // artifact fields whose OWN attribute byte doesn't indicate underscore
    // or non-display (they may inherit underscore from SA context but aren't
    // real interactive fields — they exist in the panel header).
    {
      const allInputs = fields.filter(f => this.screen.isInputField(f));
      if (allInputs.length > 0) {
        const lastPos = this.screen.offset(
          allInputs[allInputs.length - 1].row,
          allInputs[allInputs.length - 1].col,
        );
        const functional = allInputs.filter(f =>
          this.screen.hasNativeUnderscore(f) || this.screen.hasNativeNonDisplay(f) ||
          this.screen.offset(f.row, f.col) === lastPos
        );
        const targets = functional.length > 0 ? functional : allInputs;
        const cursorAddr = this.screen.offset(this.screen.cursorRow, this.screen.cursorCol);
        const inTarget = targets.some(f => {
          const start = this.screen.offset(f.row, f.col);
          return cursorAddr >= start && cursorAddr < start + f.length;
        });
        if (!inTarget) {
          const after = targets.find(f => this.screen.offset(f.row, f.col) >= cursorAddr);
          const target = after || targets[targets.length - 1];
          this.screen.cursorRow = target.row;
          this.screen.cursorCol = target.col;
        }
      }
    }

    // Deduplicate fields at the same position (keep the last one)
    const seen = new Map<string, number>();
    for (let i = 0; i < fields.length; i++) {
      const key = `${fields[i].row},${fields[i].col}`;
      seen.set(key, i);
    }
    if (seen.size < fields.length) {
      const keep = new Set(seen.values());
      this.screen.fields = fields.filter((_, i) => keep.has(i));
    }
  }
}
