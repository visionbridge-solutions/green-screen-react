/**
 * Keys handled locally in the screen buffer — no host round-trip.
 *
 * Cursor moves (Tab/arrows/Home/End) and buffer edits (Backspace/Delete/Insert/
 * Reset/FieldExit) mutate local screen state only; every other key is an AID that
 * transmits to the host. This set was previously duplicated in three places
 * (routes.ts `/batch`, routes.ts module scope, controller.ts `handleKey`) with a
 * "must match" comment — a drift hazard where one edit would make REST and WS
 * disagree on whether a key round-trips. It now lives here as the single source.
 */
export const LOCAL_KEYS: ReadonlySet<string> = new Set([
  'Tab', 'Backtab', 'TAB', 'BACKTAB',
  'ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown',
  'LEFT', 'RIGHT', 'UP', 'DOWN',
  'Home', 'HOME', 'End', 'END',
  'Backspace', 'BACKSPACE', 'Delete', 'DELETE',
  'Insert', 'INSERT',
  'Reset', 'RESET',
  'FieldExit', 'FIELD_EXIT', 'FIELDEXIT',
]);

export function isLocalKey(key: string): boolean {
  return LOCAL_KEYS.has(key);
}
