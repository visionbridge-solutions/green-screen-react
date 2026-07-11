import { describe, it, expect, vi } from 'vitest';
import { TN3270Handler } from '../protocols/tn3270-handler.js';
import { ScreenBuffer3270 } from './screen.js';
import { TN3270Parser } from './parser.js';
import { TN3270Encoder } from './encoder.js';
import { CMD, ORDER, FA, AID, WCC, encodeAddress } from './constants.js';
import { charToEbcdic, EBCDIC_SPACE } from '../encoding/ebcdic.js';

function eb(text: string): number[] {
  return [...text].map((c) => charToEbcdic(c));
}

/** Handler with the connection's sendRaw spied (no real socket). */
function spiedHandler() {
  const handler = new TN3270Handler();
  const sent: Buffer[] = [];
  (handler.connection as unknown as { sendRaw: (b: Buffer) => void }).sendRaw = (b: Buffer) =>
    sent.push(b);
  const feed = (bytes: number[]) =>
    (handler as unknown as { onRecord: (r: Buffer) => void }).onRecord(Buffer.from(bytes));
  return { handler, sent, feed };
}

function paintLogonScreen(feed: (b: number[]) => void, screen: ScreenBuffer3270) {
  feed([
    CMD.ERASE_WRITE, WCC.KEYBOARD_RESTORE,
    ORDER.SBA, ...encodeAddress(2 * 80 + 0, screen.size),
    ...eb('USERID'),
    ORDER.SF, 0x40, // unprotected input right after the label
  ]);
}

describe('host-initiated reads are answered (the host no longer waits forever)', () => {
  it('Read Modified replies with lastAid + cursor + modified fields', () => {
    const { handler, sent, feed } = spiedHandler();
    paintLogonScreen(feed, handler.screen);
    handler.screen.cursorAddr = 2 * 80 + 7;
    handler.sendKey('Enter'); // sets lastAid (goes through the spied sendRaw)
    handler.encoder.insertText('HERC02');
    sent.length = 0;

    feed([CMD.READ_MODIFIED]);
    expect(sent).toHaveLength(1);
    const reply = sent[0];
    expect(reply[0]).toBe(AID.ENTER); // AID survives the read
    // contains the typed text in EBCDIC
    const hex = reply.toString('hex');
    expect(hex).toContain(Buffer.from(eb('HERC02')).toString('hex'));
  });

  it('Read Modified after a short-read AID replies AID-only; Read Modified All includes fields', () => {
    const { handler, sent, feed } = spiedHandler();
    paintLogonScreen(feed, handler.screen);
    handler.screen.cursorAddr = 2 * 80 + 7;
    handler.encoder.insertText('X');
    handler.sendKey('PA1');
    sent.length = 0;

    feed([CMD.READ_MODIFIED]);
    expect(sent[0].length).toBe(3); // AID + IAC EOR
    expect(sent[0][0]).toBe(AID.PA1);

    feed([CMD.READ_MODIFIED_ALL]);
    const rma = sent[1];
    expect(rma[0]).toBe(AID.PA1);
    expect(rma.length).toBeGreaterThan(3); // fields included despite short-read AID
  });

  it('Read Buffer reproduces SF attributes and preserves NULs', () => {
    const { handler, sent, feed } = spiedHandler();
    paintLogonScreen(feed, handler.screen);
    sent.length = 0;

    feed([CMD.READ_BUFFER]);
    const reply = sent[0];
    // AID + 2-byte cursor, then the full buffer walk
    let sfCount = 0;
    let nulCount = 0;
    for (let i = 3; i < reply.length - 2; i++) {
      if (reply[i] === ORDER.SF) {
        sfCount++;
        i++; // skip attr byte
      } else if (reply[i] === 0x00) {
        nulCount++;
      }
    }
    expect(sfCount).toBe(1); // exactly the one field attribute painted
    expect(nulCount).toBeGreaterThan(1000); // erased cells stay NUL, not space
  });

  it('WSF Read Partition Query gets a structurally-valid Query Reply', () => {
    const { sent, feed } = spiedHandler();
    feed([CMD.WRITE_STRUCTURED_FIELD, 0x00, 0x05, 0x01, 0xff, 0x02]);
    expect(sent).toHaveLength(1);
    const reply = sent[0];
    expect(reply[0]).toBe(AID.STRUCTURED_FIELD); // 0x88

    // Walk the structured fields: each starts with a 2-byte length that
    // must land exactly on the next SF; QR class byte is 0x81.
    const body = reply.subarray(1, reply.length - 2); // strip AID + IAC EOR
    const codes: number[] = [];
    let pos = 0;
    while (pos < body.length) {
      const len = (body[pos] << 8) | body[pos + 1];
      expect(len).toBeGreaterThanOrEqual(4);
      expect(body[pos + 2]).toBe(0x81);
      codes.push(body[pos + 3]);
      pos += len;
    }
    expect(pos).toBe(body.length); // lengths sum exactly
    expect(codes[0]).toBe(0x80); // Summary first
    expect(codes).toContain(0x81); // Usable Area
    expect(codes).toContain(0xa6); // Implicit Partition
  });
});

describe('Read Modified field data comes from raw bytes (NUL omission)', () => {
  it('omits NUL positions inside the field instead of sending spaces', () => {
    const screen = new ScreenBuffer3270();
    const parser = new TN3270Parser(screen);
    const encoder = new TN3270Encoder(screen);
    parser.parseRecord(
      Buffer.from([
        CMD.ERASE_WRITE, 0x00,
        ORDER.SBA, ...encodeAddress(9, screen.size),
        ORDER.SF, 0x40,
      ]),
    );
    // Type 2 chars into a field whose remaining cells are erased NULs
    screen.cursorAddr = 10;
    encoder.insertText('AB');
    const wire = encoder.buildAidResponse('Enter')!;
    const sbaIdx = wire.indexOf(ORDER.SBA);
    const dataBytes = [...wire.subarray(sbaIdx + 3, wire.length - 2)];
    expect(dataBytes).toEqual(eb('AB')); // no padding spaces, no NULs
    expect(dataBytes).not.toContain(EBCDIC_SPACE);
  });
});
