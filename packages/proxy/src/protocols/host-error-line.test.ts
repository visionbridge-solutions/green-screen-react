/**
 * The host's operator-error message survives a Reset, and its frame is never
 * held behind the keyboard lock.
 *
 * Live (2026-11-08/09): a function key on a claim-entry screen showed no
 * answer at all — no frame between the key and the client's next typing. The
 * host can answer a key with WRITE ERROR CODE (message on the error line,
 * keyboard left inhibited). The emission gate held that frame (keyboard
 * locked), the client pressed Reset inside the hold, and Reset restores the
 * saved message line — so the host's words reached no frame, no viewer and no
 * recording, and a reader after the Reset saw an unchanged screen.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TN5250Handler } from './tn5250-handler.js';
import { CMD } from '../tn5250/constants.js';

type Fed = TN5250Handler & { onRecord: (r: Buffer) => void };

function record(data: number[]): Buffer {
  return Buffer.from([
    ((data.length + 7) >> 8) & 0xff, (data.length + 7) & 0xff,
    0x12, 0xa0,
    0x00, 0x00,
    0x02,
    ...data,
  ]);
}

/** Upper-case letters and spaces in EBCDIC (A-I C1.., J-R D1.., S-Z E2..). */
function ebcdic(text: string): number[] {
  return Array.from(text).map((c) => {
    if (c === ' ') return 0x40;
    const i = c.charCodeAt(0) - 65;
    return i < 9 ? 0xc1 + i : i < 18 ? 0xd1 + (i - 9) : 0xe2 + (i - 18);
  });
}

/** WTD writing `text` at row 1 col 1, then the keyboard restore (CC2 0x08). */
function wtdUnlock(text: string): Buffer {
  return record([CMD.WRITE_TO_DISPLAY, 0x00, 0x08, 0x11, 0x01, 0x01, ...ebcdic(text)]);
}

/** WRITE ERROR CODE: `text` on the message line, keyboard left inhibited. */
function errorCode(text: string): Buffer {
  return record([CMD.WRITE_ERROR_CODE, ...ebcdic(text)]);
}

function fedHandler(): { h: Fed; frames: Array<Record<string, unknown>> } {
  const h = new TN5250Handler() as Fed;
  const frames: Array<Record<string, unknown>> = [];
  h.on('screenChange', (d: Record<string, unknown>) => frames.push(d));
  return { h, frames };
}

const lastRow = (content: unknown) => String(content).split('\n').at(-1) ?? '';

describe('host error line', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('the error frame is emitted at once, not held behind the lock', () => {
    const { h, frames } = fedHandler();
    h.onRecord(wtdUnlock('ABC'));
    expect(h.sendKey('F6')).toBe(true);
    const before = frames.length;

    h.onRecord(errorCode('NO DEPS'));
    expect(frames.length).toBe(before + 1);
    expect(lastRow(frames.at(-1)!.content)).toContain('NO DEPS');
    expect(frames.at(-1)!.host_error_line).toEqual({ text: 'NO DEPS', row: 23, active: true });
    h.destroy();
  });

  it('Reset restores the line but keeps the host\'s words until the next key', () => {
    const { h } = fedHandler();
    h.onRecord(wtdUnlock('ABC'));
    h.sendKey('F6');
    h.onRecord(errorCode('NO DEPS'));

    expect(h.sendKey('Reset')).toBe(true);
    const after = h.getScreenData();
    expect(after.keyboard_locked).toBeFalsy();
    expect(lastRow(after.content)).not.toContain('NO DEPS'); // the line is restored
    expect(after.host_error_line).toEqual({ text: 'NO DEPS', row: 23, active: false });

    h.sendKey('Enter'); // the next AID: the old message no longer answers it
    expect(h.getScreenData().host_error_line).toBeUndefined();
    h.destroy();
  });

  it('a host answer that is no error carries no error line', () => {
    const { h } = fedHandler();
    h.onRecord(wtdUnlock('ABC'));
    h.sendKey('Enter');
    h.onRecord(wtdUnlock('DEF'));
    expect(h.getScreenData().host_error_line).toBeUndefined();
    h.destroy();
  });

  it('an ordinary locked write is still held (the gate itself is unchanged)', () => {
    const { h, frames } = fedHandler();
    h.onRecord(wtdUnlock('ABC'));
    h.sendKey('Enter');
    const before = frames.length;
    h.onRecord(record([CMD.WRITE_TO_DISPLAY, 0x00, 0x00, 0x11, 0x01, 0x01, ...ebcdic('DEF')]));
    expect(frames.length).toBe(before);
    h.destroy();
  });
});
