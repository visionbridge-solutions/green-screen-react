import { describe, it, expect } from 'vitest';
import { ScreenBuffer, FieldDef } from './screen.js';
import { TN5250Parser } from './parser.js';

// Regression: an in-place auto-reconnect reuses the handler's single
// ScreenBuffer + parser, so the pre-drop screen's fields and buffer must be
// dropped on (re)connect. Otherwise stale fields render at their old rows over
// the reattached session (the "field values floating a row above their labels"
// bug) and the stale frame is re-served to every reattaching client — a browser
// refresh shows it too; only a full session teardown clears it.

function inputField(row: number, col: number, length: number): FieldDef {
  return {
    row, col, length,
    ffw1: 0, ffw2: 0, fcw1: 0, fcw2: 0,
    attribute: 0x24, rawAttrByte: 0x24, modified: false,
  };
}

describe('ScreenBuffer.reset() — coherent display on (re)connect', () => {
  it('drops fields, buffer content, windows and read state from the previous screen', () => {
    const screen = new ScreenBuffer();
    screen.codePage = 'cp273';

    // Populate as if a full screen had been parsed before the drop.
    screen.fields.push(inputField(5, 10, 6));
    screen.setChar(5, 10, 'X');
    screen.windowList.push({ row: 1, col: 1, height: 3, width: 10 });
    screen.keyboardLocked = true;
    screen.readOpcode = 0x42;
    screen.cursorRow = 5;
    screen.cursorCol = 16;
    screen.messageWaiting = true;
    screen.savedMsgLine = [' '];

    screen.reset();

    expect(screen.fields).toEqual([]);
    expect(screen.windowList).toEqual([]);
    expect(screen.getChar(5, 10)).toBe(' ');
    expect(screen.keyboardLocked).toBe(false);
    expect(screen.readOpcode).toBe(0);
    expect(screen.cursorRow).toBe(0);
    expect(screen.cursorCol).toBe(0);
    expect(screen.messageWaiting).toBe(false);
    expect(screen.savedMsgLine).toBeNull();

    // Dimensions and negotiated code page belong to the connection, not the
    // screen content — they must survive the reset.
    expect(screen.rows).toBe(24);
    expect(screen.cols).toBe(80);
    expect(screen.codePage).toBe('cp273');
  });

  it('toScreenData() reports a blank screen with no stale fields after reset', () => {
    const screen = new ScreenBuffer();
    screen.fields.push(inputField(8, 4, 5));
    screen.setChar(8, 4, 'A');

    screen.reset();

    const data = screen.toScreenData();
    expect(data.fields).toEqual([]);
    expect(data.content.replace(/[\s\n]/g, '')).toBe('');
  });
});

describe('TN5250Parser.reset() — transient parse state on (re)connect', () => {
  it('clears window offsets and pending flags so they cannot bleed into the reattached stream', () => {
    const screen = new ScreenBuffer();
    const parser = new TN5250Parser(screen);

    // Simulate state left mid-flight when the host dropped (e.g. a window was
    // open, so SBA addresses were window-relative; a query reply was pending).
    parser.winRowOff = 5;
    parser.winColOff = 12;
    parser.pendingQueryReply = true;

    parser.reset();

    expect(parser.winRowOff).toBe(0);
    expect(parser.winColOff).toBe(0);
    expect(parser.pendingQueryReply).toBe(false);
  });
});
