import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { TN5250Handler } from './tn5250-handler.js';
import { TN3270Handler } from './tn3270-handler.js';
import { VTHandler } from './vt-handler.js';
import { HP6530Handler } from './hp6530-handler.js';

// The capability seams replaced `instanceof TN5250Handler` gates and
// `attemptSignOff` duck-typing in the transports. These pins keep the seam
// honest: a capability is "the optional method exists", never a protocol
// identity check.

describe('protocol capability seams', () => {
  it('TN5250 is block-mode with MDT, auto-sign-in, and graceful exit', () => {
    const h = new TN5250Handler();
    expect(h.traits).toEqual({ inputModel: 'block', hasMdt: true });
    expect(typeof h.performAutoSignIn).toBe('function');
    expect(typeof h.attemptGracefulExit).toBe('function');
    expect(h.isLocalKey('Tab')).toBe(true);
    expect(h.isLocalKey('Enter')).toBe(false);
    h.destroy();
  });

  it('VT is stream-mode: no local keys, no auto-sign-in, no graceful exit', () => {
    const h = new VTHandler();
    expect(h.traits.inputModel).toBe('stream');
    expect(h.isLocalKey('Tab')).toBe(false);
    expect(h.isLocalKey('Backspace')).toBe(false);
    expect(h.performAutoSignIn).toBeUndefined();
    expect(h.attemptGracefulExit).toBeUndefined();
    h.destroy();
  });

  it('TN3270 and HP6530 default to block-mode without sign-on capabilities', () => {
    for (const h of [new TN3270Handler(), new HP6530Handler()]) {
      expect(h.traits.inputModel).toBe('block');
      expect(h.performAutoSignIn).toBeUndefined();
      expect(h.attemptGracefulExit).toBeUndefined();
      h.destroy();
    }
  });

  it('no transport source contains an instanceof-TN5250Handler gate anymore', () => {
    const src = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
    for (const file of ['controller.ts', 'routes.ts', 'session.ts', 'websocket.ts']) {
      const text = fs.readFileSync(path.join(src, file), 'utf8');
      expect(text, file).not.toMatch(/instanceof TN5250Handler/);
      expect(text, file).not.toMatch(/attemptSignOff/);
    }
  });
});
