/**
 * Default BLOCK-MODE local-key table — keys handled in the local screen
 * buffer with no host round-trip (TN5250/TN3270-style editing).
 *
 * Cursor moves (Tab/arrows/Home/End) and buffer edits (Backspace/Delete/Insert/
 * Reset/FieldExit) mutate local screen state only; every other key is an AID that
 * transmits to the host. Transports (controller/routes) never consult this set
 * directly — they call `ProtocolHandler.isLocalKey()`, whose base implementation
 * uses this table; stream protocols (VT) override it to route every key to the
 * host, which owns the echo.
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
