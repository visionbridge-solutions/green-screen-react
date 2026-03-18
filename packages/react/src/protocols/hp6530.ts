import type { ProtocolProfile } from '../adapters/types';

export const hp6530Profile: ProtocolProfile = {
  protocol: 'hp6530',
  displayName: 'HP 6530',
  defaultRows: 24,
  defaultCols: 80,
  headerLabel: '6530 TERMINAL',
  bootText: 'HP6530',
  colors: {
    getRowColorClass(rowIndex: number, rowContent: string, totalRows: number): string {
      // HP NonStop 6530: row 0 = status/title, last row = function key labels
      if (rowIndex === 0 && rowContent.trim().length > 0) return 'gs-row-title';
      if (rowIndex >= totalRows - 1) return 'gs-row-fkey';
      if (/F\d{1,2}[=\-]/.test(rowContent) || /SF\d{1,2}/.test(rowContent)) return 'gs-row-fkey';
      return 'gs-row-content';
    },
    parseHeaderRow(line: string): { text: string; colorClass: string }[] | null {
      if (line.trim().length === 0) return null;
      return [{ text: line, colorClass: 'gs-row-title' }];
    },
  },
};
