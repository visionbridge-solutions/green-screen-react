import { describe, it, expect } from 'vitest';
import type { Field } from 'green-screen-types';
import { fieldSliceForRow } from './fieldSlice';
import { tn5250Profile } from '../protocols/tn5250';

// A field's `length` is drawn as one span per row it touches. A width the host
// DECLARED may wrap (command lines span 2-3 rows); a width the proxy INFERRED
// from field spacing is an upper bound with no wrap semantics — on a live 80x24
// entry screen (2026-09-05) a bare input at row 20 col 0 arrived as length 147
// and the viewer painted it over the host's message rows. Any undeclared span
// is confined to its own row, whatever length arrives on the wire.

const wrapsDeclaredOnly = tn5250Profile.fieldWrapsRows!;

function input(row: number, col: number, length: number, declared = false): Field {
  return {
    row, col, length,
    is_input: true, is_protected: false,
    ...(declared ? { length_source: 'declared' as const } : {}),
  };
}

describe('fieldSliceForRow', () => {
  it('wraps a declared width across rows', () => {
    const f = input(19, 7, 153, true);
    expect(fieldSliceForRow(f, 19, 80, wrapsDeclaredOnly)).toEqual({ col: 7, length: 73 });
    expect(fieldSliceForRow(f, 20, 80, wrapsDeclaredOnly)).toEqual({ col: 0, length: 80 });
    expect(fieldSliceForRow(f, 21, 80, wrapsDeclaredOnly)).toBeNull();
  });

  it('wraps every field when the protocol does not distinguish (no predicate)', () => {
    // TN3270 / HP block mode: the wire length IS the host's field extent.
    const f = input(19, 7, 153);
    expect(fieldSliceForRow(f, 20, 80)).toEqual({ col: 0, length: 80 });
  });

  it('confines an undeclared length to its own row', () => {
    const f = input(20, 0, 147);
    expect(fieldSliceForRow(f, 20, 80, wrapsDeclaredOnly)).toEqual({ col: 0, length: 80 });
    expect(fieldSliceForRow(f, 21, 80, wrapsDeclaredOnly)).toBeNull();
  });

  it('never draws past cols - col for an undeclared length', () => {
    expect(fieldSliceForRow(input(4, 1, 78), 4, 80, wrapsDeclaredOnly)).toEqual({ col: 1, length: 78 });
    expect(fieldSliceForRow(input(4, 1, 90), 4, 80, wrapsDeclaredOnly)).toEqual({ col: 1, length: 79 });
    // the last row
    expect(fieldSliceForRow(input(23, 0, 89), 23, 80, wrapsDeclaredOnly)).toEqual({ col: 0, length: 80 });
    expect(fieldSliceForRow(input(23, 0, 89), 24, 80, wrapsDeclaredOnly)).toBeNull();
    // the screen's own width, not a fixed 80
    expect(fieldSliceForRow(input(5, 100, 60), 5, 132, wrapsDeclaredOnly)).toEqual({ col: 100, length: 32 });
  });

  it('still answers null for rows above the field', () => {
    expect(fieldSliceForRow(input(20, 0, 147), 19, 80, wrapsDeclaredOnly)).toBeNull();
  });
});

describe('tn5250Profile.fieldWrapsRows', () => {
  it('lets only a host-declared width continue onto the next row', () => {
    expect(wrapsDeclaredOnly(input(19, 7, 153, true))).toBe(true);
    expect(wrapsDeclaredOnly(input(19, 7, 153))).toBe(false);
  });
});
