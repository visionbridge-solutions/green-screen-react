import type { Field } from 'green-screen-types';

/** The geometry a slice needs; a wrap predicate may read the rest of the field. */
export type FieldSpan = Pick<Field, 'row' | 'col' | 'length'>;

/**
 * Compute the portion of a field that falls on a given row, handling
 * wrap-around for multi-row fields (common on IBM i command lines where a
 * single field spans 2-3 rows). Returns null if the field doesn't touch
 * this row. Otherwise returns { col, length } for the slice on this row.
 *
 * Example: field at (row 19, col 7, length 153) with cols=80:
 *   row 19 → { col: 7, length: 73 }   (73 chars: col 7..79)
 *   row 20 → { col: 0, length: 80 }   (next 80 chars: col 0..79)
 *   row 21 → null (len 73+80=153 exhausted)
 *
 * `wrapsRows` (see ProtocolProfile.fieldWrapsRows) says whether THIS field's
 * length may continue onto the next row. When it answers false the field is
 * confined to its own row: the slice is clipped at `cols`, so a length the
 * host never declared can never paint over the rows below it. No predicate
 * means every field wraps.
 */
export function fieldSliceForRow<F extends FieldSpan>(
  field: F,
  rowIndex: number,
  cols: number,
  wrapsRows?: (field: F) => boolean,
): { col: number; length: number } | null {
  const rowDelta = rowIndex - field.row;
  if (rowDelta < 0) return null;
  if (wrapsRows && !wrapsRows(field)) {
    if (rowDelta !== 0) return null;
    const clipped = Math.min(field.length, cols - field.col);
    return clipped > 0 ? { col: field.col, length: clipped } : null;
  }
  const offsetFromStart = rowDelta === 0 ? 0 : (cols - field.col) + (rowDelta - 1) * cols;
  if (offsetFromStart >= field.length) return null;
  const sliceCol = rowDelta === 0 ? field.col : 0;
  const sliceLen = Math.min(cols - sliceCol, field.length - offsetFromStart);
  if (sliceLen <= 0) return null;
  return { col: sliceCol, length: sliceLen };
}
