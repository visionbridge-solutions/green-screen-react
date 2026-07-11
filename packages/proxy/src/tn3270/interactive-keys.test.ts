import { describe, it, expect } from 'vitest';
import { TN3270Handler } from '../protocols/tn3270-handler.js';
import { CMD, ORDER, FA, WCC, encodeAddress } from './constants.js';
import { charToEbcdic } from '../encoding/ebcdic.js';

function eb(text: string): number[] {
  return [...text].map((c) => charToEbcdic(c));
}

/**
 * Handler with a painted two-field form (no socket):
 *   row 2: NAME: [8-char input]      row 4: QTY: [5-char numeric input]
 */
function formHandler() {
  const handler = new TN3270Handler();
  (handler.connection as unknown as { sendRaw: (b: Buffer) => void }).sendRaw = () => {};
  const screen = handler.screen;
  handler.parser.parseRecord(
    Buffer.from([
      CMD.ERASE_WRITE, WCC.KEYBOARD_RESTORE,
      ORDER.SBA, ...encodeAddress(2 * 80 + 0, screen.size), ...eb('NAME:'),
      ORDER.SF, 0x40, // input field starts at (2,6)
      ORDER.SBA, ...encodeAddress(2 * 80 + 14, screen.size),
      ORDER.SF, 0x40 | FA.PROTECTED, // terminates the name field (len 8)
      ORDER.SBA, ...encodeAddress(4 * 80 + 0, screen.size), ...eb('QTY:'),
      ORDER.SF, 0x40 | FA.NUMERIC, // numeric input at (4,5)
      ORDER.SBA, ...encodeAddress(4 * 80 + 10, screen.size),
      ORDER.SF, 0x40 | FA.PROTECTED,
    ]),
  );
  return { handler, screen };
}

const NAME_START = 2 * 80 + 6;
const QTY_START = 4 * 80 + 5; // 'QTY:' is 4 chars, attr at +4, field at +5

describe('TN3270 local editing keys', () => {
  it('Tab/Backtab walk the unprotected-field ring', () => {
    const { handler, screen } = formHandler();
    screen.cursorAddr = NAME_START;
    handler.sendKey('Tab');
    expect(screen.cursorAddr).toBe(QTY_START);
    handler.sendKey('Tab'); // wraps
    expect(screen.cursorAddr).toBe(NAME_START);
    handler.sendKey('Backtab');
    expect(screen.cursorAddr).toBe(QTY_START);
  });

  it('Tab from protected space goes to the next input field after the cursor', () => {
    const { handler, screen } = formHandler();
    screen.cursorAddr = 3 * 80; // between the two fields, protected
    handler.sendKey('Tab');
    expect(screen.cursorAddr).toBe(QTY_START);
  });

  it('Home jumps to the first unprotected field', () => {
    const { handler, screen } = formHandler();
    screen.cursorAddr = QTY_START + 2;
    handler.sendKey('Home');
    expect(screen.cursorAddr).toBe(NAME_START);
  });

  it('arrows move freely (uppercase aliases accepted); Backspace shifts left within the field', () => {
    const { handler, screen } = formHandler();
    screen.cursorAddr = NAME_START;
    handler.encoder.insertText('ABCD');
    handler.sendKey('LEFT');
    handler.sendKey('LEFT');
    // cursor now after 'AB', on 'C'
    handler.sendKey('Backspace'); // deletes 'B'
    const value = screen.getFieldValue(screen.fields.find((f) => f.startAddr === NAME_START)!);
    expect(value.trimEnd()).toBe('ACD');
  });

  it('Delete removes at cursor and NUL-fills the tail; MDT set', () => {
    const { handler, screen } = formHandler();
    screen.cursorAddr = NAME_START;
    handler.encoder.insertText('WXYZ');
    // Reset MDT via host write, then edit again — Delete alone must re-set it
    handler.parser.parseRecord(Buffer.from([CMD.WRITE, WCC.RESET_MDT]));
    screen.cursorAddr = NAME_START;
    handler.sendKey('Delete'); // removes 'W'
    const field = screen.fields.find((f) => f.startAddr === NAME_START)!;
    expect(screen.getFieldValue(field).trimEnd()).toBe('XYZ');
    expect(field.modified).toBe(true);
    expect(screen.rawBuffer[NAME_START + 7]).toBe(0x00); // tail is NUL
  });

  it('EraseEOF clears cursor→field-end and sets MDT', () => {
    const { handler, screen } = formHandler();
    screen.cursorAddr = NAME_START;
    handler.encoder.insertText('LONGNAME');
    handler.parser.parseRecord(Buffer.from([CMD.WRITE, WCC.RESET_MDT]));
    screen.cursorAddr = NAME_START + 4;
    expect(handler.eraseEOF()).toBe(true);
    const field = screen.fields.find((f) => f.startAddr === NAME_START)!;
    expect(screen.getFieldValue(field).trimEnd()).toBe('LONG');
    expect(field.modified).toBe(true);
  });

  it('Insert toggles insert mode; typing shifts right instead of overwriting', () => {
    const { handler, screen } = formHandler();
    screen.cursorAddr = NAME_START;
    handler.encoder.insertText('ACD');
    handler.sendKey('Insert');
    expect(screen.insertMode).toBe(true);
    screen.cursorAddr = NAME_START + 1;
    handler.encoder.insertText('B');
    const field = screen.fields.find((f) => f.startAddr === NAME_START)!;
    expect(screen.getFieldValue(field).trimEnd()).toBe('ABCD');
    handler.sendKey('Reset');
    expect(screen.insertMode).toBe(false);
  });

  it('filling a field autoskips to the next unprotected field', () => {
    const { handler, screen } = formHandler();
    screen.cursorAddr = NAME_START;
    handler.encoder.insertText('EXACTLY8'); // fills the 8-char field
    expect(screen.cursorAddr).toBe(QTY_START);
  });

  it('FieldExit is not a 3270 key: not local, and rejected by sendKey', () => {
    const { handler } = formHandler();
    expect(handler.isLocalKey('FieldExit')).toBe(false);
    expect(handler.isLocalKey('Tab')).toBe(true);
    expect(handler.sendKey('FieldExit')).toBe(false);
  });
});

describe('TN3270 readFieldValues (MDT read primitive)', () => {
  it('returns only modified input fields by default, all input fields on request', () => {
    const { handler, screen } = formHandler();
    screen.cursorAddr = QTY_START;
    handler.encoder.insertText('42');

    const modified = handler.readFieldValues(true);
    expect(modified).toHaveLength(1);
    expect(modified[0]).toMatchObject({ row: 4, col: 5, length: 5, modified: true });
    expect(modified[0].value.trimEnd()).toBe('42');

    const all = handler.readFieldValues(false);
    expect(all).toHaveLength(2);
    expect(handler.traits.hasMdt).toBe(true);
  });
});
