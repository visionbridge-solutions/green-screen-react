/**
 * Convert a linear position in screen content to row/col coordinates.
 * Content is lines of characters separated by newlines.
 */
export function positionToRowCol(content: string, position: number): { row: number; col: number } {
  let row = 0;
  let col = 0;
  for (let i = 0; i < position && i < content.length; i++) {
    if (content[i] === '\n') {
      row++;
      col = 0;
    } else {
      col++;
    }
  }
  return { row, col };
}

/**
 * Detect if a content change is a field entry (small, localized change)
 * vs a screen transition (large, distributed change).
 *
 * Field entries: < 50 changed characters within a span of < 100 positions.
 * Screen transitions: everything else.
 */
export function isFieldEntry(previousContent: string | null | undefined, content: string | null | undefined): boolean {
  if (!previousContent || !content) return false;

  let diffCount = 0;
  let diffStart = -1;
  let diffEnd = 0;
  const maxLen = Math.max(previousContent.length, content.length);

  for (let i = 0; i < maxLen; i++) {
    const oldChar = previousContent[i] || ' ';
    const newChar = content[i] || ' ';
    if (oldChar !== newChar) {
      diffCount++;
      if (diffStart === -1) diffStart = i;
      diffEnd = i;
    }
  }

  const diffSpan = diffEnd - diffStart + 1;
  // Field entry: small number of changes (< 50 chars), localized (span < 100)
  return diffCount > 2 && diffCount < 50 && diffSpan < 100;
}
