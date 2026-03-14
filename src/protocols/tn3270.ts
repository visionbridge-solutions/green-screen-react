import type { ProtocolProfile } from '../adapters/types';

export const tn3270Profile: ProtocolProfile = {
  protocol: 'tn3270',
  displayName: 'IBM TN3270',
  defaultRows: 24,
  defaultCols: 80,
  headerLabel: 'TN3270 TERMINAL',
  bootText: 'TN3270',
  colors: {
    getRowColorClass(rowIndex: number, rowContent: string, totalRows: number): string {
      // z/OS ISPF conventions: row 0 = title, last 2 rows = PF keys/command
      if (rowIndex === 0 && rowContent.trim().length > 0) return 'gs-row-title';
      if (rowIndex >= totalRows - 2) return 'gs-row-fkey';
      if (/PF\d{1,2}[=/]/.test(rowContent) || /F\d{1,2}=/.test(rowContent)) return 'gs-row-fkey';
      if (/COMMAND\s*===>/i.test(rowContent) || /===>/.test(rowContent)) return 'gs-row-subtitle';
      if (/OPTION\s*===>/i.test(rowContent)) return 'gs-row-subtitle';
      return 'gs-row-content';
    },
    parseHeaderRow(line: string): { text: string; colorClass: string }[] | null {
      if (line.trim().length === 0) return null;
      // ISPF: typically "Menu  Utilities  Compilers  ..." action bar or panel title
      const trimmed = line.trimStart();
      const leftMatch = trimmed.match(/^(\S+)/);
      if (leftMatch) {
        const leftId = leftMatch[1];
        const leftEnd = line.indexOf(leftId) + leftId.length;
        const rightMatch = line.trimEnd().match(/(\S+)$/);
        if (rightMatch && rightMatch[1] !== leftId) {
          const rightStart = line.lastIndexOf(rightMatch[1]);
          return [
            { text: line.substring(0, leftEnd), colorClass: 'gs-row-fkey' },
            { text: line.substring(leftEnd, rightStart), colorClass: 'gs-row-title' },
            { text: line.substring(rightStart), colorClass: 'gs-row-content' },
          ];
        }
      }
      return [{ text: line, colorClass: 'gs-row-title' }];
    },
  },
};
