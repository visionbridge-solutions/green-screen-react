import type { ProtocolProfile } from '../adapters/types';

export const vtProfile: ProtocolProfile = {
  protocol: 'vt',
  displayName: 'VT Terminal',
  defaultRows: 24,
  defaultCols: 80,
  headerLabel: 'VT TERMINAL',
  bootText: 'VT220',
  colors: {
    getRowColorClass(_rowIndex: number, _rowContent: string, _totalRows: number): string {
      // VT terminals use inline escape-sequence-driven colors, not row-based conventions.
      // All rows default to green; actual colors come from ANSI attributes in the data stream.
      return 'gs-row-content';
    },
    parseHeaderRow(_line: string): { text: string; colorClass: string }[] | null {
      // VT has no header row convention
      return null;
    },
  },
};
