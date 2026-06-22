import { describe, it, expect } from 'vitest';
import { ScreenBuffer } from './screen.js';

// Regression: synthesizeWindow() must only fire for a genuine INSET popup
// (the SAVE_SCREEN-without-CREATE_WINDOW prompter fallback). A full-screen
// application write whose content reaches a screen edge — e.g. a panel whose
// constant text ("Process a New Claim:") starts at column 0 — is NOT a popup.
// Synthesizing a window for it produced a col-0, near-full-screen WindowDef;
// the renderer then blanked the window's left border column (= screen column 0)
// of every spanned row, clipping the first character of each line
// ("rocess" / "pdate" / "rior"). Guard: bail unless the content box is inset
// on all four sides.

function writeBlock(s: ScreenBuffer, r0: number, c0: number, r1: number, c1: number, ch = 'X') {
  for (let r = r0; r <= r1; r++) {
    for (let c = c0; c <= c1; c++) s.setChar(r, c, ch);
  }
}

describe('ScreenBuffer.synthesizeWindow() — inset-popup guard', () => {
  it('does NOT synthesize for a full-screen write whose content reaches column 0', () => {
    const s = new ScreenBuffer();
    s.saveState(); // a SAVE_SCREEN is on the stack
    // Full-screen-ish content: text starting at column 0, spanning most rows.
    s.setChar(6, 0, 'P');   // "Process a New Claim:" — first char at col 0
    s.setChar(11, 0, 'U');  // "Update Existing Claim:"
    s.setChar(16, 0, 'P');  // "Prior Claim#->"
    writeBlock(s, 3, 5, 21, 60); // body text, but minCol is 0 from the labels above

    s.synthesizeWindow();

    expect(s.windowList).toEqual([]);
    // Host content stays intact — no border blanking, no clipped first column.
    expect(s.getChar(6, 0)).toBe('P');
    expect(s.getChar(11, 0)).toBe('U');
    expect(s.getChar(16, 0)).toBe('P');
  });

  it('does NOT synthesize when content reaches the right edge', () => {
    const s = new ScreenBuffer();
    s.saveState();
    writeBlock(s, 5, 10, 9, s.cols - 1); // touches the last column

    s.synthesizeWindow();

    expect(s.windowList).toEqual([]);
  });

  it('DOES synthesize a window for a genuinely inset popup', () => {
    const s = new ScreenBuffer();
    s.saveState();
    writeBlock(s, 5, 10, 9, 39); // inset on all four sides

    s.synthesizeWindow();

    expect(s.windowList).toHaveLength(1);
    expect(s.windowList[0]).toMatchObject({
      row: 4,        // max(0, minRow-1)
      col: 9,        // max(0, minCol-1)
      height: 5,     // maxRow-minRow+1
      width: 30,     // maxCol-minCol+1
    });
  });
});
