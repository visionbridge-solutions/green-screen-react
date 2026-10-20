/**
 * Field Exit erases to the end of the field; Home goes to the field's start.
 *
 * LegacyBridge 2026-10-17: an integrator cleared a menu's command line with
 * Home + Field Exit before typing a selection. Field Exit only right-adjusted
 * (it erased nothing), and Home kept the cursor's ROW, so on a 153-cell
 * command line wrapping onto a second row it landed mid-field. The line kept a
 * refused selection and every next selection was typed onto its end
 * ("1111…1"): 119 documents failed in 37 minutes.
 */
import { describe, it, expect, vi } from 'vitest';
import { TN5250Handler } from '../protocols/tn5250-handler.js';
import { FieldDef } from './screen.js';

function field(row: number, col: number, length: number): FieldDef {
  return { row, col, length, ffw1: 0, ffw2: 0, fcw1: 0, fcw2: 0, attribute: 0x24, rawAttrByte: 0x24, modified: false };
}

/** A menu: one command line from (19, 6), 153 cells, wrapping onto row 20. */
function menu() {
  const handler = new TN5250Handler();
  vi.spyOn(handler.connection, 'sendRaw').mockImplementation(() => {});
  const line = field(19, 6, 153);
  handler.screen.fields.push(line);
  const value = () => handler.screen.getFieldValue(line).trimEnd();
  const cursor = () => [handler.screen.cursorRow, handler.screen.cursorCol];
  return { handler, line, value, cursor };
}

describe('Home', () => {
  it("goes to the start of a field that wraps rows, from its second row", () => {
    const { handler, cursor } = menu();
    handler.screen.cursorRow = 20;
    handler.screen.cursorCol = 63;
    handler.sendKey('Home');
    expect(cursor()).toEqual([19, 6]);
  });
});

describe('Field Exit', () => {
  it('erases the leftover selection from the cursor to the end, on both rows', () => {
    const { handler, value } = menu();
    handler.screen.cursorRow = 19;
    handler.screen.cursorCol = 6;
    handler.sendText('1'.repeat(140));
    handler.sendKey('Home');
    handler.sendKey('FieldExit');
    expect(value()).toBe('');
  });

  it('keeps what was typed before the cursor and erases only after it', () => {
    const { handler, value } = menu();
    handler.screen.cursorRow = 19;
    handler.screen.cursorCol = 6;
    handler.sendText('1111');
    handler.screen.cursorCol = 7;
    handler.sendKey('FieldExit');
    expect(value()).toBe('1');
  });

  it('keeps a value that exactly filled its field', () => {
    const handler = new TN5250Handler();
    vi.spyOn(handler.connection, 'sendRaw').mockImplementation(() => {});
    const user = field(5, 52, 10);
    handler.screen.fields.push(user, field(6, 52, 10));
    handler.screen.cursorRow = 5;
    handler.screen.cursorCol = 52;
    handler.sendText('LEGACYBPRD');
    handler.sendKey('FieldExit');
    expect(handler.screen.getFieldValue(user)).toBe('LEGACYBPRD');
  });
});
