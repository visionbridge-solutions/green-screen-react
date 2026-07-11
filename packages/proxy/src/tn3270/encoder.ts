import { ScreenBuffer3270 } from './screen.js';
import { KEY_TO_AID, AID, ORDER, encodeAddress } from './constants.js';
import { charToEbcdic, EBCDIC_SPACE } from '../encoding/ebcdic.js';

/**
 * Encodes 3270 client responses (AID key + modified field data)
 * for sending back to the z/OS host.
 */
export class TN3270Encoder {
  private readonly screen: ScreenBuffer3270;

  constructor(screen: ScreenBuffer3270) {
    this.screen = screen;
  }

  /**
   * Build a 3270 Read Modified response for an AID key press.
   * Format: AID + cursor_addr(2) + [SBA(1) + addr(2) + field_data]...\n   * Returns the RAW record — the connection adds TN3270E header + EOR framing.
   */
  buildAidResponse(keyName: string): Buffer | null {
    const aidByte = KEY_TO_AID[keyName];
    if (aidByte === undefined) return null;
    return this.buildReadModified(aidByte, false);
  }

  /**
   * Reply to a HOST-initiated Read Modified (All). Carries the AID of the
   * last attention the operator sent (GA23-0059: the AID is not reset by
   * the read). `all` = Read Modified All — field data is included even
   * when the last AID was a short-read key.
   */
  buildReadModifiedReply(all: boolean): Buffer {
    return this.buildReadModified(this.screen.lastAid, all);
  }

  /**
   * Reply to a HOST-initiated Read Buffer: AID + cursor + the ENTIRE
   * buffer — SF+attribute at each field-attribute position, raw data
   * bytes elsewhere (NULs preserved, unlike Read Modified).
   */
  buildReadBufferReply(): Buffer {
    const body: number[] = [this.screen.lastAid];
    const cursor = encodeAddress(this.screen.cursorAddr, this.screen.size);
    body.push(cursor[0], cursor[1]);
    for (let addr = 0; addr < this.screen.size; addr++) {
      const attr = this.screen.attrBuffer[addr];
      if (attr !== 0) {
        body.push(ORDER.SF, attr);
      } else {
        body.push(this.screen.rawBuffer[addr]);
      }
    }
    return Buffer.from(body);
  }

  private static isShortReadAid(aid: number): boolean {
    return aid === AID.PA1 || aid === AID.PA2 || aid === AID.PA3 || aid === AID.CLEAR;
  }

  private buildReadModified(aidByte: number, forceFields: boolean): Buffer {
    // Short-read AIDs (PA keys, Clear) transmit the AID byte ONLY — no
    // cursor address, no field data (GA23-0059 "short read") — unless the
    // host explicitly asked for Read Modified All.
    if (!forceFields && TN3270Encoder.isShortReadAid(aidByte)) {
      return Buffer.from([aidByte]);
    }

    // AID byte + cursor address (2 bytes)
    const parts: Buffer[] = [
      Buffer.from([aidByte]),
      encodeAddress(this.screen.cursorAddr, this.screen.size),
    ];

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

      // Field data in EBCDIC — Read Modified omits NULs entirely and we
      // additionally trim trailing spaces (hosts treat both as absent).
      const raw: number[] = [];
      for (let i = 0; i < field.length; i++) {
        const byte = this.screen.rawBuffer[(field.startAddr + i) % this.screen.size];
        if (byte !== 0x00) raw.push(byte);
      }
      let trimLen = raw.length;
      while (trimLen > 0 && raw[trimLen - 1] === EBCDIC_SPACE) {
        trimLen--;
      }
      if (trimLen > 0) {
        parts.push(Buffer.from(raw.slice(0, trimLen)));
      }
    }

