import { describe, it, expect } from 'vitest';
import { decodeAttrByte, decodeExtColor, decodeExtHighlight, mergeExtAttr, cssVarForColor, extColorIsReverse } from './attribute';

describe('decodeAttrByte', () => {
  it('decodes 0x20 as normal green', () => {
    const a = decodeAttrByte(0x20);
    expect(a.color).toBe('green');
    expect(a.highIntensity).toBe(false);
    expect(a.underscore).toBe(false);
    expect(a.nonDisplay).toBe(false);
  });

  it('decodes 0x22 as high-intensity white (HI bit elevates green→white)', () => {
    const a = decodeAttrByte(0x22);
    expect(a.color).toBe('white');
    expect(a.highIntensity).toBe(true);
  });

  it('decodes 0x27 as non-display', () => {
    const a = decodeAttrByte(0x27);
    expect(a.nonDisplay).toBe(true);
  });

  it('decodes 0x24 as underscore', () => {
    const a = decodeAttrByte(0x24);
    expect(a.underscore).toBe(true);
    expect(a.reverse).toBe(false);
  });

  it('decodes 0x25 as underscore + reverse', () => {
    const a = decodeAttrByte(0x25);
    expect(a.underscore).toBe(true);
    expect(a.reverse).toBe(true);
  });

  it('decodes 0x28 as red (HI stays red)', () => {
    const a = decodeAttrByte(0x28);
    expect(a.color).toBe('red');
    const hi = decodeAttrByte(0x2A);
    expect(hi.color).toBe('red');
  });

  it('decodes 0x30/0x32 as turquoise/yellow', () => {
    expect(decodeAttrByte(0x30).color).toBe('turquoise');
    expect(decodeAttrByte(0x32).color).toBe('yellow');
  });

  it('decodes 0x38/0x3A as pink/blue', () => {
    expect(decodeAttrByte(0x38).color).toBe('pink');
    expect(decodeAttrByte(0x3A).color).toBe('blue');
  });
});

describe('decodeExtColor', () => {
  it('maps WEA color bytes to field colors', () => {
    expect(decodeExtColor(0x00)).toBe('green');
    expect(decodeExtColor(0x01)).toBe('blue');
    expect(decodeExtColor(0x02)).toBe('red');
    expect(decodeExtColor(0x03)).toBe('pink');
    expect(decodeExtColor(0x04)).toBe('turquoise');
    expect(decodeExtColor(0x05)).toBe('yellow');
    expect(decodeExtColor(0x06)).toBe('white');
    expect(decodeExtColor(0x07)).toBeUndefined();
  });

  it('decodes reverse-image variants (0x08-0x0E) to their base colors', () => {
    expect(decodeExtColor(0x08)).toBe('green');
    expect(decodeExtColor(0x09)).toBe('blue');
    expect(decodeExtColor(0x0A)).toBe('red');
    expect(decodeExtColor(0x0B)).toBe('pink');
    expect(decodeExtColor(0x0C)).toBe('turquoise');
    expect(decodeExtColor(0x0D)).toBe('yellow');
    expect(decodeExtColor(0x0E)).toBe('white');
  });
});

describe('extColorIsReverse', () => {
  it('detects reverse-image bit', () => {
    expect(extColorIsReverse(0x00)).toBe(false);
    expect(extColorIsReverse(0x07)).toBe(false);
    expect(extColorIsReverse(0x08)).toBe(true);
    expect(extColorIsReverse(0x0E)).toBe(true);
    expect(extColorIsReverse(0x0F)).toBe(false); // 0x0F is default reverse, not a color
  });
});

describe('decodeExtHighlight', () => {
  it('decodes additive highlight bits', () => {
    expect(decodeExtHighlight(0x01).underscore).toBe(true);
    expect(decodeExtHighlight(0x02).reverse).toBe(true);
    expect(decodeExtHighlight(0x04).blink).toBe(true);
    expect(decodeExtHighlight(0x08).columnSeparator).toBe(true);
    const all = decodeExtHighlight(0x0F);
    expect(all.underscore && all.reverse && all.blink && all.columnSeparator).toBe(true);
  });
});

describe('mergeExtAttr', () => {
  it('returns base when ext is undefined', () => {
    const base = decodeAttrByte(0x20);
    expect(mergeExtAttr(base, undefined)).toEqual(base);
  });

  it('overrides base color with ext color', () => {
    const base = decodeAttrByte(0x20); // green
    const merged = mergeExtAttr(base, { color: 0x02 }); // red
    expect(merged.color).toBe('red');
  });

  it('OR-merges highlight bits on top of base', () => {
    const base = decodeAttrByte(0x20); // no underscore
    const merged = mergeExtAttr(base, { highlight: 0x01 });
    expect(merged.underscore).toBe(true);
    expect(merged.color).toBe('green'); // color unchanged
  });
});

describe('cssVarForColor', () => {
  it('builds a var() reference for a known color', () => {
    expect(cssVarForColor('red')).toContain('--gs-red');
  });
  it('defaults to green for undefined', () => {
    expect(cssVarForColor(undefined)).toContain('--gs-green');
  });
});
