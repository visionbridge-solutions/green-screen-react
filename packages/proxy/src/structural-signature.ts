/**
 * Structural screen signature — a value- and text-independent identity for a
 * block-mode terminal screen, derived from the geometry of its INPUT fields.
 *
 * WHY THIS EXISTS
 * ---------------
 * The wire `ScreenData.screen_signature` is `md5(rendered_content)` — it flips
 * on every keystroke, counter tick, or status line, so it cannot answer the one
 * question every consumer actually asks: *which screen is this?* Downstream
 * integrators (e.g. the LegacyBridge backend) therefore reconstruct screen
 * identity several different ways from the rendered grid. The raw material for a
 * stable answer is already on the wire — every `Field` carries its protocol
 * structure (row/col/length/is_input). This primitive computes the canonical
 * structural id once, at the layer that owns the field structure, so consumers
 * can carry it instead of re-deriving it.
 *
 * Protocol-generic: it operates only on `Field[]`, so 5250 / 3270 / VT / HP6530
 * screen builders can all emit it. It bakes in no host-specific semantics.
 *
 * DEFINITION (scheme `v1`)
 * ------------------------
 *   1. Keep only INPUT (unprotected) fields.
 *   2. Drop fields in the bottom status/function-key region (row >= footerCutoff).
 *      Block-mode hosts re-paint transient messages there as input-shaped fields;
 *      excluding the region keeps a screen's identity stable mid-error-recovery.
 *   3. Sort the surviving (row, col, length) triples.
 *   4. signature = sha256( "v1:" + triples.join(";")  )  where each triple is "r,c,l".
 *   Returns `undefined` when there are no qualifying input fields (identity
 *   degrades to a no-op; consumers fall back to their own keys).
 *
 * The serialization is a stable, language-neutral string so an independent
 * re-implementation (the backend mirrors it in `ai/services/structural_signature.py`)
 * produces a byte-identical hash. Keep the two in lockstep.
 *
 * PARITY VECTOR (must match the backend mirror exactly):
 *   fields with input (row,col,length) = (3,20,10),(5,35,8),(7,20,12)
 *   canonical = "v1:3,20,10;5,35,8;7,20,12"
 *   sha256    = 1837c10a7a6733441e2810bb6fd62213ec9929de384e27fb2b8eb86246511968
 *   verify:  node -e "import('crypto').then(c=>console.log(c.createHash('sha256').update('v1:3,20,10;5,35,8;7,20,12').digest('hex')))"
 */
import { createHash } from 'crypto';
import type { Field } from 'green-screen-types';

/**
 * Bottom-region cutoff. Rows at/above this index are treated as the transient
 * host status / F-key footer and excluded from identity. 21 matches a standard
 * 24-row screen's status region and is the value the LegacyBridge backend's
 * input-skeleton dedup uses (`_FOOTER_CUTOFF`); keep them aligned for parity.
 */
export const DEFAULT_FOOTER_CUTOFF = 21;

/** Canonical scheme tag, prefixed onto the serialized skeleton. Bump on format change. */
export const STRUCTURAL_SIGNATURE_SCHEME = 'v1';

/**
 * Compute the structural signature of a screen from its field list.
 * @param fields the screen's `Field[]` (as built for `ScreenData.fields`).
 * @param footerCutoff rows >= this are excluded (default {@link DEFAULT_FOOTER_CUTOFF}).
 * @returns the sha256 hex id, or `undefined` if the screen has no input fields.
 */
export function computeStructuralSignature(
  fields: Field[],
  footerCutoff: number = DEFAULT_FOOTER_CUTOFF,
): string | undefined {
  const triples: Array<[number, number, number]> = [];
  for (const f of fields) {
    if (f.is_protected) continue; // structural skeleton = input fields only
    if (f.row >= footerCutoff) continue; // skip transient status/error region
    triples.push([f.row, f.col, f.length]);
  }
  if (triples.length === 0) return undefined;
  triples.sort((a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2]);
  const canonical =
    `${STRUCTURAL_SIGNATURE_SCHEME}:` +
    triples.map(([r, c, l]) => `${r},${c},${l}`).join(';');
  return createHash('sha256').update(canonical).digest('hex');
}
