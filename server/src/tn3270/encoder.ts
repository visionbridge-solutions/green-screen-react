import { ScreenBuffer3270 } from './screen.js';
import { TELNET } from '../tn5250/constants.js';
import { KEY_TO_AID, AID, ORDER, encodeAddress } from './constants.js';
import { charToEbcdic, EBCDIC_SPACE } from '../tn5250/ebcdic.js';

/**
 * Encodes 3270 client responses (AID key + modified field data)
 * for sending back to the z/OS host.
 */
export class TN3270Encoder {
  private screen: ScreenBuffer3270;

  constructor(screen: ScreenBuffer3270) {
    this.screen = screen;
  }

  /**
   * Build a 3270 Read Modified response for an AID key press.
   * Format: AID + cursor_addr(2) + [SBA(1) + addr(2) + field_data]... + IAC EOR
   */
  buildAidResponse(keyName: string): Buffer | null {
    const aidByte = KEY_TO_AID[keyName];
    if (aidByte === undefined) return null;

    const parts: Buffer[] = [];

    // AID byte
    parts.push(Buffer.from([aidByte]));

    // Cursor address (2 bytes)
    parts.push(encodeAddress(this.screen.cursorAddr, this.screen.size));

    // For short-read AIDs (PA keys, Clear), no field data
    if (aidByte === AID.PA1 || aidByte === AID.PA2 || aidByte === AID.PA3 || aidByte === AID.CLEAR) {
      return this.wrapWithEOR(Buffer.concat(parts));
    }

    // Collect modified fields
    for (const field of this.screen.fields) {
      if (!field.modified) continue;
      if (this.screen.isProtected(field)) continue;

      // SBA order + field start address
      const sba = Buffer.alloc(3);
      sba[0] = ORDER.SBA;
      const addrBuf = encodeAddress(field.startAddr, this.screen.size);
      sba[1] = addrBuf[0];
      sba[2] = addrBuf[1];
      parts.push(sba);

      // Field data in EBCDIC, trimmed
      const value = this.screen.getFieldValue(field);
      const ebcdicData = Buffer.alloc(value.length);
      for (let i = 0; i < value.length; i++) {
        ebcdicData[i] = charToEbcdic(value[i]);
      }

      // Trim trailing EBCDIC spaces
      let trimLen = ebcdicData.length;
      while (trimLen > 0 && ebcdicData[trimLen - 1] === EBCDIC_SPACE) {
        trimLen--;
      }

      if (trimLen > 0) {
        parts.push(ebcdicData.subarray(0, trimLen));
      }
    }

    return this.wrapWithEOR(Buffer.concat(parts));
  }

  /**
   * Wrap data with Telnet IAC EOR framing.
   * Escapes any 0xFF bytes in the data.
   */
  private wrapWithEOR(data: Buffer): Buffer {
    const escaped: number[] = [];
    for (let i = 0; i < data.length; i++) {
      escaped.push(data[i]);
      if (data[i] === TELNET.IAC) {
        escaped.push(TELNET.IAC);
      }
    }
    escaped.push(TELNET.IAC, TELNET.EOR);
    return Buffer.from(escaped);
  }

  /**
   * Insert text at the current cursor position in the current field.
   * Returns true if text was successfully inserted.
   */
  insertText(text: string): boolean {
    const field = this.screen.getFieldAtCursor();
    if (!field || this.screen.isProtected(field)) return false;

    let cursorAddr = this.screen.cursorAddr;
    const fieldEnd = (field.startAddr + field.length) % this.screen.size;

    for (const ch of text) {
      if (cursorAddr === fieldEnd) break;
      this.screen.buffer[cursorAddr] = ch;
      cursorAddr = (cursorAddr + 1) % this.screen.size;
    }

    this.screen.cursorAddr = cursorAddr;
    field.modified = true;

    // Set MDT in the attribute
    this.screen.attrBuffer[field.attrAddr] |= 0x01;

    return true;
  }
}
