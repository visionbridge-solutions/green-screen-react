import { describe, it, expect } from 'vitest';
import { ebcdicToChar, charToEbcdic, type EbcdicCodePage } from './ebcdic.js';

describe('EBCDIC code pages', () => {
  it('cp37 (default) renders invariant + national bytes', () => {
    expect(ebcdicToChar(0xC1)).toBe('A'); // invariant letter
    expect(ebcdicToChar(0x9F)).toBe('¤'); // currency sign ¤ (no euro)
    expect(ebcdicToChar(0x4A)).toBe('¢'); // ¢ in CP37
  });

  it('cp1140 = cp37 + euro at 0x9F', () => {
    expect(ebcdicToChar(0x9F, 'cp1140')).toBe('€'); // €
    expect(ebcdicToChar(0xC1, 'cp1140')).toBe('A'); // invariant unchanged
  });

  it('cp273 (Germany/Austria) maps national variants', () => {
    expect(ebcdicToChar(0x4A, 'cp273')).toBe('Ä'); // Ä
    expect(ebcdicToChar(0x6A, 'cp273')).toBe('ö'); // ö
    expect(ebcdicToChar(0xC0, 'cp273')).toBe('ä'); // ä
    expect(ebcdicToChar(0xA1, 'cp273')).toBe('ß'); // ß
  });

  it('cp500 (International) maps brackets', () => {
    expect(ebcdicToChar(0x4A, 'cp500')).toBe('[');
    expect(ebcdicToChar(0x5A, 'cp500')).toBe(']');
    expect(ebcdicToChar(0xBB, 'cp500')).toBe('|');
  });

  it('cp1141 = cp273 + euro; cp1148 = cp500 + euro', () => {
    expect(ebcdicToChar(0x9F, 'cp1141')).toBe('€');
    expect(ebcdicToChar(0x4A, 'cp1141')).toBe('Ä'); // keeps German Ä
    expect(ebcdicToChar(0x9F, 'cp1148')).toBe('€');
    expect(ebcdicToChar(0x4A, 'cp1148')).toBe('['); // keeps Intl [
  });

  it('round-trips byte → char → byte for every code page', () => {
    const pages: EbcdicCodePage[] = ['cp37', 'cp273', 'cp500', 'cp1140', 'cp1141', 'cp1148'];
    for (const cp of pages) {
      for (const b of [0xC1, 0x4A, 0x5A, 0x6A, 0xC0, 0xA1, 0x9F, 0xBB, 0xF0]) {
        const ch = ebcdicToChar(b, cp);
        if (ch === ' ') continue; // unmapped/control collapses to space; skip
        expect(charToEbcdic(ch, cp)).toBe(b);
      }
    }
  });
});
