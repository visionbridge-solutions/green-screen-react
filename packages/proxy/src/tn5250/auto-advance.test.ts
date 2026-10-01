/**
 * Typing past the end of a full field.
 *
 * An operator signing on by hand types a 10-character user profile into the
 * 10-cell User field and goes on typing the password. A 5250 keyboard moves on
 * to the Password field. This emulator kept the cursor parked on the User
 * field's last cell, so every password character OVERWROTE that cell: the user
 * read "USERPROFL" + the password's last character, the password stayed empty,
 * and the sign-on went to the host as a wrong user with no password.
 *
 * Pinned here:
 *   - keyboard typing (`advance`) moves on to the next field in Tab order,
 *     one keystroke at a time or in one call;
 *   - a field write (no `advance`, the default) refuses the overflow and
 *     reports it — it never spills, and never overwrites its last cell;
 *   - the cursor does not jump on fill, so a Tab or Field Exit sent after a
 *     full value still acts on that field (integrators navigate that way);
 *   - a cursor the operator moves onto the last cell overwrites it, as before;
 *   - Field Exit Required and signed-numeric fields do not advance;
 *   - a host record that repaints nothing between two keystrokes does not end
 *     the typing; one that rewrites the screen does.
 */
import { describe, it, expect, vi } from 'vitest';
import { TN5250Handler } from '../protocols/tn5250-handler.js';
import { CMD, FFW } from './constants.js';
import { FieldDef } from './screen.js';

function field(row: number, col: number, length: number, ffw2 = 0, attr = 0x24, ffw1 = 0): FieldDef {
  return {
    row, col, length,
    ffw1, ffw2, fcw1: 0, fcw2: 0,
    attribute: attr, rawAttrByte: attr, modified: false,
  };
}

/** The IBM i sign-on layout: User (10, monocase), Password (10, non-display), Program. */
function signOnHandler(opts: { userFfw2?: number; userFfw1?: number } = {}) {
  const handler = new TN5250Handler() as TN5250Handler & { onRecord: (r: Buffer) => void };
  vi.spyOn(handler.connection, 'sendRaw').mockImplementation(() => {});
  const user = field(5, 52, 10, FFW.MONOCASE | (opts.userFfw2 ?? 0), 0x24, opts.userFfw1 ?? 0);
  const password = field(6, 52, 10, 0, 0x27);
  const program = field(7, 52, 10, FFW.MONOCASE);
  handler.screen.fields.push(user, password, program);
  handler.screen.cursorRow = 5;
  handler.screen.cursorCol = 52;
  const value = (f: FieldDef) => handler.screen.getFieldValue(f).trimEnd();
  const cursor = () => [handler.screen.cursorRow, handler.screen.cursorCol];
  return { handler, user, password, program, value, cursor };
}

function typeKeys(handler: TN5250Handler, text: string, advance: boolean): boolean[] {
  return [...text].map(ch => handler.sendText(ch, { advance }));
}

