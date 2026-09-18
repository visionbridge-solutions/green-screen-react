/**
 * Host-record accounting: `host_records` / `host_records_at_aid`.
 *
 * An integrator that must not press a second key before the host has answered
 * the first cannot wait on the screen CONTENT changing: a 5250 host can answer
 * with a byte-identical repaint, or with a record that only restores the
 * keyboard (live: an IBM i claim-detail line answered in ~25ms and changed
 * nothing visible, so a content-change wait read "no answer" for 34s and the
 * line was parked). The count of records the host has sent, and its value when
 * our last AID went out, answer the question without looking at content.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TN5250Handler } from './tn5250-handler.js';
import { CMD } from '../tn5250/constants.js';

type Fed = TN5250Handler & { onRecord: (r: Buffer) => void };

/** A GDS 5250 output record around `data` (the header layout the parser reads). */
function record(data: number[]): Buffer {
  return Buffer.from([
    ((data.length + 7) >> 8) & 0xff, (data.length + 7) & 0xff,
    0x12, 0xa0,
    0x00, 0x00,
    0x02,
    ...data,
  ]);
}

/** WTD writing `text` at row 1 col 1, then the keyboard restore (CC2 0x08). */
function wtdUnlock(text: string): Buffer {
  const chars = Array.from(text).map((c) => (c === ' ' ? 0x40 : 0xc1 + (c.charCodeAt(0) - 65)));
  return record([CMD.WRITE_TO_DISPLAY, 0x00, 0x08, 0x11, 0x01, 0x01, ...chars]);
}

function fedHandler(): { h: Fed; frames: Array<Record<string, unknown>> } {
  const h = new TN5250Handler() as Fed;
  const frames: Array<Record<string, unknown>> = [];
  h.on('screenChange', (d: Record<string, unknown>) => frames.push(d));
  return { h, frames };
}

describe('host-record accounting', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('stamps both counters on the screen data, starting at zero', () => {
    const { h } = fedHandler();
    const sd = h.getScreenData();
    expect(sd.host_records).toBe(0);
    expect(sd.host_records_at_aid).toBe(0);
    h.destroy();
  });

  it('an AID marks the count its answer must move past', () => {
    const { h } = fedHandler();
    h.onRecord(wtdUnlock('ABC'));
    expect(h.getScreenData().host_records).toBe(1);

    expect(h.sendKey('Enter')).toBe(true);
    const sent = h.getScreenData();
    expect(sent.host_records_at_aid).toBe(1);
    expect(sent.host_records).toBe(1); // no answer yet

    h.onRecord(wtdUnlock('ABC'));
    const answered = h.getScreenData();
    expect(answered.host_records).toBe(2);
    expect(answered.host_records! > answered.host_records_at_aid!).toBe(true);
    h.destroy();
  });

  it('a byte-identical repaint still moves the count, and reaches viewers', () => {
    const { h, frames } = fedHandler();
    h.onRecord(wtdUnlock('ABC'));
    h.sendKey('Enter');
    h.onRecord(wtdUnlock('ABC'));

    expect(frames).toHaveLength(2);
    expect(frames[1].content).toBe(frames[0].content); // nothing visible changed
    expect(frames[1].host_records).toBe(2);
    expect(frames[1].host_records_at_aid).toBe(1);
    h.destroy();
  });

  it('a keyboard-restore-only record is surfaced to viewers', () => {
    const { h, frames } = fedHandler();
    h.onRecord(wtdUnlock('ABC'));
    h.sendKey('Enter'); // locks the keyboard
    expect(h.screen.keyboardLocked).toBe(true);
    frames.length = 0;

    // WTD with no orders: paints nothing, restores the keyboard.
    h.onRecord(record([CMD.WRITE_TO_DISPLAY, 0x00, 0x08]));
    expect(h.screen.keyboardLocked).toBe(false);
    expect(frames).toHaveLength(1);
    expect(frames[0].host_records).toBe(2);
    h.destroy();
  });

  it('a record that paints nothing and keeps the lock is surfaced through the gate', () => {
    const { h, frames } = fedHandler();
    h.onRecord(wtdUnlock('ABC'));
    h.sendKey('Enter');
    frames.length = 0;

    // A no-op record: modifies nothing, restores nothing.
    h.onRecord(record([]));
    expect(frames).toHaveLength(0); // held while the keyboard is locked...
    vi.advanceTimersByTime(TN5250Handler.LOCKED_FLUSH_MS + 10);
    expect(frames).toHaveLength(1); // ...and flushed at the gate's cadence
    expect(frames[0].host_records).toBe(2);
    h.destroy();
  });

  it('an unparseable record is still counted', () => {
    const { h } = fedHandler();
    const before = h.getScreenData().host_records!;
    h.onRecord(Buffer.from([0x00]));
    expect(h.getScreenData().host_records).toBe(before + 1);
    h.destroy();
  });

  it('a local key is not an AID', () => {
    const { h } = fedHandler();
    h.onRecord(wtdUnlock('ABC'));
    h.sendKey('Tab');
    expect(h.getScreenData().host_records_at_aid).toBe(0);
    h.destroy();
  });
});
