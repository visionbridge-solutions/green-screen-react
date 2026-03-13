/**
 * Get the appropriate CSS class name for a row based on IBM 5250 conventions.
 *
 * - Row 0: Title row (white)
 * - Rows 22-23: F-key annotations (blue)
 * - Rows containing F-key references: Blue
 * - "Select one of the following": Blue
 * - Default: Green content
 */
export function getRowColorClass(rowIndex: number, rowContent: string): string {
  if (rowIndex === 0 && rowContent.trim().length > 0) {
    return 'tn5250-row-title';
  }

  if (rowIndex >= 22) {
    return 'tn5250-row-fkey';
  }

  if (/F\d{1,2}=/.test(rowContent)) {
    return 'tn5250-row-fkey';
  }

  if (/Select one of the following/i.test(rowContent)) {
    return 'tn5250-row-subtitle';
  }

  return 'tn5250-row-content';
}

/**
 * Parse the header row (row 0) into colored segments.
 * IBM 5250 convention: system name on left (blue), title (white), system name on right (green).
 *
 * Returns an array of { text, colorClass } segments, or null if no special rendering needed.
 */
export function parseHeaderRow(line: string): { text: string; colorClass: string }[] | null {
  if (line.trim().length === 0) return null;

  const trimmed = line.trimStart();
  const leftMatch = trimmed.match(/^(\S+)/);

  if (leftMatch) {
    const leftId = leftMatch[1];
    const leftStart = line.indexOf(leftId);
    const leftEnd = leftStart + leftId.length;

    const rightMatch = line.trimEnd().match(/(\S+)$/);

    if (rightMatch && rightMatch[1] !== leftId) {
      const rightId = rightMatch[1];
      const rightStart = line.lastIndexOf(rightId);

      return [
        { text: line.substring(0, leftEnd), colorClass: 'tn5250-row-fkey' },
        { text: line.substring(leftEnd, rightStart), colorClass: 'tn5250-row-title' },
        { text: line.substring(rightStart), colorClass: 'tn5250-row-content' },
      ];
    }
  }

  return [{ text: line, colorClass: 'tn5250-row-title' }];
}
