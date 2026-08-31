/**
 * The keyboard-locked screen-emission gate (2026-08-31).
 *
 * A slow host (live case: ~10s program transitions) paints one logical
 * screen as several WRITE records; emitting every record streamed
 * half-painted frames to viewers. The keyboard-restore bit is the host's
 * own transaction-complete signal: frames hold while locked, flush on
 * unlock (or on a calm cadence as a progress fallback).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TN5250Handler } from './tn5250-handler.js';

type AnyHandler = TN5250Handler & { emitScreenGated: () => void };

function gatedHandler(): { h: AnyHandler; frames: object[] } {
  const h = new TN5250Handler() as AnyHandler;
  const frames: object[] = [];
  h.on('screenChange', (d: object) => frames.push(d));
  return { h, frames };
}

describe('emitScreenGated', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => {
    vi.useRealTimers();
    delete process.env.GS_EMIT_PARTIAL_WRITES;
  });

  it('unlocked keyboard emits immediately', () => {
    const { h, frames } = gatedHandler();
    h.screen.keyboardLocked = false;
    h.emitScreenGated();
    expect(frames).toHaveLength(1);
    h.destroy();
  });

  it('locked keyboard holds the frame, flushes once on unlock', () => {
    const { h, frames } = gatedHandler();
    h.screen.keyboardLocked = true;
    h.emitScreenGated();
    h.emitScreenGated();
    h.emitScreenGated();
    expect(frames).toHaveLength(0); // half-painted bursts held

    h.screen.keyboardLocked = false; // host restores the keyboard
    h.emitScreenGated();
    expect(frames).toHaveLength(1); // the settled frame, once
    h.destroy();
  });

  it('long lock flushes at the calm cadence as a progress fallback', () => {
    const { h, frames } = gatedHandler();
    h.screen.keyboardLocked = true;
    h.emitScreenGated();
    expect(frames).toHaveLength(0);

    vi.advanceTimersByTime(TN5250Handler.LOCKED_FLUSH_MS + 10);
    expect(frames).toHaveLength(1); // one calm progress frame

    h.emitScreenGated(); // more bursts while still locked
    expect(frames).toHaveLength(1);
    vi.advanceTimersByTime(TN5250Handler.LOCKED_FLUSH_MS + 10);
    expect(frames).toHaveLength(2);
    h.destroy();
  });

  it('GS_EMIT_PARTIAL_WRITES=1 restores the old stream-every-record behaviour', () => {
    process.env.GS_EMIT_PARTIAL_WRITES = '1';
    const { h, frames } = gatedHandler();
    h.screen.keyboardLocked = true;
    h.emitScreenGated();
    h.emitScreenGated();
    expect(frames).toHaveLength(2);
    h.destroy();
  });

  it('destroy clears a pending flush timer (no post-destroy emits)', () => {
    const { h, frames } = gatedHandler();
    h.screen.keyboardLocked = true;
    h.emitScreenGated();
    h.destroy();
    vi.advanceTimersByTime(TN5250Handler.LOCKED_FLUSH_MS * 2);
    expect(frames).toHaveLength(0);
  });
});
