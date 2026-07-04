import { describe, it, expect } from 'vitest';
import { ScreenBuffer } from './screen.js';
import { TN5250Parser } from './parser.js';
import { CMD, ORDER } from './constants.js';

// Buffer-safety regressions: a malicious/compromised HOST must not be able to
// crash the parser (read past the record / throw out of the data handler) or
// grow proxy memory without bound.

describe('WDSF length clamp — parser never reads past the record', () => {
  // A raw (non-GDS) record starting with WTD reaches parseOrders via
  // tryParseRawData → parseCommandsFromOffset. Embed ORDER.WDSF with a length
  // field far larger than the record: pre-fix the CREATE_WINDOW / selection /
  // scrollbar sub-parsers walked past data.length; now wdsfEnd is clamped.
  const oversized = [
    Buffer.from([CMD.WRITE_TO_DISPLAY, ORDER.WDSF, 0xff, 0xff, 0x01, 0x01, 0x00]),
    Buffer.from([CMD.WRITE_TO_DISPLAY, ORDER.WDSF, 0x7f, 0xf0, 0x01, 0x03, 0x00, 0x00]),
    Buffer.from([CMD.WRITE_TO_DISPLAY, ORDER.WDSF, 0xff, 0x00, 0x01, 0x02]),
    // truncated headers
    Buffer.from([CMD.WRITE_TO_DISPLAY, ORDER.WDSF]),
    Buffer.from([CMD.WRITE_TO_DISPLAY, ORDER.WDSF, 0x00]),
  ];

  it('does not throw on any oversized/truncated WDSF record', () => {
    for (const rec of oversized) {
      const parser = new TN5250Parser(new ScreenBuffer());
      // pad to the 7-byte GDS-header minimum so parseRecord attempts to parse
      const padded = rec.length >= 7 ? rec : Buffer.concat([rec, Buffer.alloc(7 - rec.length)]);
      expect(() => parser.parseRecord(padded), padded.toString('hex')).not.toThrow();
    }
  });

  it('does not throw on 2000 random byte records (fuzz)', () => {
    const parser = new TN5250Parser(new ScreenBuffer());
    for (let i = 0; i < 2000; i++) {
      const len = 7 + Math.floor(Math.random() * 40);
      const buf = Buffer.alloc(len);
      for (let j = 0; j < len; j++) buf[j] = Math.floor(Math.random() * 256);
      // seed a WDSF order somewhere to exercise the sub-parsers
      if (len > 9) { buf[0] = CMD.WRITE_TO_DISPLAY; buf[1] = ORDER.WDSF; }
      expect(() => parser.parseRecord(buf)).not.toThrow();
    }
  });
});

describe('screenStack cap — SAVE_SCREEN flood is bounded', () => {
  it('never exceeds MAX_SCREEN_STACK no matter how many saves arrive', () => {
    const screen = new ScreenBuffer();
    for (let i = 0; i < 1000; i++) screen.saveState();
    expect(screen.screenStack.length).toBe(ScreenBuffer.MAX_SCREEN_STACK);
    expect(ScreenBuffer.MAX_SCREEN_STACK).toBeLessThanOrEqual(64);
  });

  it('keeps the MOST RECENT frames (LIFO restore still works after a flood)', () => {
    const screen = new ScreenBuffer();
    for (let i = 0; i < ScreenBuffer.MAX_SCREEN_STACK + 5; i++) screen.saveState();
    // We can still pop the cap's worth of frames; the oldest were dropped.
    let pops = 0;
    while (screen.restoreState()) pops++;
    expect(pops).toBe(ScreenBuffer.MAX_SCREEN_STACK);
  });
});
