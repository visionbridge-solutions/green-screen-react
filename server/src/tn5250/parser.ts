import { ScreenBuffer, FieldDef } from './screen.js';
import { CMD, ORDER, OPCODE, ATTR } from './constants.js';
import { ebcdicToChar, EBCDIC_SPACE } from './ebcdic.js';

/**
 * Parses 5250 data stream records and updates the screen buffer.
 */
export class TN5250Parser {
  private screen: ScreenBuffer;

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
    const varFlag = record[4];
    const reserved = record[5];
    const opcode = record[6];

    // Check for GDS record type
    if (recordType !== 0x12A0) {
      // Not a GDS record — might be raw data or something else
      return this.tryParseRawData(record);
    }

    let modified = false;

    switch (opcode) {
      case OPCODE.OUTPUT:
      case OPCODE.PUT_GET:
        // Contains one or more 5250 commands after the header
        modified = this.parseCommands(record, 7);
        break;

      case OPCODE.INVITE:
        // Invite: server is ready for input (no screen data typically)
        break;

      case OPCODE.SAVE_SCREEN:
      case OPCODE.RESTORE_SCREEN:
        // We don't implement save/restore, just ignore
        break;

      default:
        // Try parsing as commands anyway
        if (record.length > 7) {
          modified = this.parseCommands(record, 7);
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

            // CC1 bit 5: Reset MDT flags
            if (cc1 & 0x20) {
              for (const f of this.screen.fields) {
                f.modified = false;
              }
            }
            // CC1 bit 6: Clear all input fields (null fill)
            if (cc1 & 0x40) {
              for (const f of this.screen.fields) {
                if (this.screen.isInputField(f)) {
                  const start = this.screen.offset(f.row, f.col);
                  for (let i = start; i < start + f.length; i++) {
                    this.screen.buffer[i] = ' ';
                  }
                }
              }
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
          pos++; // skip command byte
          if (pos + 1 < data.length) {
            const rollCC = data[pos++];
            const rollCount = data[pos++];
            // Simple roll: move content up or down
            // For now just mark as modified
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

    while (pos < data.length) {
      const byte = data[pos];

      // Check if we've hit another command byte — stop parsing orders
      if (byte === CMD.WRITE_TO_DISPLAY || byte === CMD.CLEAR_UNIT ||
          byte === CMD.CLEAR_FORMAT_TABLE || byte === CMD.WRITE_STRUCTURED_FIELD ||
          byte === CMD.WRITE_ERROR_CODE || byte === CMD.ROLL) {
        break;
      }

      switch (byte) {
        case ORDER.SBA: {
          // Set Buffer Address: 2 bytes follow (row, col)
          if (pos + 2 >= data.length) return data.length;
          pos++;
          const row = data[pos++];
          const col = data[pos++];
          currentAddr = this.screen.offset(row, col);
          break;
        }

        case ORDER.IC: {
          // Insert Cursor: set cursor to current address
          pos++;
          const { row, col } = this.screen.toRowCol(currentAddr);
          this.screen.cursorRow = row;
          this.screen.cursorCol = col;
          break;
        }

        case ORDER.MC: {
          // Move Cursor: 2 bytes follow (row, col)
          if (pos + 2 >= data.length) return data.length;
          pos++;
          const row = data[pos++];
          const col = data[pos++];
          this.screen.cursorRow = row;
          this.screen.cursorCol = col;
          currentAddr = this.screen.offset(row, col);
          break;
        }

        case ORDER.RA: {
          // Repeat to Address: repeat a char up to an address
          if (pos + 3 >= data.length) return data.length;
          pos++;
          const toRow = data[pos++];
          const toCol = data[pos++];
          const charByte = data[pos++];
          const targetAddr = this.screen.offset(toRow, toCol);
          const ch = ebcdicToChar(charByte);
          while (currentAddr < targetAddr && currentAddr < this.screen.size) {
            this.screen.setCharAt(currentAddr, ch);
            currentAddr++;
          }
          break;
        }

        case ORDER.EA: {
          // Erase to Address: fill with spaces up to an address
          if (pos + 2 >= data.length) return data.length;
          pos++;
          const toRow = data[pos++];
          const toCol = data[pos++];
          const targetAddr = this.screen.offset(toRow, toCol);
          while (currentAddr < targetAddr && currentAddr < this.screen.size) {
            this.screen.setCharAt(currentAddr, ' ');
            currentAddr++;
          }
          break;
        }

        case ORDER.SOH: {
          // Start of Header: variable-length header for input fields
          if (pos + 1 >= data.length) return data.length;
          pos++;
          const hdrLen = data[pos++];
          // Skip header data (contains error line, etc.)
          pos += Math.max(0, hdrLen - 2); // length includes the length byte itself sometimes
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
          break;
        }

        case ORDER.SA: {
          // Set Attribute: 2 bytes (attr type + value)
          if (pos + 2 >= data.length) return data.length;
          pos++;
          const saType = data[pos++];
          const saValue = data[pos++];
          currentAttr = saValue;
          break;
        }

        case ORDER.SF: {
          // Start Field: field attribute byte + FFW + optional FCW
          // Actually, in 5250, SF isn't always 0x1D. The field definition
          // comes after SBA as attribute byte (0x20-0x3F range).
          // But let's handle explicit SF if encountered:
          pos++;
          pos = this.parseFieldDefinition(data, pos, currentAddr, currentAttr);
          break;
        }

        default: {
          // Check for field attribute bytes (0x20-0x3F)
          if (byte >= 0x20 && byte <= 0x3F && this.isLikelyFieldAttribute(data, pos)) {
            pos = this.parseFieldAttribute(data, pos, currentAddr, currentAttr);
          } else {
            // Regular EBCDIC character data
            const ch = ebcdicToChar(byte);
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
    }

    return pos;
  }

  /** Try to detect if a byte in the 0x20-0x3F range is a field attribute vs regular character */
  private isLikelyFieldAttribute(data: Buffer, pos: number): boolean {
    // Field attributes in 5250 are typically preceded by SBA and followed by FFW bytes
    // This is a heuristic — in practice, the WTD command structure makes this deterministic
    // For the 0x20 byte specifically, it's also EBCDIC space, so we need context
    const byte = data[pos];

    // 0x20 is very common as both space and attribute — don't treat as field attr
    if (byte === 0x20) return false;

    // For other bytes in 0x21-0x3F range, check if followed by FFW-like bytes
    if (pos + 2 < data.length) {
      const next = data[pos + 1];
      const after = data[pos + 2];
      // FFW first byte typically has specific bit patterns
      // If followed by reasonable FFW bytes, treat as field attribute
      return (next & 0x40) !== 0 || next === 0x00;
    }

    return false;
  }

  /** Parse a field attribute byte and the following FFW/FCW */
  private parseFieldAttribute(data: Buffer, pos: number, addr: number, displayAttr: number): number {
    const attrByte = data[pos++];

    // The attribute byte occupies a position on screen (but is not displayed)
    // Mark this position with the attribute
    if (addr < this.screen.size) {
      this.screen.setCharAt(addr, ' '); // Attribute position shows as space
    }

    // Parse FFW (Field Format Word) — 2 bytes
    if (pos + 1 >= data.length) return pos;
    const ffw1 = data[pos++];
    const ffw2 = data[pos++];

    // Check for FCW (Field Control Word) — optional, 2 bytes
    let fcw1 = 0, fcw2 = 0;
    if (pos + 1 < data.length) {
      // FCW is present if the first byte has bit 7 set and is not another order
      const maybeFcw = data[pos];
      if (maybeFcw >= 0x80 && maybeFcw !== 0xFF) {
        fcw1 = data[pos++];
        fcw2 = data[pos++];
      }
    }

    // Determine field length: from current position to next field attribute or end of screen
    // We'll calculate it later when all fields are known; for now use a placeholder
    const fieldStartAddr = addr + 1; // Field data starts after the attribute byte
    const { row, col } = this.screen.toRowCol(fieldStartAddr);

    // Determine display attribute from the attribute byte
    let fieldDisplayAttr = displayAttr;
    // Map attribute byte to display characteristics
    if (attrByte & 0x04) fieldDisplayAttr = ATTR.UNDERSCORE;
    if (attrByte & 0x08) fieldDisplayAttr = ATTR.HIGH_INTENSITY;
    if (attrByte & 0x01) fieldDisplayAttr = ATTR.REVERSE;
    if (attrByte === 0x27 || (attrByte & 0x07) === 0x07) fieldDisplayAttr = ATTR.NON_DISPLAY;

    const field: FieldDef = {
      row,
      col,
      length: 0, // Will be calculated
      ffw1,
      ffw2,
      fcw1,
      fcw2,
      attribute: fieldDisplayAttr,
      modified: false,
    };

    this.screen.fields.push(field);
    return pos;
  }

  /** Parse explicit SF order field definition */
  private parseFieldDefinition(data: Buffer, pos: number, addr: number, displayAttr: number): number {
    // Similar to parseFieldAttribute but for explicit SF order
    return this.parseFieldAttribute(data, pos - 1, addr, displayAttr);
  }

  /**
   * After parsing a complete screen, calculate field lengths.
   * Call this after all records for a screen have been parsed.
   */
  calculateFieldLengths(): void {
    const fields = this.screen.fields;
    if (fields.length === 0) return;

    for (let i = 0; i < fields.length; i++) {
      const current = fields[i];
      const currentStart = this.screen.offset(current.row, current.col);

      if (i + 1 < fields.length) {
        const next = fields[i + 1];
        const nextStart = this.screen.offset(next.row, next.col);
        // Length extends to just before the next field's attribute byte
        // (the attribute byte is 1 position before the next field's start)
        current.length = Math.max(0, nextStart - currentStart - 1);
      } else {
        // Last field extends to end of screen or a reasonable default
        const endAddr = this.screen.size;
        current.length = Math.max(0, endAddr - currentStart);
        // Cap at a reasonable maximum
        if (current.length > this.screen.cols * 2) {
          current.length = this.screen.cols - current.col;
        }
      }

      // Ensure minimum length of 1
      if (current.length <= 0) current.length = 1;
    }
  }
}
