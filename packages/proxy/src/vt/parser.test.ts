import { describe, it, expect } from 'vitest';
import { VTScreenBuffer } from './screen.js';
import { VTParser } from './parser.js';
import { VTEncoder } from './encoder.js';

function setup() {
  const screen = new VTScreenBuffer();
  const parser = new VTParser(screen);
  const encoder = new VTEncoder(screen);
  return { screen, parser, encoder };
}

function feedStr(parser: VTParser, text: string) {
  parser.feed(Buffer.from(text, 'latin1'));
}

function row(screen: VTScreenBuffer, r: number): string {
  const start = r * screen.cols;
  return screen.buffer.slice(start, start + screen.cols).join('');
}

describe('VT charset designation', () => {
  it('ESC ( B consumes the designator instead of printing a stray B', () => {
    const { screen, parser } = setup();
    feedStr(parser, '\x1b(BHello');
    expect(row(screen, 0).trimEnd()).toBe('Hello'); // no leading 'B'
  });

  it('DEC Special Graphics (ESC ( 0) renders box-drawing glyphs', () => {
    const { screen, parser } = setup();
    feedStr(parser, '\x1b(0lqqk\x1b(B done');
    expect(row(screen, 0)).toContain('┌──┐');
    expect(row(screen, 0)).toContain('done'); // back to ASCII after ESC(B
  });

  it('SO/SI switch between G0 and G1 designations', () => {
    const { screen, parser } = setup();
    feedStr(parser, '\x1b)0'); // G1 = graphics
    feedStr(parser, 'A\x0eq\x0fB'); // A, SO(graphics q = ─), SI, B
    expect(row(screen, 0).slice(0, 3)).toBe('A─B');
  });
});

describe('VT host probes (DA / DSR / CPR)', () => {
  it('DA and DECID queue a VT220 identification reply', () => {
    const { parser } = setup();
    feedStr(parser, '\x1b[c');
    feedStr(parser, '\x1bZ');
    expect(parser.pendingResponses).toHaveLength(2);
    expect(parser.pendingResponses[0].toString('latin1')).toBe('\x1b[?62;1;2;6;7;8;9c');
  });

  it('DSR 6 reports the cursor position 1-based (origin-mode relative)', () => {
    const { screen, parser } = setup();
    feedStr(parser, '\x1b[5;11H\x1b[6n');
    expect(parser.pendingResponses.pop()!.toString('latin1')).toBe('\x1b[5;11R');

    feedStr(parser, '\x1b[3;10r'); // region rows 3..10
    feedStr(parser, '\x1b[?6h'); // origin mode: home = region top
    feedStr(parser, '\x1b[2;4H\x1b[6n'); // row 2 within region = absolute row 4
    expect(screen.cursorRow).toBe(3); // 0-based absolute
    expect(parser.pendingResponses.pop()!.toString('latin1')).toBe('\x1b[2;4R');
  });
});

describe('VT origin mode and scroll-region clamping', () => {
  it('CUP with origin mode is region-relative and clamped inside the region', () => {
    const { screen, parser } = setup();
    feedStr(parser, '\x1b[5;20r\x1b[?6h');
    feedStr(parser, '\x1b[1;1H');
    expect(screen.cursorRow).toBe(4); // region top (0-based)
    feedStr(parser, '\x1b[99;1H');
    expect(screen.cursorRow).toBe(19); // clamped to region bottom
  });

  it('CUU stops at the scroll region top margin', () => {
    const { screen, parser } = setup();
    feedStr(parser, '\x1b[5;20r'); // no origin mode
    feedStr(parser, '\x1b[10;1H\x1b[99A'); // cursor inside region, up 99
    expect(screen.cursorRow).toBe(4); // stops at margin, not row 0
  });
});

describe('VT alternate screen', () => {
  it('1049 enter clears; exit restores the primary content and cursor', () => {
    const { screen, parser } = setup();
    feedStr(parser, 'primary text');
    feedStr(parser, '\x1b[?1049h');
    expect(row(screen, 0).trim()).toBe(''); // alt starts blank
    feedStr(parser, 'ALT CONTENT');
    feedStr(parser, '\x1b[?1049l');
    expect(row(screen, 0)).toContain('primary text');
    expect(row(screen, 0)).not.toContain('ALT');
  });
});

describe('VT UTF-8 decoding', () => {
  it('assembles multi-byte sequences split across feed() chunks', () => {
    const { screen, parser } = setup();
    parser.encoding = 'utf8';
    const bytes = Buffer.from('héllo', 'utf8');
    parser.feed(bytes.subarray(0, 2)); // 'h' + first byte of é
    parser.feed(bytes.subarray(2));
    expect(row(screen, 0).trimEnd()).toBe('héllo');
  });

  it('latin1 default preserves byte-for-byte behavior', () => {
    const { screen, parser } = setup();
    parser.feed(Buffer.from([0x41, 0xe9])); // 'A' + latin1 é
    expect(row(screen, 0).slice(0, 2)).toBe('Aé');
  });
});

describe('DECCKM application cursor keys', () => {
  it('arrows switch to SS3 sequences when mode 1 is set', () => {
    const { parser, encoder } = setup();
    expect(encoder.encodeKey('ArrowUp')!.toString('latin1')).toBe('\x1b[A');
    feedStr(parser, '\x1b[?1h');
    expect(encoder.encodeKey('ArrowUp')!.toString('latin1')).toBe('\x1bOA');
    expect(encoder.encodeKey('UP')!.toString('latin1')).toBe('\x1bOA');
    feedStr(parser, '\x1b[?1l');
    expect(encoder.encodeKey('ArrowDown')!.toString('latin1')).toBe('\x1b[B');
  });
});
