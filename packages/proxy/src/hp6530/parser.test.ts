import { describe, it, expect } from 'vitest';
import { HP6530Screen } from './screen.js';
import { HP6530Parser } from './parser.js';
import { HP6530Encoder } from './encoder.js';
import { ATTR, KEY_TO_SEQUENCE } from './constants.js';

// Conformance pins for the FROZEN HP6530 subset (see README.md — no NonStop
// emulator exists to verify against, so the implemented behavior is the spec).

function setup() {
  const screen = new HP6530Screen();
  const parser = new HP6530Parser(screen);
  const encoder = new HP6530Encoder(screen);
  const feed = (text: string) => parser.parse(Buffer.from(text, 'latin1'));
  return { screen, parser, encoder, feed };
}

function row(screen: HP6530Screen, r: number): string {
  const start = r * screen.cols;
  return screen.buffer.slice(start, start + screen.cols).join('');
}

describe('HP6530 controls and addressing', () => {
  it('prints ASCII with cursor advance and honors CR/LF/BS', () => {
    const { screen, feed } = setup();
    feed('AB\rC');
    expect(row(screen, 0).slice(0, 2)).toBe('CB'); // CR rewound to col 0
    feed('\nX');
    expect(screen.getChar(1, 1)).toBe('X'); // LF moved down, col kept
    feed('\b\bY');
    expect(screen.getChar(1, 0)).toBe('Y'); // BS moved left (with the write advancing after)
  });

  it('LF at the bottom row stays put (block mode — no scroll)', () => {
    const { screen, feed } = setup();
    feed('\x1b[24;1H'); // last row (24 rows)
    feed('\n');
    expect(screen.cursorRow).toBe(screen.rows - 1);
  });

  it('CSI H addresses 1-based row;col', () => {
    const { screen, feed } = setup();
    feed('\x1b[5;10HZ');
    expect(screen.getChar(4, 9)).toBe('Z');
  });

  it('FF and CSI 2J clear the screen; CSI 0J/1J split at the cursor', () => {
    const { screen, feed } = setup();
    feed('\x1b[1;1HAAAA\x1b[2;1HBBBB');
    feed('\x1b[1;3H\x1b[0J'); // clear from (0,2) to end
    expect(row(screen, 0).trimEnd()).toBe('AA');
    expect(row(screen, 1).trim()).toBe('');
    feed('\x1b[1;1HCCCC\x1b[1;3H\x1b[1J'); // clear from start through cursor
    expect(row(screen, 0).trimEnd().startsWith('C')).toBe(false);
  });

  it('HP short-form ESC J / ESC K erase like their CSI forms', () => {
    const { screen, feed } = setup();
    feed('\x1b[1;1HHELLO WORLD');
    feed('\x1b[1;6H\x1bK');
    expect(row(screen, 0).trimEnd()).toBe('HELLO');
    feed('\x1b[1;1H\x1bJ');
    expect(row(screen, 0).trim()).toBe('');
  });
});

describe('HP6530 attributes (ESC & d <code>)', () => {
  it('applies each documented attribute code to subsequent characters', () => {
    const { screen, feed } = setup();
    feed('\x1b&dJX'); // inverse
    expect(screen.attrs[0].inverse).toBe(true);
    feed('\x1b&dDY'); // underline
    expect(screen.attrs[1].underline).toBe(true);
    expect(screen.attrs[1].inverse).toBe(false); // codes replace, not stack
    feed('\x1b&dBZ'); // half bright
    expect(screen.attrs[2].halfBright).toBe(true);
    feed('\x1b&dHW'); // blink
    expect(screen.attrs[3].blink).toBe(true);
    feed('\x1b&dLV'); // underline + inverse
    expect(screen.attrs[4].underline).toBe(true);
    expect(screen.attrs[4].inverse).toBe(true);
    feed('\x1b&d@N'); // normal resets
    expect(screen.attrs[5]).toEqual({ halfBright: false, underline: false, blink: false, inverse: false });
  });
});

describe('HP6530 protected fields and block mode', () => {
  function paintForm(feed: (t: string) => boolean) {
    // "NAME: [input........]" — protected label, unprotected input span
    feed('\x1b[1;1H\x1b)NAME: \x1b(');
    feed('\x1b[1;20H\x1b)END\x1b('); // protected span closes the input field
  }

  it('ESC ) / ESC ( derive input fields from unprotected gaps', () => {
    const { screen, feed } = setup();
    paintForm(feed);
    const inputs = screen.fields.filter((f) => !f.isProtected);
    expect(inputs.length).toBeGreaterThan(0);
    const f = inputs.find((x) => x.row === 0 && x.col >= 6);
    expect(f).toBeDefined();
  });

  it('HT tabs to the next unprotected field', () => {
    const { screen, feed } = setup();
    paintForm(feed);
    screen.setCursor(0, 0);
    feed('\t');
    const first = screen.fields.filter((f) => !f.isProtected)[0];
    expect(screen.cursorRow).toBe(first.row);
    expect(screen.cursorCol).toBe(first.col);
  });

  it('typed fields transmit on action keys with the F-key sequence appended', () => {
    const { screen, feed, encoder } = setup();
    paintForm(feed);
    const input = screen.fields.filter((f) => !f.isProtected)[0];
    screen.setCursor(input.row, input.col);
    expect(encoder.insertText('SMITH')).toBe(true);

    const wire = encoder.buildKeyResponse('F1')!;
    const text = wire.toString('latin1');
    expect(text).toContain('SMITH');
    expect(text).toContain(KEY_TO_SEQUENCE['F1'].toString('latin1'));
  });

  it('typing into a protected span is refused', () => {
    const { screen, feed, encoder } = setup();
    paintForm(feed);
    screen.setCursor(0, 0); // inside the protected label
    expect(encoder.insertText('nope')).toBe(false);
  });

  it('unknown keys return null from the encoder', () => {
    const { encoder } = setup();
    expect(encoder.buildKeyResponse('NotAKey')).toBeNull();
  });
});

describe('HP6530 F-key sequence table pins', () => {
  it('F1-F8 use ESC p..w and F9-F16 use ESC `..g', () => {
    expect(KEY_TO_SEQUENCE['F1']).toEqual(Buffer.from([0x1b, 0x70]));
    expect(KEY_TO_SEQUENCE['F8']).toEqual(Buffer.from([0x1b, 0x77]));
    expect(KEY_TO_SEQUENCE['F9']).toEqual(Buffer.from([0x1b, 0x60]));
    expect(KEY_TO_SEQUENCE['F16']).toEqual(Buffer.from([0x1b, 0x67]));
  });

  it('attribute code table matches the documented HP codes', () => {
    expect(ATTR.NORMAL).toBe(0x40);
    expect(ATTR.INVERSE).toBe(0x4a);
    expect(ATTR.UNDERLINE).toBe(0x44);
  });
});
