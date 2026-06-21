import { describe, it, expect } from 'vitest';
import { aidTransmitsData, commandKeysWithoutData } from './command-keys.js';
import { KEY_TO_AID } from './constants.js';

// SOH key-mask layout: byte 6 = F1..F8 (bit 0x01=F1 .. 0x80=F8), byte 5 =
// F9..F16, byte 4 = F17..F24. A SET bit = CA (no transmit), CLEAR = CF.
// headerData indices 0-3 are not part of the key mask.
function header(byte4: number, byte5: number, byte6: number): number[] {
  return [0, 0, 0, 0, byte4, byte5, byte6];
}

describe('SOH command-key mask (CA vs CF)', () => {
  it('lists the CA function keys (set bits), ascending', () => {
    // F6 (byte6 0x20) + F12 (byte5 0x08) marked CA
    expect(commandKeysWithoutData(header(0x00, 0x08, 0x20))).toEqual(['F6', 'F12']);
  });

  it('a CA key does not transmit; a CF key does', () => {
    const hdr = header(0x00, 0x08, 0x20);
    expect(aidTransmitsData(hdr, KEY_TO_AID['F6'])).toBe(false);  // CA
    expect(aidTransmitsData(hdr, KEY_TO_AID['F12'])).toBe(false); // CA
    expect(aidTransmitsData(hdr, KEY_TO_AID['F1'])).toBe(true);   // CF (bit clear)
    expect(aidTransmitsData(hdr, KEY_TO_AID['F3'])).toBe(true);   // CF
  });

  it('decodes the F17-F24 group + its edges (F17 low bit, F24 high bit)', () => {
    expect(commandKeysWithoutData(header(0x81, 0x00, 0x00))).toEqual(['F17', 'F24']);
  });

  it('all-clear mask = every key transmits', () => {
    const hdr = header(0x00, 0x00, 0x00);
    expect(commandKeysWithoutData(hdr)).toEqual([]);
    expect(aidTransmitsData(hdr, KEY_TO_AID['F6'])).toBe(true);
  });

  it('all-CA mask lists every F-key (F1..F24)', () => {
    const all = commandKeysWithoutData(header(0xff, 0xff, 0xff));
    expect(all).toHaveLength(24);
    expect(all[0]).toBe('F1');
    expect(all[23]).toBe('F24');
  });

  it('no key mask (missing / short header) defaults to transmit', () => {
    expect(commandKeysWithoutData(undefined)).toEqual([]);
    expect(commandKeysWithoutData([0, 0, 0])).toEqual([]); // < 7 bytes
    expect(aidTransmitsData(undefined, KEY_TO_AID['F6'])).toBe(true);
    expect(aidTransmitsData([0, 0, 0], KEY_TO_AID['F6'])).toBe(true);
  });

  it('non-function AID keys always transmit, even under an all-CA mask', () => {
    const hdr = header(0xff, 0xff, 0xff);
    expect(aidTransmitsData(hdr, KEY_TO_AID['Enter'])).toBe(true);
  });
});
