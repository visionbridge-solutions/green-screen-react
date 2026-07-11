import { describe, it, expect } from 'vitest';
import { ScreenBuffer3270 } from './screen.js';
import { TN3270Parser } from './parser.js';
import { TN3270Encoder } from './encoder.js';
import { CMD, ORDER, FA, WCC, EXT_ATTR, HIGHLIGHT, COLOR, encodeAddress } from './constants.js';
import { charToEbcdic } from '../encoding/ebcdic.js';
import { computeStructuralSignature } from '../structural-signature.js';

function eb(text: string): number[] {
  return [...text].map((c) => charToEbcdic(c));
}

function addr(screen: ScreenBuffer3270, row: number, col: number): number[] {
  return [...encodeAddress(row * screen.cols + col, screen.size)];
}

function setup() {
  const screen = new ScreenBuffer3270();
  const parser = new TN3270Parser(screen);
  const encoder = new TN3270Encoder(screen);
  return { screen, parser, encoder };
}

/** Erase/Write with an unprotected field at (r,c) of the given length. */
function writeWithField(
  screen: ScreenBuffer3270,
  parser: TN3270Parser,
  row: number,
  col: number,
  label: string,
  wcc = WCC.KEYBOARD_RESTORE,
) {
  const attrAddr = row * screen.cols + col - 1;
  parser.parseRecord(
    Buffer.from([
      CMD.ERASE_WRITE,
      wcc,
      ORDER.SBA, ...[...encodeAddress(attrAddr - label.length, screen.size)],
      ...eb(label),
      ORDER.SF, 0x40, // unprotected/normal attr (graphic-converted) before (row,col)
    ]),
  );
}

describe('TN3270Parser — WCC semantics (GA23-0059 bit layout)', () => {
  it('keyboard restore (0x02) unlocks; alarm (0x04) is one-shot on ScreenData', () => {
    const { screen, parser } = setup();
    screen.keyboardLocked = true;
    parser.parseRecord(Buffer.from([CMD.WRITE, WCC.KEYBOARD_RESTORE | WCC.SOUND_ALARM]));
    expect(screen.keyboardLocked).toBe(false);
    const first = screen.toScreenData();
    expect(first.keyboard_locked).toBe(false);
    expect(first.alarm).toBe(true);
    expect(screen.toScreenData().alarm).toBeUndefined(); // consumed
  });

  it('a write WITHOUT keyboard restore leaves the keyboard locked', () => {
    const { screen, parser } = setup();
    screen.keyboardLocked = true;
    parser.parseRecord(Buffer.from([CMD.WRITE, 0x00, ...eb('X')]));
    expect(screen.keyboardLocked).toBe(true);
  });

  it('reset MDT (0x01) clears field.modified and the attribute MDT bit', () => {
    const { screen, parser, encoder } = setup();
    writeWithField(screen, parser, 2, 10, 'NAME:');
    screen.cursorAddr = 2 * screen.cols + 10;
    encoder.insertText('AB');
    expect(screen.fields.find((f) => f.modified)).toBeTruthy();
    parser.parseRecord(Buffer.from([CMD.WRITE, WCC.RESET_MDT]));
    expect(screen.fields.some((f) => f.modified)).toBe(false);
    expect(screen.attrBuffer.filter((a) => a & FA.MDT)).toHaveLength(0);
  });

  it('Erase All Unprotected clears unprotected data to NULs and restores the keyboard', () => {
    const { screen, parser, encoder } = setup();
    writeWithField(screen, parser, 2, 10, 'NAME:');
    screen.cursorAddr = 2 * screen.cols + 10;
    encoder.insertText('AB');
    screen.keyboardLocked = true;
    parser.parseRecord(Buffer.from([CMD.ERASE_ALL_UNPROTECTED]));
    expect(screen.keyboardLocked).toBe(false);
    expect(screen.getCharAt(2 * screen.cols + 10)).toBe(' ');
    expect(screen.rawBuffer[2 * screen.cols + 10]).toBe(0x00);
    expect(screen.getFieldValue(screen.fields[0]).trim()).toBe('');
  });
});

