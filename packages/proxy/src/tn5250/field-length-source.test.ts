import { describe, it, expect } from 'vitest';
import { ScreenBuffer } from './screen.js';
import { TN5250Parser } from './parser.js';
import { CMD, ORDER } from './constants.js';

// The host's SF order carries a 2-byte field length — the width the host program
// will actually accept. Two things used to lose it:
//
//  1. When a field already existed at the same position (synthesized earlier
//     from a bare SBA+attribute), the SF merge copied the FFW/attribute bytes
//     but NOT `length`. The field kept length 0, fell through
//     calculateFieldLengths' "already has an explicit length" guard, and got the
//     gap-to-the-next-field measurement instead.
//  2. Nothing on the wire distinguished a declared width from an inferred one,
//     so a consumer had no way to tell 6 from "6, probably, unless it's 43".
//
// Why it matters: a 5250 host silently keeps only the first N characters of an
// over-long write. An integrator sizing input against an inflated width turns a
// value the host would have REJECTED into one it accepts and truncates. On
// 2026-08-03 that wrote an 8-digit date into a 6-char DDS field and stored the
// wrong YEAR, with no error raised anywhere.

/** SBA to (row, col) — both 1-based on the wire. The field itself starts one
 *  cell AFTER the address (the attribute byte occupies the addressed cell). */
function sba(row: number, col: number): number[] {
  return [ORDER.SBA, row, col];
}

/** Where the field declared at SBA(row, col) actually lands, 0-based. */
function fieldAt(row: number, col: number) {
  return { row: row - 1, col };
}

/** An SF order declaring an input field of `len` chars.
 *  Layout per lib5250: SF, FFW1, FFW2, ATTR, LEN_HI, LEN_LO. */
function sf(len: number, attr = 0x20): number[] {
  return [ORDER.SF, 0x40, 0x00, attr, (len >> 8) & 0xff, len & 0xff];
}

/** A bare SBA + display attribute — no SF order, so no declared width. */
function bareAttr(row: number, col: number, attr = 0x24): number[] {
  return [...sba(row, col), attr];
}

function parse(bytes: number[], rows = 24, cols = 80) {
  const screen = new ScreenBuffer(rows, cols);
  const parser = new TN5250Parser(screen);
  const data = [CMD.WRITE_TO_DISPLAY, 0x00, 0x00, ...bytes];
  const record = [
    ((data.length + 7) >> 8) & 0xff, (data.length + 7) & 0xff, // record length
    0x12, 0xa0,                                                // GDS record type
    0x00, 0x00,                                                // reserved
    0x02,                                                      // OPCODE.OUTPUT
    ...data,
  ];
  parser.parseRecord(Buffer.from(record));
  // The handler calls this after every modifying record (tn5250-handler.ts) —
  // it is where an undeclared width gets its gap measurement, so a declared
  // width has to survive it.
  parser.calculateFieldLengths();
  return screen;
}

describe('SF-declared field width', () => {
  it('keeps the declared length when an SF lands on an existing field position', () => {
    // Bare SBA+attribute first (synthesizes a length-0 field), then the real SF
    // for the SAME position — the merge path.
    const screen = parse([
      ...bareAttr(9, 26),           // bare attribute -> synthetic, length 0
      ...sba(9, 26), ...sf(6),      // host's SF for the SAME cell -> merge path
      ...sba(9, 70), ...sf(4),      // a far-away neighbour on the same row
    ]);
    const pos = fieldAt(9, 26);
    const field = screen.fields.find(f => f.row === pos.row && f.col === pos.col);
    expect(field, 'field at the SF position').toBeDefined();
    expect(field!.length).toBe(6);
    expect(field!.lengthSource).toBe('declared');
    // and it is no longer flagged as a guess
    expect(field!.synthetic).toBeUndefined();
  });

  it('does not infer a width over a declared one', () => {
    // A trailing 6-char field with nothing after it: the gap inference would
    // measure to the screen edge (the observed C1TO = 43 case).
    const screen = parse([...sba(9, 38), ...sf(6)]);
    const pos = fieldAt(9, 38);
    const field = screen.fields.find(f => f.row === pos.row && f.col === pos.col);
    expect(field!.length).toBe(6);
    expect(field!.lengthSource).toBe('declared');
  });

  it('marks a gap-measured width as inferred', () => {
    const screen = parse([
      ...bareAttr(5, 10),   // no SF -> width must be inferred
      ...bareAttr(5, 30),
    ]);
    const pos = fieldAt(5, 10);
    const first = screen.fields.find(f => f.row === pos.row && f.col === pos.col);
    expect(first, 'synthetic field').toBeDefined();
    expect(first!.lengthSource).toBe('inferred');
    expect(first!.length).toBeGreaterThan(6); // it is a gap, not a field width
  });

  it('only puts length_source on the wire when the host declared it', () => {
    const screen = parse([
      ...sba(9, 26), ...sf(6),
      ...bareAttr(12, 10),
      ...bareAttr(12, 40),
    ]);
    const wire = screen.toScreenData();
    const dpos = fieldAt(9, 26);
    const ipos = fieldAt(12, 10);
    const declared = wire.fields.find(f => f.row === dpos.row && f.col === dpos.col);
    const inferred = wire.fields.find(f => f.row === ipos.row && f.col === ipos.col);
    expect(declared!.length_source).toBe('declared');
    expect(declared!.length).toBe(6);
    // absent, not 'inferred' — the wire stays minimal and the DEFAULT reading of
    // a bare `length` is "upper bound", which is the safe assumption.
    expect(inferred!.length_source).toBeUndefined();
  });
});

