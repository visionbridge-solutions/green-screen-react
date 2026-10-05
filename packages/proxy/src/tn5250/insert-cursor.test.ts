import { describe, it, expect } from 'vitest';
import { ScreenBuffer } from './screen.js';
import { TN5250Parser } from './parser.js';
import { CMD, ORDER } from './constants.js';

// An IBM i writes a screen as ONE record: ESC CLEAR_UNIT, ESC WTD cc1 cc2
// <orders>, ESC READ_MDT_FIELDS cc1 cc2. When the host refuses a value it
// re-writes the screen with an IC order on the field in error — that cursor is
// the operator's (and an integrator's) pointer to WHICH field and WHICH row of
// a subfile was refused. The order loop used to `return` at the trailing ESC,
// skipping the post-WTD cursor logic, so the IC was dropped and the cursor
// stayed where it was. Found 2026-10-05: a four-line order refused on line 3
// reported its cursor on line 1.

const ESC = 0x04;

function gdsRecord(data: number[]): Buffer {
  const header = [0, 0, 0x12, 0xa0, 0x00, 0x00, 0x04, 0x00, 0x00, 0x03];
  const body = [...header, ...data];
  body[0] = (body.length >> 8) & 0xff;
  body[1] = body.length & 0xff;
  return Buffer.from(body);
}

/** An input field of `len` cells whose data starts at 1-based (row, col). */
function inputField(row: number, col: number, len: number): number[] {
  return [ORDER.SBA, row, col - 1, ORDER.SF, 0x40, 0x00, 0x24, (len >> 8) & 0xff, len & 0xff];
}

function grid(icRow: number, icCol: number, withRead: boolean): Buffer {
  const orders: number[] = [];
  for (const row of [10, 11, 12]) {
    orders.push(...inputField(row, 7, 10), ...inputField(row, 33, 9));
  }
  orders.push(ORDER.IC, icRow, icCol);
  const data = [ESC, CMD.CLEAR_UNIT, ESC, CMD.WRITE_TO_DISPLAY, 0x00, 0x04, ...orders];
  if (withRead) data.push(ESC, CMD.READ_MDT_FIELDS, 0x00, 0x00);
  return gdsRecord(data);
}

describe('IC order on a WTD followed by a read command', () => {
  it('parks the cursor where the host put it', () => {
    const screen = new ScreenBuffer();
    new TN5250Parser(screen).parseRecord(grid(12, 33, true));
    // 1-based (12, 33) on the wire = 0-based (11, 32): the third row's second field.
    expect([screen.cursorRow, screen.cursorCol]).toEqual([11, 32]);
  });

  it('matches the WTD-only record', () => {
    const screen = new ScreenBuffer();
    new TN5250Parser(screen).parseRecord(grid(12, 33, false));
    expect([screen.cursorRow, screen.cursorCol]).toEqual([11, 32]);
  });

  it('still hands the read command to the command loop', () => {
    const screen = new ScreenBuffer();
    screen.keyboardLocked = true;
    new TN5250Parser(screen).parseRecord(grid(12, 33, true));
    expect(screen.readOpcode).toBe(CMD.READ_MDT_FIELDS);
    expect(screen.keyboardLocked).toBe(false);
  });
});
