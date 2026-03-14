import { ScreenBuffer3270 } from './screen.js';
import { CMD, SNA_CMD, ORDER, FA, EXT_ATTR, decodeAddress } from './constants.js';
import { ebcdicToChar } from '../tn5250/ebcdic.js';

/**
 * Parses 3270 data stream records and updates the screen buffer.
 */
export class TN3270Parser {
  private screen: ScreenBuffer3270;

  constructor(screen: ScreenBuffer3270) {
    this.screen = screen;
  }

  /**
   * Parse a 3270 data stream record.
   * Returns true if the screen was modified.
   */
  parseRecord(record: Buffer): boolean {
    if (record.length < 1) return false;

    const cmd = record[0];
    let modified = false;

    switch (cmd) {
      case CMD.WRITE:
      case SNA_CMD.WRITE:
        modified = this.parseWrite(record, 1, false);
        break;

      case CMD.ERASE_WRITE:
      case SNA_CMD.ERASE_WRITE:
        this.screen.clear();
        modified = this.parseWrite(record, 1, false);
        break;

      case CMD.ERASE_WRITE_ALTERNATE:
      case SNA_CMD.ERASE_WRITE_ALTERNATE:
        this.screen.clear();
        modified = this.parseWrite(record, 1, false);
        break;

      case CMD.ERASE_ALL_UNPROTECTED:
      case SNA_CMD.ERASE_ALL_UNPROTECTED:
        this.screen.clearUnprotected();
        modified = true;
        break;

      case CMD.WRITE_STRUCTURED_FIELD:
      case SNA_CMD.WRITE_STRUCTURED_FIELD:
        // Structured fields — parse each SF
        modified = this.parseStructuredFields(record, 1);
        break;

      case CMD.READ_BUFFER:
      case CMD.READ_MODIFIED:
      case CMD.READ_MODIFIED_ALL:
      case SNA_CMD.READ_BUFFER:
      case SNA_CMD.READ_MODIFIED:
      case SNA_CMD.READ_MODIFIED_ALL:
        // Read commands — don't modify screen, but may need to trigger a response
        // Handled at the handler level
        break;

      default:
        // Try parsing as a write command anyway (some servers omit the command byte)
        if (record.length > 1) {
          modified = this.parseWrite(record, 0, true);
        }
        break;
    }

    if (modified) {
      this.screen.rebuildFields();
    }

    return modified;
  }

