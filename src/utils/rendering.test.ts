import { describe, it, expect } from 'vitest';
import { getRowColorClass, parseHeaderRow } from './rendering';

describe('getRowColorClass', () => {
  it('returns title class for row 0 with content', () => {
    expect(getRowColorClass(0, 'MAIN MENU')).toBe('tn5250-row-title');
  });

  it('returns content class for row 0 with empty content', () => {
    expect(getRowColorClass(0, '   ')).toBe('tn5250-row-content');
  });

  it('returns fkey class for rows 22-23', () => {
    expect(getRowColorClass(22, 'F3=Exit  F12=Cancel')).toBe('tn5250-row-fkey');
    expect(getRowColorClass(23, 'F3=Exit')).toBe('tn5250-row-fkey');
  });

  it('returns fkey class for rows with F-key references', () => {
    expect(getRowColorClass(15, 'Press F3=Exit to leave')).toBe('tn5250-row-fkey');
  });

  it('returns subtitle class for "Select one of the following"', () => {
    expect(getRowColorClass(5, '  Select one of the following')).toBe('tn5250-row-subtitle');
  });

  it('returns content class for regular rows', () => {
    expect(getRowColorClass(10, 'Some regular content here')).toBe('tn5250-row-content');
  });
});

describe('parseHeaderRow', () => {
  it('returns null for empty lines', () => {
    expect(parseHeaderRow('   ')).toBeNull();
  });

  it('parses header with left and right system names', () => {
    const line = 'SYSNAME                    MAIN MENU                    S1234567';
    const result = parseHeaderRow(line)!;
    expect(result).toHaveLength(3);
    expect(result[0].colorClass).toBe('tn5250-row-fkey');
    expect(result[1].colorClass).toBe('tn5250-row-title');
    expect(result[2].colorClass).toBe('tn5250-row-content');
  });

  it('returns single title segment when only one word', () => {
    const result = parseHeaderRow('TITLE')!;
    expect(result).toHaveLength(1);
    expect(result[0].colorClass).toBe('tn5250-row-title');
  });
});