describe('keyboard typing moves on past a full field', () => {
  it('one keystroke at a time: the password lands in the Password field', () => {
    const { handler, user, password, value, cursor } = signOnHandler();
    expect(typeKeys(handler, 'LEGACYBPRD', true).every(Boolean)).toBe(true);
    expect(typeKeys(handler, 'SECRET', true).every(Boolean)).toBe(true);
    expect(value(user)).toBe('LEGACYBPRD');
    expect(value(password)).toBe('SECRET');
    expect(cursor()).toEqual([6, 58]);
    expect(user.modified && password.modified).toBe(true);
  });

  it('in one call (a fast typist or a paste): the same', () => {
    const { handler, user, password, value } = signOnHandler();
    expect(handler.sendText('LEGACYBPRDSECRET', { advance: true })).toBe(true);
    expect(value(user)).toBe('LEGACYBPRD');
    expect(value(password)).toBe('SECRET');
  });

  it('does not jump on fill: Tab after a full user still goes to Password', () => {
    const { handler, password, value, cursor } = signOnHandler();
    typeKeys(handler, 'LEGACYBPRD', true);
    expect(cursor()).toEqual([5, 61]);
    handler.sendKey('Tab');
    expect(cursor()).toEqual([6, 52]);
    typeKeys(handler, 'SECRET', true);
    expect(value(password)).toBe('SECRET');
  });

  it('a cursor moved onto the last cell overwrites it rather than moving on', () => {
    const { handler, user, password, value } = signOnHandler();
    typeKeys(handler, 'LEGACYBPRD', true);
    handler.setCursor(5, 61);
    handler.sendText('X', { advance: true });
    expect(value(user)).toBe('LEGACYBPRX');
    expect(value(password)).toBe('');
  });

  it('Field Exit Required stops at the full field', () => {
    const { handler, user, password, value } = signOnHandler({ userFfw2: FFW.FER });
    typeKeys(handler, 'LEGACYBPRD', true);
    expect(handler.sendText('S', { advance: true })).toBe(false);
    expect(value(user)).toBe('LEGACYBPRD');
    expect(value(password)).toBe('');
  });

  it('a signed numeric field stops at its end too', () => {
    const { handler, user, password, value } = signOnHandler({ userFfw1: FFW.SHIFT_SIGNED_NUM });
    typeKeys(handler, '1234567890', true);
    expect(handler.sendText('5', { advance: true })).toBe(false);
    expect(value(user)).toBe('1234567890');
    expect(value(password)).toBe('');
  });

  it('the last field on the screen wraps to the first, like Tab', () => {
    const { handler, user, program, value } = signOnHandler();
    handler.setCursor(7, 52);
    expect(handler.sendText('QCMDQCMDQCAB', { advance: true })).toBe(true);
    expect(value(program)).toBe('QCMDQCMDQC');
    expect(value(user)).toBe('AB');
  });
});

describe('a field write never leaves its field', () => {
  it('one keystroke at a time: the overflow is refused, the last cell kept', () => {
    const { handler, user, password, value, cursor } = signOnHandler();
    expect(typeKeys(handler, 'LEGACYBPRD', false).every(Boolean)).toBe(true);
    expect(typeKeys(handler, 'SECRET', false)).toEqual([false, false, false, false, false, false]);
    expect(value(user)).toBe('LEGACYBPRD');
    expect(value(password)).toBe('');
    expect(cursor()).toEqual([5, 61]);
  });

  it('in one call: what fits is written, the call reports the rest', () => {
    const { handler, user, password, value } = signOnHandler();
    expect(handler.sendText('LEGACYBPRDSECRET')).toBe(false);
    expect(value(user)).toBe('LEGACYBPRD');
    expect(value(password)).toBe('');
  });

  it('a value that exactly fills its field is written whole', () => {
    const { handler, user, value } = signOnHandler();
    expect(handler.sendText('LEGACYBPRD')).toBe(true);
    expect(value(user)).toBe('LEGACYBPRD');
  });

  it('Field Exit after a full value acts on that field, then moves on', () => {
    const { handler, cursor } = signOnHandler();
    handler.sendText('LEGACYBPRD');
    handler.sendKey('FieldExit');
    expect(cursor()).toEqual([6, 52]);
  });
});

describe('the end of a typing run', () => {
  /** A GDS 5250 record around `data` (the header layout the parser reads). */
  const record = (data: number[]): Buffer => Buffer.from([
    ((data.length + 7) >> 8) & 0xff, (data.length + 7) & 0xff, 0x12, 0xa0, 0x00, 0x00, 0x02, ...data,
  ]);

  it('a host record that paints nothing does not end it', () => {
    const { handler, user, password, value } = signOnHandler();
    typeKeys(handler, 'LEGACYBPRD', true);
    handler.onRecord(Buffer.from([0x00]));
    typeKeys(handler, 'SECRET', true);
    expect(value(user)).toBe('LEGACYBPRD');
    expect(value(password)).toBe('SECRET');
  });

  it('a host record that rewrites the screen does, even with the cursor back on the cell', () => {
    const { handler, user, password, value, cursor } = signOnHandler();
    typeKeys(handler, 'LEGACYBPRD', true);
    // Write-to-display + keyboard restore, one character painted at row 1, and
    // Insert Cursor (1-based) back onto the User field's last cell.
    handler.onRecord(record([
      CMD.WRITE_TO_DISPLAY, 0x00, 0x08, 0x11, 0x01, 0x01, 0xc1, 0x13, 0x06, 0x3e,
    ]));
    expect(cursor()).toEqual([5, 61]);
    handler.sendText('S', { advance: true });
    expect(value(user)).toBe('LEGACYBPRS');
    expect(value(password)).toBe('');
  });
});