  /**
   * Parse a Write or Erase/Write command body.
   * Starts at `offset` which points to the WCC byte.
   */
  private parseWrite(data: Buffer, offset: number, skipWCC: boolean): boolean {
    let pos = offset;

    // Parse WCC (Write Control Character)
    if (!skipWCC && pos < data.length) {
      const wcc = data[pos++];
      // WCC bit 0: reset MDT flags
      if (wcc & 0x01) {
        for (const field of this.screen.fields) {
          field.modified = false;
          // Clear MDT bit in attribute buffer too
          const attr = this.screen.attrBuffer[field.attrAddr];
          if (attr !== 0) {
            this.screen.attrBuffer[field.attrAddr] = attr & ~FA.MDT;
          }
        }
      }
    }

    let modified = false;

    // Parse orders and data
    while (pos < data.length) {
      const byte = data[pos];

      switch (byte) {
        case ORDER.SBA: {
          // Set Buffer Address: 2 address bytes follow
          if (pos + 2 >= data.length) return modified;
          pos++;
          const addr = decodeAddress(data[pos], data[pos + 1]);
          pos += 2;
          this.screen.currentAddr = addr % this.screen.size;
          break;
        }

        case ORDER.SF: {
          // Start Field: 1 attribute byte follows
          if (pos + 1 >= data.length) return modified;
          pos++;
          const attr = data[pos++];
          this.screen.setFieldAttribute(this.screen.currentAddr, attr);
          this.screen.currentAddr = (this.screen.currentAddr + 1) % this.screen.size;
          modified = true;
          break;
        }

        case ORDER.SFE: {
          // Start Field Extended: pair count, then (type, value) pairs
          if (pos + 1 >= data.length) return modified;
          pos++;
          const pairCount = data[pos++];
          let fieldAttr = 0;
          let extHighlight = 0;
          let extColor = 0;

          for (let i = 0; i < pairCount && pos + 1 < data.length; i++) {
            const attrType = data[pos++];
            const attrValue = data[pos++];

            if (attrType === 0xC0) {
              // Basic field attribute
              fieldAttr = attrValue;
            } else if (attrType === EXT_ATTR.HIGHLIGHT) {
              extHighlight = attrValue;
            } else if (attrType === EXT_ATTR.COLOR) {
              extColor = attrValue;
            }
            // Other extended attributes ignored for now
          }

          this.screen.setFieldAttribute(this.screen.currentAddr, fieldAttr || FA.PROTECTED);
          this.screen.highlightBuffer[this.screen.currentAddr] = extHighlight;
          this.screen.colorBuffer[this.screen.currentAddr] = extColor;
          this.screen.currentAddr = (this.screen.currentAddr + 1) % this.screen.size;
          modified = true;
          break;
        }

        case ORDER.SA: {
          // Set Attribute: type + value
          if (pos + 2 >= data.length) return modified;
          pos++;
          const saType = data[pos++];
          const saValue = data[pos++];
          // SA affects subsequent characters until next SA/SF
          if (saType === EXT_ATTR.HIGHLIGHT) {
            this.screen.highlightBuffer[this.screen.currentAddr] = saValue;
          } else if (saType === EXT_ATTR.COLOR) {
            this.screen.colorBuffer[this.screen.currentAddr] = saValue;
          }
          break;
        }

        case ORDER.MF: {
          // Modify Field: pair count, then (type, value) pairs
          if (pos + 1 >= data.length) return modified;
          pos++;
          const mfPairCount = data[pos++];
          for (let i = 0; i < mfPairCount && pos + 1 < data.length; i++) {
            pos += 2; // Skip type + value
          }
          break;
        }

        case ORDER.IC: {
          // Insert Cursor: set cursor to current buffer address
          pos++;
          this.screen.cursorAddr = this.screen.currentAddr;
          break;
        }

        case ORDER.PT: {
          // Program Tab: advance to next unprotected field
          pos++;
          this.advanceToNextUnprotected();
          break;
        }

        case ORDER.RA: {
          // Repeat to Address: 2 address bytes + 1 char byte
          if (pos + 3 >= data.length) return modified;
          pos++;
          const targetAddr = decodeAddress(data[pos], data[pos + 1]);
          pos += 2;
          const charByte = data[pos++];

          let repeatChar: string;
          if (charByte === ORDER.GE && pos < data.length) {
            // Graphic escape — next byte is an APL/graphic char
            repeatChar = ebcdicToChar(data[pos++]);
          } else {
            repeatChar = ebcdicToChar(charByte);
          }

          const target = targetAddr % this.screen.size;
          let addr = this.screen.currentAddr;
          while (addr !== target) {
            this.screen.setCharAt(addr, repeatChar);
            addr = (addr + 1) % this.screen.size;
          }
          this.screen.currentAddr = target;
          modified = true;
          break;
        }

        case ORDER.EUA: {
          // Erase Unprotected to Address: 2 address bytes
          if (pos + 2 >= data.length) return modified;
          pos++;
          const euaTarget = decodeAddress(data[pos], data[pos + 1]);
          pos += 2;

          const euaEnd = euaTarget % this.screen.size;
          let euaAddr = this.screen.currentAddr;
          while (euaAddr !== euaEnd) {
            // Only erase if position is in an unprotected field
            const field = this.screen.getFieldAt(euaAddr);
            if (field && !this.screen.isProtected(field)) {
              this.screen.setCharAt(euaAddr, ' ');
            }
            euaAddr = (euaAddr + 1) % this.screen.size;
          }
          this.screen.currentAddr = euaEnd;
          modified = true;
          break;
        }

        case ORDER.GE: {
          // Graphic Escape: next byte is a graphic character
          pos++;
          if (pos < data.length) {
            const geChar = ebcdicToChar(data[pos++]);
            this.screen.setCharAt(this.screen.currentAddr, geChar);
            this.screen.currentAddr = (this.screen.currentAddr + 1) % this.screen.size;
            modified = true;
          }
          break;
        }

        default: {
          // Regular EBCDIC character data
          const ch = ebcdicToChar(byte);
          this.screen.setCharAt(this.screen.currentAddr, ch);
          this.screen.currentAddr = (this.screen.currentAddr + 1) % this.screen.size;
          pos++;
          modified = true;
          break;
        }
      }
    }

    return modified;
  }

  /** Parse structured fields */
  private parseStructuredFields(data: Buffer, offset: number): boolean {
    let pos = offset;
    let modified = false;

    while (pos + 2 < data.length) {
      const sfLen = (data[pos] << 8) | data[pos + 1];
      if (sfLen < 3 || pos + sfLen > data.length) break;

      // Skip the structured field (we may implement query reply later)
      pos += sfLen;
      modified = true;
    }

    return modified;
  }

  /** Advance cursor to the start of the next unprotected field */
  private advanceToNextUnprotected(): void {
    const startAddr = this.screen.currentAddr;
    let addr = (startAddr + 1) % this.screen.size;

    while (addr !== startAddr) {
      // Check if there's a field attribute at this position
      if (this.screen.attrBuffer[addr] !== 0) {
        const field = this.screen.fields.find(f => f.attrAddr === addr);
        if (field && !this.screen.isProtected(field)) {
          this.screen.currentAddr = field.startAddr;
          return;
        }
      }
      addr = (addr + 1) % this.screen.size;
    }
  }
}
