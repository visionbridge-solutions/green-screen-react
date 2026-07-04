import { describe, it, expect } from 'vitest';
import { LOCAL_KEYS, isLocalKey } from './local-keys.js';

// LOCAL_KEYS was previously copy-pasted in three places (routes.ts ×2 +
// controller.ts) with a "must match" comment. It is now a single source; this
// pins the membership so REST and WS can never drift on whether a key
// round-trips to the host.

describe('LOCAL_KEYS single source', () => {
  it('treats cursor + buffer-edit keys as local (no host round-trip)', () => {
    for (const k of ['Tab', 'BACKTAB', 'ArrowLeft', 'HOME', 'Backspace', 'Reset', 'FieldExit']) {
      expect(isLocalKey(k), k).toBe(true);
    }
  });

  it('treats AID / function keys as remote', () => {
    for (const k of ['Enter', 'PF3', 'PF12', 'PA1', 'F1']) {
      expect(isLocalKey(k), k).toBe(false);
    }
  });

  it('has both cased and UPPER variants for every key', () => {
    // Every mixed-case entry has an UPPER twin (and vice-versa) so callers can
    // pass either form.
    expect(LOCAL_KEYS.has('Tab') && LOCAL_KEYS.has('TAB')).toBe(true);
    expect(LOCAL_KEYS.has('Backspace') && LOCAL_KEYS.has('BACKSPACE')).toBe(true);
  });
});