    return Buffer.concat(parts);
  }

  /**
   * Query Reply for WSF Read Partition (Query) — the device-capability
   * handshake extended hosts run before using color/highlighting.
   * Conservative set: Summary, Usable Area, Color, Highlighting, Reply
   * Modes (field mode only — we never emit SFE-format read replies),
   * Implicit Partition. Character Sets deliberately omitted until a live
   * host proves it necessary.
   */
  buildQueryReply(): Buffer {
    const w = this.screen.cols;
    const h = this.screen.rows;
    const size = this.screen.size;

    const qr = (code: number, payload: number[]): number[] => {
      const len = payload.length + 4;
      return [(len >> 8) & 0xff, len & 0xff, 0x81, code, ...payload];
    };

    const summary = qr(0x80, [0x80, 0x81, 0x86, 0x87, 0x88, 0xa6]);
    const usableArea = qr(0x81, [
      0x01, 0x00, // 12/14-bit addressing; no variable cells
      (w >> 8) & 0xff, w & 0xff,
      (h >> 8) & 0xff, h & 0xff,
      0x01, // units: mm
      0x00, 0x0a, 0x02, 0xe5, // Xr (x3270's distance measurements)
      0x00, 0x02, 0x00, 0x6f, // Yr
      0x07, // cell width
      0x0c, // cell height
      (size >> 8) & 0xff, size & 0xff,
    ]);
    const color = qr(0x86, [
      0x00, 0x08, // flags, 8 pairs
      0x00, 0xf4, // default -> green
      0xf1, 0xf1, 0xf2, 0xf2, 0xf3, 0xf3, 0xf4, 0xf4,
      0xf5, 0xf5, 0xf6, 0xf6, 0xf7, 0xf7,
    ]);
    const highlighting = qr(0x87, [
      0x04, // 4 pairs
      0x00, 0xf0, // default -> normal
      0xf1, 0xf1, // blink
      0xf2, 0xf2, // reverse
      0xf4, 0xf4, // underscore
    ]);
    const replyModes = qr(0x88, [0x00]); // field mode only
    const implicitPartition = qr(0xa6, [
      0x00, 0x00, // flags
      0x0b, 0x01, 0x00, // self-defining: length, type, flags
      (w >> 8) & 0xff, w & 0xff, (h >> 8) & 0xff, h & 0xff, // default size
      (w >> 8) & 0xff, w & 0xff, (h >> 8) & 0xff, h & 0xff, // alternate size
    ]);

    return Buffer.from([
      AID.STRUCTURED_FIELD,
      ...summary, ...usableArea, ...color, ...highlighting, ...replyModes, ...implicitPartition,
    ]);
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
      if (this.screen.insertMode) {
        this.shiftRightFrom(field, cursorAddr);
      }
      this.screen.setCharAt(cursorAddr, ch, charToEbcdic(ch, this.screen.codePage));
      cursorAddr = (cursorAddr + 1) % this.screen.size;
    }

    this.screen.cursorAddr = cursorAddr;
    this.screen.markModified(field);

    // Autoskip: filling the field lands the cursor on the following
    // attribute byte; when that field is skip (protected+numeric) — or
    // simply protected — jump to the next unprotected field like a real
    // terminal, so form typing flows field to field.
    if (cursorAddr === fieldEnd && this.screen.attrBuffer[cursorAddr % this.screen.size] !== 0) {
      const nextAttr = this.screen.attrBuffer[cursorAddr % this.screen.size];
      if ((nextAttr & 0x20 /* FA.PROTECTED */) !== 0) {
        const ring = this.screen.inputFieldsInOrder();
        const next = ring.find((f) => f.startAddr > field.startAddr) ?? ring[0];
        if (next) this.screen.cursorAddr = next.startAddr;
      }
    }

    return true;
  }

  /** Shift field content right one cell from `addr` (insert-mode typing). */
  private shiftRightFrom(field: { startAddr: number; length: number }, addr: number): void {
    const size = this.screen.size;
    const idx = (addr - field.startAddr + size) % size;
    for (let i = field.length - 1; i > idx; i--) {
      const dst = (field.startAddr + i) % size;
      const src = (field.startAddr + i - 1) % size;
      this.screen.buffer[dst] = this.screen.buffer[src];
      this.screen.rawBuffer[dst] = this.screen.rawBuffer[src];
    }
  }
}
