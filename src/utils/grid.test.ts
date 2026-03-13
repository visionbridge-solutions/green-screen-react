import { describe, it, expect } from 'vitest';
import { positionToRowCol, isFieldEntry } from './grid';

describe('positionToRowCol', () => {
  it('returns 0,0 for position 0', () => {
    expect(positionToRowCol('hello\nworld', 0)).toEqual({ row: 0, col: 0 });
  });

  it('tracks columns within a line', () => {
    expect(positionToRowCol('hello\nworld', 3)).toEqual({ row: 0, col: 3 });
  });

  it('increments row on newline', () => {
    expect(positionToRowCol('hello\nworld', 6)).toEqual({ row: 1, col: 0 });
  });

  it('tracks position on second line', () => {
    expect(positionToRowCol('hello\nworld', 8)).toEqual({ row: 1, col: 2 });
  });

  it('handles position beyond content length', () => {
    const result = positionToRowCol('ab', 10);
    expect(result.row).toBe(0);
    expect(result.col).toBe(2);
  });
});

describe('isFieldEntry', () => {
  it('returns false for null inputs', () => {
    expect(isFieldEntry(null, 'hello')).toBe(false);
    expect(isFieldEntry('hello', null)).toBe(false);
    expect(isFieldEntry(null, null)).toBe(false);
  });

  it('returns false for identical content', () => {
    expect(isFieldEntry('hello', 'hello')).toBe(false);
  });

  it('returns true for small localized changes', () => {
    const prev = 'Name: ________  '.padEnd(80, ' ');
    const next = 'Name: John____  '.padEnd(80, ' ');
    expect(isFieldEntry(prev, next)).toBe(true);
  });

  it('returns false for large distributed changes (screen transition)', () => {
    const prev = 'Screen 1'.padEnd(1920, ' ');
    const next = 'Screen 2'.padEnd(1920, 'X');
    expect(isFieldEntry(prev, next)).toBe(false);
  });

  it('returns false for very small changes (< 3 chars)', () => {
    const prev = 'AB'.padEnd(80, ' ');
    const next = 'AC'.padEnd(80, ' ');
    expect(isFieldEntry(prev, next)).toBe(false);
  });
});