// A gap measurement has no wrap semantics. Live 80x24 entry screen, 2026-09-05:
// three bare-attribute inputs inferred widths that reached the end of their row
// or beyond — one at row 20 col 0 measured 147 cells (rows 20-21). The viewer
// drew it verbatim and painted over the host's message/legend rows; and because
// the gap depends on how the host segmented that particular frame, the same
// screen decoded two ways on successive redraws. Only an SF-declared width may
// continue onto the next row.
describe('inferred width never leaves its row', () => {
  /** The field at 0-based (row, col), located directly — `fieldAt` cannot
   *  express an attribute byte sitting on the previous row's last cell. */
  function at(screen: ScreenBuffer, row: number, col: number) {
    const f = screen.fields.find(f => f.row === row && f.col === col);
    expect(f, `field at (${row}, ${col})`).toBeDefined();
    return f!;
  }

  it('bounds a gap that runs onto later rows to the end of its own row', () => {
    const screen = parse([
      ...bareAttr(20, 80),  // attribute on the last cell of row 19 -> field at (20, 0)
      ...bareAttr(23, 6),   // next attribute two rows down: the raw gap is 165
    ]);
    const f = at(screen, 20, 0);
    expect(f.lengthSource).toBe('inferred');
    expect(f.length).toBe(80);
    expect(f.col + f.length).toBeLessThanOrEqual(screen.cols);
    // and that is what goes on the wire
    const wire = screen.toScreenData().fields.find(w => w.row === 20 && w.col === 0);
    expect(wire!.length).toBe(80);
  });

  it('keeps a same-row closing attribute as the bound when it is tighter', () => {
    const screen = parse([
      ...bareAttr(5, 1),    // field at (4, 1)
      ...bareAttr(5, 80),   // closing attribute on (4, 79); its own field starts at (5, 0)
    ]);
    const f = at(screen, 4, 1);
    expect(f.lengthSource).toBe('inferred');
    expect(f.length).toBe(78);  // cols 1..78 — col 79 is the attribute byte
    expect(f.col + f.length).toBeLessThanOrEqual(screen.cols);
  });

  it('bounds the wrap-around gap of the last field on the last row', () => {
    const screen = parse([
      ...bareAttr(1, 11),   // first field at (0, 11)
      ...bareAttr(23, 80),  // last field at (23, 0): the wrap-around gap is 90
    ]);
    const f = at(screen, 23, 0);
    expect(f.lengthSource).toBe('inferred');
    expect(f.length).toBe(80);
  });

  it("uses the screen's own column count, not a fixed 80", () => {
    const screen = parse([
      ...bareAttr(6, 100),  // field at (5, 100) on a 132-column screen
      ...bareAttr(8, 1),    // next attribute two rows down
    ], 27, 132);
    const f = at(screen, 5, 100);
    expect(f.lengthSource).toBe('inferred');
    expect(f.length).toBe(32);
  });

  it('does not bound a declared width that wraps onto the next row', () => {
    // A host-declared multi-row field (a command line that continues on the
    // row below) is the host's truth; the wire carries it whole.
    const screen = parse([
      ...sba(20, 27), ...sf(153),
      ...bareAttr(23, 6),
    ]);
    const f = at(screen, 19, 27);
    expect(f.lengthSource).toBe('declared');
    expect(f.length).toBe(153);
    const wire = screen.toScreenData().fields.find(w => w.row === 19 && w.col === 27);
    expect(wire!.length).toBe(153);
    expect(wire!.length_source).toBe('declared');
  });
});
