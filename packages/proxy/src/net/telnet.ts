/**
 * Shared telnet layer — constants (RFC 854/855) and the record-mode stream
 * scanner used by the block-mode protocols (TN5250, TN3270).
 *
 * One constant block for every protocol: tn5250/vt/hp6530 constants modules
 * re-export it, so option numbers and IAC values are defined exactly once.
 */

export const TELNET = {
  IAC: 0xFF,   // Interpret As Command
  DONT: 0xFE,
  DO: 0xFD,
  WONT: 0xFC,
  WILL: 0xFB,
  SB: 0xFA,    // Subnegotiation Begin
  SE: 0xF0,    // Subnegotiation End
  GA: 0xF9,    // Go Ahead
  EOR: 0xEF,   // End of Record
  NOP: 0xF1,

  // Telnet options
  OPT_BINARY: 0x00,
  OPT_ECHO: 0x01,
  OPT_SGA: 0x03,         // Suppress Go Ahead
  OPT_TIMING_MARK: 0x06, // Timing Mark (RFC 860) — keep-alive probe
  OPT_TTYPE: 0x18,       // Terminal Type
  OPT_EOR: 0x19,         // End of Record
  OPT_NAWS: 0x1F,        // Negotiate About Window Size
  OPT_NEW_ENVIRON: 0x27, // New Environment
  OPT_TN5250E: 0x28,     // TN5250E (option 40)
  OPT_TN3270E: 0x28,     // TN3270E (RFC 2355 — same option number, 40)

  // Terminal type subneg
  TTYPE_IS: 0x00,
  TTYPE_SEND: 0x01,
} as const;

/** Remove IAC IAC escaping from record data. */
export function unescapeIAC(data: Buffer): Buffer {
  const result: number[] = [];
  for (let i = 0; i < data.length; i++) {
    if (data[i] === TELNET.IAC && i + 1 < data.length && data[i + 1] === TELNET.IAC) {
      result.push(TELNET.IAC);
      i++; // skip doubled IAC
    } else {
      result.push(data[i]);
    }
  }
  return Buffer.from(result);
}

export interface TelnetStreamSink {
  /** DO/DONT/WILL/WONT — cmd is the verb byte, option the option byte. */
  onNegotiation(cmd: number, option: number): void;
  /** IAC SB <data> IAC SE — data excludes the framing, IAC IAC unescaped NOT applied. */
  onSubnegotiation(data: Buffer): void;
  /** One complete record (data up to IAC EOR), IAC IAC already unescaped. */
  onRecord(record: Buffer): void;
}

/**
 * Incremental scanner for telnet record mode (BINARY + EOR): feed() raw
 * socket chunks, get negotiation/subnegotiation/record callbacks.
 *
 * Fixes two escape-handling bugs the per-protocol scanners shared:
 * - a buffer *starting* with escaped IAC IAC stalled forever (the scan
 *   bailed out instead of falling through to record extraction), and
 * - an escaped IAC IAC followed by a 0xEF data byte was misread as IAC EOR,
 *   truncating the record mid-stream.
 */
export class TelnetRecordStream {
  private buf: Buffer = Buffer.alloc(0);

  constructor(private readonly sink: TelnetStreamSink) {}

  /** Drop any partially-accumulated stream state (call on (re)connect). */
  reset(): void {
    this.buf = Buffer.alloc(0);
  }

  feed(data: Buffer): void {
    this.buf = Buffer.concat([this.buf, data]);
    this.scan();
  }

  private scan(): void {
    while (this.buf.length > 0) {
      if (this.buf[0] === TELNET.IAC) {
        if (this.buf.length < 2) return; // wait for the verb byte

        const cmd = this.buf[1];

        if (cmd === TELNET.SB) {
          const seIdx = this.findSubnegEnd();
          if (seIdx === -1) return; // wait for IAC SE
          const subData = this.buf.subarray(2, seIdx);
          this.buf = this.buf.subarray(seIdx + 2);
          this.sink.onSubnegotiation(subData);
          continue;
        }

        if (cmd === TELNET.DO || cmd === TELNET.DONT || cmd === TELNET.WILL || cmd === TELNET.WONT) {
          if (this.buf.length < 3) return; // wait for the option byte
          const option = this.buf[2];
          this.buf = this.buf.subarray(3);
          this.sink.onNegotiation(cmd, option);
          continue;
        }

        if (cmd === TELNET.EOR) {
          // EOR with no preceding data — empty record, nothing to emit.
          this.buf = this.buf.subarray(2);
          continue;
        }

        if (cmd !== TELNET.IAC) {
          // Unknown 2-byte IAC command — skip it.
          this.buf = this.buf.subarray(2);
          continue;
        }
        // IAC IAC: escaped 0xFF data byte at the head of the buffer — fall
        // through to record extraction (this is data, not a command).
      }

      const recordEnd = this.findRecordEnd();
      if (recordEnd === -1) return; // wait for IAC EOR

      const rawRecord = this.buf.subarray(0, recordEnd);
      this.buf = this.buf.subarray(recordEnd + 2);
      const record = unescapeIAC(rawRecord);
      if (record.length > 0) {
        this.sink.onRecord(record);
      }
    }
  }

  /** Index of the IAC in IAC SE closing the subneg, skipping IAC IAC escapes. */
  private findSubnegEnd(): number {
    for (let i = 2; i < this.buf.length - 1; i++) {
      if (this.buf[i] === TELNET.IAC) {
        if (this.buf[i + 1] === TELNET.SE) return i;
        if (this.buf[i + 1] === TELNET.IAC) i++; // skip escaped pair
      }
    }
    return -1;
  }

  /** Index of the IAC in IAC EOR ending the record, skipping IAC IAC escapes. */
  private findRecordEnd(): number {
    for (let i = 0; i < this.buf.length - 1; i++) {
      if (this.buf[i] === TELNET.IAC) {
        if (this.buf[i + 1] === TELNET.EOR) return i;
        if (this.buf[i + 1] === TELNET.IAC) i++; // escaped data byte, not a command
      }
    }
    return -1;
  }
}