describe('TN3270Parser — orders', () => {
  it('SBA + data lands text at the addressed position (golden row)', () => {
    const { screen, parser } = setup();
    parser.parseRecord(
      Buffer.from([CMD.ERASE_WRITE, 0x00, ORDER.SBA, ...addr(screen, 1, 5), ...eb('HELLO')]),
    );
    const data = screen.toScreenData();
    expect(data.content.split('\n')[1].slice(5, 10)).toBe('HELLO');
    expect(screen.rawBuffer[screen.cols + 5]).toBe(charToEbcdic('H'));
  });

  it('SFE surfaces color and highlight onto the wire field', () => {
    const { screen, parser } = setup();
    parser.parseRecord(
      Buffer.from([
        CMD.ERASE_WRITE, 0x00,
        ORDER.SBA, ...addr(screen, 3, 0),
        ORDER.SFE, 0x03,
        0xC0, 0x40, // basic attr: unprotected/normal
        EXT_ATTR.COLOR, COLOR.RED,
        EXT_ATTR.HIGHLIGHT, HIGHLIGHT.REVERSE,
        ...eb('VAL'),
        ORDER.SF, 0x40 | FA.PROTECTED, // terminate the field
      ]),
    );
    const field = screen.toScreenData().fields[0];
    expect(field.color).toBe('red');
    expect(field.is_reverse).toBe(true);
    expect(field.is_input).toBe(true);
  });

  it('SA starts a character-attribute run and SA ALL(0x00) ends it', () => {
    const { screen, parser } = setup();
    parser.parseRecord(
      Buffer.from([
        CMD.ERASE_WRITE, 0x00,
        ORDER.SBA, ...addr(screen, 0, 0),
        ORDER.SA, EXT_ATTR.COLOR, COLOR.YELLOW,
        ...eb('AB'),
        ORDER.SA, EXT_ATTR.ALL, 0x00,
        ...eb('C'),
      ]),
    );
    expect(screen.colorBuffer[0]).toBe(COLOR.YELLOW);
    expect(screen.colorBuffer[1]).toBe(COLOR.YELLOW);
    expect(screen.colorBuffer[2]).toBe(0);
  });

  it('MF modifies the attribute at the current address and advances past it', () => {
    const { screen, parser } = setup();
    // Field attribute at (0,4), then MF it to protected+MDT-less attr 0x20
    parser.parseRecord(
      Buffer.from([
        CMD.ERASE_WRITE, 0x00,
        ORDER.SBA, ...addr(screen, 0, 4),
        ORDER.SF, 0x40,
        ORDER.SBA, ...addr(screen, 0, 4),
        ORDER.MF, 0x01, 0xC0, 0x40 | FA.PROTECTED,
        ...eb('Z'), // must land AFTER the attribute (addr advanced)
      ]),
    );
    expect(screen.attrBuffer[4]).toBe(0x40 | FA.PROTECTED);
    expect(screen.getCharAt(5)).toBe('Z');
  });

  it('MF at a non-attribute position consumes its pairs and does not advance', () => {
    const { screen, parser } = setup();
    parser.parseRecord(
      Buffer.from([
        CMD.ERASE_WRITE, 0x00,
        ORDER.SBA, ...addr(screen, 0, 0),
        ORDER.MF, 0x01, 0xC0, 0x40 | FA.PROTECTED,
        ...eb('Q'),
      ]),
    );
    expect(screen.attrBuffer[0]).toBe(0);
    expect(screen.getCharAt(0)).toBe('Q'); // wrote at 0, not 1
  });

  it('RA repeats to target, wraps, and stop==current fills the whole buffer', () => {
    const { screen, parser } = setup();
    parser.parseRecord(
      Buffer.from([
        CMD.ERASE_WRITE, 0x00,
        ORDER.SBA, ...addr(screen, 0, 0),
        ORDER.RA, ...addr(screen, 0, 0), charToEbcdic('*'),
      ]),
    );
    expect(screen.buffer.every((c) => c === '*')).toBe(true);
  });

  it('RA with NUL fill produces blank cells that stay NUL in the raw buffer', () => {
    const { screen, parser } = setup();
    parser.parseRecord(
      Buffer.from([
        CMD.ERASE_WRITE, 0x00,
        ORDER.SBA, ...addr(screen, 0, 0),
        ...eb('AB'),
        ORDER.SBA, ...addr(screen, 0, 0),
        ORDER.RA, ...addr(screen, 0, 2), 0x00,
      ]),
    );
    expect(screen.getCharAt(0)).toBe(' ');
    expect(screen.rawBuffer[0]).toBe(0x00);
    expect(screen.rawBuffer[2]).toBe(0x00); // untouched (still from erase)
  });

  it('EUA erases only unprotected content up to the target', () => {
    const { screen, parser } = setup();
    // protected label + unprotected field with content
    parser.parseRecord(
      Buffer.from([
        CMD.ERASE_WRITE, 0x00,
        ORDER.SBA, ...addr(screen, 0, 0),
        ORDER.SF, 0x40 | FA.PROTECTED, ...eb('LBL'),
        ORDER.SF, 0x40, ...eb('DATA'),
        ORDER.SBA, ...addr(screen, 0, 0),
        ORDER.EUA, ...addr(screen, 1, 0),
      ]),
    );
    const row0 = screen.toScreenData().content.split('\n')[0];
    expect(row0).toContain('LBL'); // protected survives
    expect(row0).not.toContain('DATA'); // unprotected erased
  });
});

