import { ScreenBuffer3270 } from './screen.js';
import { CMD, SNA_CMD, ORDER, FA, EXT_ATTR, WCC, decodeAddress } from './constants.js';
import { ebcdicToChar } from '../encoding/ebcdic.js';

/** Which reply a host-initiated read command is waiting for. */
export type PendingRead = 'buffer' | 'modified' | 'modifiedAll' | null;

/** Order handlers return the next parse position, or STOP on truncation. */
const STOP = -1;

/**
 * Parses 3270 data stream records and updates the screen buffer.
 */
export class TN3270Parser {
  private readonly screen: ScreenBuffer3270;

  /**
   * Host-initiated read pending a reply. The parser never writes to the
   * socket itself — the handler checks this after parseRecord() and flushes
   * the matching encoder reply (same pattern as the 5250 pendingQueryReply).
   */
  pendingRead: PendingRead = null;
  /** Host sent WSF Read Partition (Query) — handler must send a Query Reply. */
  pendingQueryReply: boolean = false;

  /**
   * Character attributes set by SA orders — apply to every subsequent data
   * byte written until changed or reset (SA 0x00) / next Write command.
   */
  private saHighlight = 0;
  private saColor = 0;
  /** Whether the current Write mutated the screen (set by order handlers). */
  private writeModified = false;

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
      case CMD.ERASE_WRITE_ALTERNATE:
      case SNA_CMD.ERASE_WRITE_ALTERNATE:
        this.screen.clear();
        modified = this.parseWrite(record, 1, false);
        break;

      case CMD.ERASE_ALL_UNPROTECTED:
      case SNA_CMD.ERASE_ALL_UNPROTECTED:
        // Per GA23-0059: EAU clears unprotected positions to NULs, resets
        // their MDTs, restores the keyboard, and resets the AID.
        this.screen.clearUnprotected();
        this.screen.keyboardLocked = false;
        modified = true;
        break;

      case CMD.WRITE_STRUCTURED_FIELD:
      case SNA_CMD.WRITE_STRUCTURED_FIELD:
        modified = this.parseStructuredFields(record, 1);
        break;

      case CMD.READ_BUFFER:
      case SNA_CMD.READ_BUFFER:
        this.pendingRead = 'buffer';
        break;

      case CMD.READ_MODIFIED:
      case SNA_CMD.READ_MODIFIED:
        this.pendingRead = 'modified';
        break;

      case CMD.READ_MODIFIED_ALL:
      case SNA_CMD.READ_MODIFIED_ALL:
        this.pendingRead = 'modifiedAll';
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

    // A new Write ends any character-attribute run from a previous record.
    this.saHighlight = 0;
    this.saColor = 0;
    this.writeModified = false;

    if (!skipWCC && pos < data.length) {
      this.applyWCC(data[pos++]);
    }

    while (pos >= 0 && pos < data.length) {
      pos = this.applyOrder(data, pos);
    }

