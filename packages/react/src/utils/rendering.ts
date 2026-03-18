import { getProtocolProfile } from '../protocols/registry';

/**
 * Get the appropriate CSS class name for a row.
 * Delegates to the TN5250 protocol profile for backward compatibility.
 *
 * For protocol-aware rendering, use `getProtocolProfile(protocol).colors.getRowColorClass()`.
 */
export function getRowColorClass(rowIndex: number, rowContent: string): string {
  return getProtocolProfile('tn5250').colors.getRowColorClass(rowIndex, rowContent, 24);
}

/**
 * Parse the header row into colored segments.
 * Delegates to the TN5250 protocol profile for backward compatibility.
 *
 * For protocol-aware rendering, use `getProtocolProfile(protocol).colors.parseHeaderRow()`.
 */
export function parseHeaderRow(line: string): { text: string; colorClass: string }[] | null {
  return getProtocolProfile('tn5250').colors.parseHeaderRow(line);
}