describe('TN3270 ScreenData surface', () => {
  it('emits structural_signature computed from input-field geometry', () => {
    const { screen, parser } = setup();
    writeWithField(screen, parser, 4, 20, 'USERID');
    const data = screen.toScreenData();
    expect(data.structural_signature).toBeDefined();
    expect(data.structural_signature).toBe(computeStructuralSignature(data.fields));
  });

  it('flags numeric fields with is_numeric and typed fields with modified', () => {
    const { screen, parser, encoder } = setup();
    parser.parseRecord(
      Buffer.from([
        CMD.ERASE_WRITE, WCC.KEYBOARD_RESTORE,
        ORDER.SBA, ...addr(screen, 2, 0),
        ORDER.SF, 0x40 | FA.NUMERIC, // unprotected numeric
        ...eb('42'),
        ORDER.SF, 0x40 | FA.PROTECTED,
      ]),
    );
    screen.cursorAddr = 2 * screen.cols + 1;
    encoder.insertText('7');
    const fields = screen.toScreenData().fields;
    const numeric = fields.find((f) => f.is_numeric);
    expect(numeric).toBeDefined();
    expect(numeric!.modified).toBe(true);
  });

  it('host read commands set pendingRead instead of being dropped', () => {
    const { parser } = setup();
    parser.parseRecord(Buffer.from([CMD.READ_BUFFER]));
    expect(parser.pendingRead).toBe('buffer');
    parser.parseRecord(Buffer.from([CMD.READ_MODIFIED]));
    expect(parser.pendingRead).toBe('modified');
  });

  it('WSF Read Partition Query sets pendingQueryReply', () => {
    const { parser } = setup();
    // WSF + one SF: len=5, id=0x01 (Read Partition), pid=0xFF, type=0x02 (Query)
    parser.parseRecord(Buffer.from([CMD.WRITE_STRUCTURED_FIELD, 0x00, 0x05, 0x01, 0xff, 0x02]));
    expect(parser.pendingQueryReply).toBe(true);
  });
});

describe('TN3270Encoder', () => {
  it('short-read AIDs (PA1/PA2/PA3/Clear) transmit the AID byte only', () => {
    const { encoder } = setup();
    for (const key of ['PA1', 'PA2', 'PA3', 'Clear']) {
      const record = encoder.buildAidResponse(key)!;
      // the raw record is the AID byte and nothing else (framing is the
      // connection's job)
      expect(record.length, key).toBe(1);
    }
  });

  it('Enter transmits AID + cursor + SBA-addressed modified fields', () => {
    const { screen, parser, encoder } = setup();
    writeWithField(screen, parser, 2, 10, 'NAME:');
    screen.cursorAddr = 2 * screen.cols + 10;
    encoder.insertText('AB');
    const wire = encoder.buildAidResponse('Enter')!;
    expect(wire[0]).toBe(0x7d); // ENTER AID
    expect(wire.length).toBeGreaterThan(3);
    const sbaIdx = wire.indexOf(ORDER.SBA);
    expect(sbaIdx).toBeGreaterThan(0);
    // Field data follows the 2-byte address: 'AB' in EBCDIC
    expect(wire[sbaIdx + 3]).toBe(charToEbcdic('A'));
    expect(wire[sbaIdx + 4]).toBe(charToEbcdic('B'));
  });
});