    return this.writeModified;
  }

  /** Dispatch one order (or data byte) at `pos`; returns next pos or STOP. */
  private applyOrder(data: Buffer, pos: number): number {
    switch (data[pos]) {
      case ORDER.SBA: return this.orderSBA(data, pos);
      case ORDER.SF:  return this.orderSF(data, pos);
      case ORDER.SFE: return this.orderSFE(data, pos);
      case ORDER.SA:  return this.orderSA(data, pos);
      case ORDER.MF:  return this.orderMF(data, pos);
      case ORDER.IC:
        this.screen.cursorAddr = this.screen.currentAddr;
        return pos + 1;
      case ORDER.PT:
        this.advanceToNextUnprotected();
        return pos + 1;
      case ORDER.RA:  return this.orderRA(data, pos);
      case ORDER.EUA: return this.orderEUA(data, pos);
      case ORDER.GE:  return this.orderGE(data, pos);
      default:        return this.dataByte(data, pos);
    }
  }

  /** Set Buffer Address: 2 address bytes follow. */
  private orderSBA(data: Buffer, pos: number): number {
    if (pos + 2 >= data.length) return STOP;
    const addr = decodeAddress(data[pos + 1], data[pos + 2]);
    this.screen.currentAddr = addr % this.screen.size;
    return pos + 3;
  }

  /** Start Field: 1 attribute byte follows. */
  private orderSF(data: Buffer, pos: number): number {
    if (pos + 1 >= data.length) return STOP;
    this.screen.setFieldAttribute(this.screen.currentAddr, data[pos + 1]);
    this.screen.currentAddr = (this.screen.currentAddr + 1) % this.screen.size;
    this.writeModified = true;
    return pos + 2;
  }

  /** Start Field Extended: pair count, then (type, value) pairs. */
  private orderSFE(data: Buffer, pos: number): number {
    if (pos + 1 >= data.length) return STOP;
    pos++;
    const pairCount = data[pos++];
    let fieldAttr = 0;
    let extHighlight = 0;
    let extColor = 0;

    for (let i = 0; i < pairCount && pos + 1 < data.length; i++) {
      const attrType = data[pos++];
      const attrValue = data[pos++];
      if (attrType === 0xC0) {
        fieldAttr = attrValue; // basic field attribute
      } else if (attrType === EXT_ATTR.HIGHLIGHT) {
        extHighlight = attrValue;
      } else if (attrType === EXT_ATTR.COLOR) {
        extColor = attrValue;
      }
      // Other extended attributes (charset, validation, outlining) are
      // tolerated and skipped.
    }

    this.screen.setFieldAttribute(this.screen.currentAddr, fieldAttr || FA.PROTECTED);
    this.screen.highlightBuffer[this.screen.currentAddr] = extHighlight;
    this.screen.colorBuffer[this.screen.currentAddr] = extColor;
    this.screen.currentAddr = (this.screen.currentAddr + 1) % this.screen.size;
    this.writeModified = true;
    return pos;
  }

  /**
   * Set Attribute: starts a character-attribute run — applies to every
   * subsequent data byte until changed or reset (type 0x00 = ALL).
   */
  private orderSA(data: Buffer, pos: number): number {
    if (pos + 2 >= data.length) return STOP;
    const saType = data[pos + 1];
    const saValue = data[pos + 2];
    if (saType === EXT_ATTR.ALL) {
      this.saHighlight = 0;
      this.saColor = 0;
    } else if (saType === EXT_ATTR.HIGHLIGHT) {
      this.saHighlight = saValue;
    } else if (saType === EXT_ATTR.COLOR) {
      this.saColor = saValue;
    }
    return pos + 3;
  }

  /**
   * Modify Field: applies (type, value) pairs to the field attribute AT the
   * current address, then advances past it. If the current address holds no
   * field attribute the order is skipped (the spec treats it as a rejected
   * op; we consume its pairs and continue).
   */
  private orderMF(data: Buffer, pos: number): number {
    if (pos + 1 >= data.length) return STOP;
    pos++;
    const pairCount = data[pos++];
    const cur = this.screen.currentAddr;
    const atAttr = this.screen.attrBuffer[cur] !== 0;
    for (let i = 0; i < pairCount && pos + 1 < data.length; i++) {
      const mfType = data[pos++];
      const mfValue = data[pos++];
      if (!atAttr) continue;
      if (mfType === 0xC0) {
        this.screen.attrBuffer[cur] = mfValue;
      } else if (mfType === EXT_ATTR.HIGHLIGHT) {
        this.screen.highlightBuffer[cur] = mfValue;
      } else if (mfType === EXT_ATTR.COLOR) {
        this.screen.colorBuffer[cur] = mfValue;
      }
    }
    if (atAttr) {
      this.screen.currentAddr = (cur + 1) % this.screen.size;
      this.writeModified = true;
    }
    return pos;
  }

  /** Repeat to Address: 2 address bytes + 1 char byte (optionally GE'd). */
  private orderRA(data: Buffer, pos: number): number {
    if (pos + 3 >= data.length) return STOP;
    const targetAddr = decodeAddress(data[pos + 1], data[pos + 2]);
    let charByte = data[pos + 3];
    pos += 4;
    if (charByte === ORDER.GE && pos < data.length) {
      charByte = data[pos++]; // graphic escape — next byte is the char
    }
    const repeatChar = charByte === 0x00 ? ' ' : ebcdicToChar(charByte);

    const target = targetAddr % this.screen.size;
    let addr = this.screen.currentAddr;
    // Per spec: stop address == current address fills the ENTIRE buffer.
    do {
      this.writeData(addr, repeatChar, charByte);
      addr = (addr + 1) % this.screen.size;
    } while (addr !== target);
    this.screen.currentAddr = target;
    this.writeModified = true;
    return pos;
  }

  /**
   * Erase Unprotected to Address: 2 address bytes. Protection is judged
   * from the LIVE attribute buffer — the fields list is only rebuilt after
   * the record, so it is stale for orders inside the same Write.
   */
  private orderEUA(data: Buffer, pos: number): number {
    if (pos + 2 >= data.length) return STOP;
    const euaEnd = decodeAddress(data[pos + 1], data[pos + 2]) % this.screen.size;
    let governing = this.governingAttr(this.screen.currentAddr);
    let euaAddr = this.screen.currentAddr;
    while (euaAddr !== euaEnd) {
      const posAttr = this.screen.attrBuffer[euaAddr];
      if (posAttr !== 0) {
        governing = posAttr; // attribute byte itself is never erased
      } else if ((governing & FA.PROTECTED) === 0) {
        // unprotected — or unformatted screen (governing 0), which the
        // spec also erases
        this.screen.setCharAt(euaAddr, ' ', 0x00);
      }
      euaAddr = (euaAddr + 1) % this.screen.size;
    }
    this.screen.currentAddr = euaEnd;
    this.writeModified = true;
    return pos + 3;
  }

  /** Attribute governing `addr`: nearest field attribute at/behind it (0 = unformatted). */
  private governingAttr(addr: number): number {
    const size = this.screen.size;
    for (let back = 1; back <= size; back++) {
      const a = (addr - back + size) % size;
      if (this.screen.attrBuffer[a] !== 0) return this.screen.attrBuffer[a];
    }
    return 0;
  }

  /** Graphic Escape: next byte is a graphic character. */
  private orderGE(data: Buffer, pos: number): number {
    pos++;
    if (pos < data.length) {
      const geByte = data[pos++];
      this.writeData(this.screen.currentAddr, ebcdicToChar(geByte), geByte);
      this.screen.currentAddr = (this.screen.currentAddr + 1) % this.screen.size;
      this.writeModified = true;
    }
    return pos;
  }

  /** Regular EBCDIC data byte (0x00 = NUL position: blank but not space). */
  private dataByte(data: Buffer, pos: number): number {
    const byte = data[pos];
    const ch = byte === 0x00 ? ' ' : ebcdicToChar(byte);
    this.writeData(this.screen.currentAddr, ch, byte);
    this.screen.currentAddr = (this.screen.currentAddr + 1) % this.screen.size;
    this.writeModified = true;
    return pos + 1;
  }

  /** Apply Write Control Character bits (GA23-0059 layout). */
  private applyWCC(wcc: number): void {
    if (wcc & WCC.RESET_MDT) {
      for (const field of this.screen.fields) {
        field.modified = false;
        const attr = this.screen.attrBuffer[field.attrAddr];
        if (attr !== 0) {
          this.screen.attrBuffer[field.attrAddr] = attr & ~FA.MDT;
        }
      }
    }
    if (wcc & WCC.KEYBOARD_RESTORE) {
      this.screen.keyboardLocked = false;
    }
    if (wcc & WCC.SOUND_ALARM) {
      this.screen.pendingAlarm = true;
    }
  }

  /** Write one data byte: char + raw byte + any active SA character run. */
  private writeData(addr: number, char: string, rawByte: number): void {
    this.screen.setCharAt(addr, char, rawByte);
    if (this.saHighlight !== 0 || this.saColor !== 0) {
      const a = addr % this.screen.size;
      if (this.saHighlight !== 0) this.screen.highlightBuffer[a] = this.saHighlight;
      if (this.saColor !== 0) this.screen.colorBuffer[a] = this.saColor;
    }
  }

  /** Parse structured fields */
  private parseStructuredFields(data: Buffer, offset: number): boolean {
    let pos = offset;
    let modified = false;

    while (pos + 2 < data.length) {
      const sfLen = (data[pos] << 8) | data[pos + 1];
      if (sfLen < 3 || pos + sfLen > data.length) break;

      const sfId = data[pos + 2];
      // Read Partition (0x01) with type Query (0x02) / Query List (0x03):
      // the host is probing device capabilities and waits for a Query Reply.
      if (sfId === 0x01 && sfLen >= 5) {
        const type = data[pos + 4];
        if (type === 0x02 || type === 0x03) {
          this.pendingQueryReply = true;
        }
      }

      pos += sfLen;
      modified = true;
    }

    return modified;
  }

  /**
   * Advance the buffer address past the next unprotected field attribute.
   * Judged from the live attrBuffer (fields list is stale mid-record).
   */
  private advanceToNextUnprotected(): void {
    const startAddr = this.screen.currentAddr;
    let addr = (startAddr + 1) % this.screen.size;

    while (addr !== startAddr) {
      const attr = this.screen.attrBuffer[addr];
      if (attr !== 0 && (attr & FA.PROTECTED) === 0) {
        this.screen.currentAddr = (addr + 1) % this.screen.size;
        return;
      }
      addr = (addr + 1) % this.screen.size;
    }
  }
}
