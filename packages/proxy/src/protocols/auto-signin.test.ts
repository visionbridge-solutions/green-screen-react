import { describe, it, expect, vi } from 'vitest';
import { TN5250Handler } from './tn5250-handler.js';
import { FieldDef } from '../tn5250/screen.js';

// Regression: the proxy must NEVER type credentials into a screen that isn't a
// genuine sign-on screen. A reconnect that reattaches to an existing
// interactive job (stable DEVNAME → IBM i re-presents the live screen, not the
// sign-on) lands performAutoSignIn() on a data-entry form. Before the fix it
// blind-filled the username into the first underscore input and the password
// into the first non-display input — leaking credentials into business data
// (observed live: a claim form showing the kiosk username in "last name" and
// the password in "first name").

const ATTR_UNDERSCORE = 0x24;
const ATTR_NON_DISPLAY = 0x27;

function field(row: number, col: number, length: number, attribute: number): FieldDef {
  return {
    row, col, length,
    ffw1: 0, ffw2: 0, fcw1: 0, fcw2: 0, // ffw1 bit 0x20 clear ⇒ input field
    attribute, rawAttrByte: attribute, modified: false,
  };
}

function writeText(handler: TN5250Handler, row: number, col: number, text: string): void {
  for (let i = 0; i < text.length; i++) {
    handler.screen.setChar(row, col + i, text[i]);
  }
}

/** A claim-entry-style screen: has an underscore input AND a non-display input
 *  (the exact field shape that fooled the old attribute-only guard) but NO
 *  sign-on text. */
function claimEntryHandler(): TN5250Handler {
  const handler = new TN5250Handler();
  writeText(handler, 0, 24, 'CLAIMS PROCESSING - CPS101');
  handler.screen.fields.push(field(4, 20, 15, ATTR_UNDERSCORE));   // last name
  handler.screen.fields.push(field(4, 49, 13, ATTR_NON_DISPLAY));  // first name
  return handler;
}

/** A standard IBM i sign-on screen: "Sign On" title + user/password fields. */
function signOnHandler(): TN5250Handler {
  const handler = new TN5250Handler();
  writeText(handler, 0, 30, 'Sign On');
  writeText(handler, 5, 2, 'User');
  writeText(handler, 6, 2, 'Password');
  handler.screen.fields.push(field(5, 20, 10, ATTR_UNDERSCORE));   // user
  handler.screen.fields.push(field(6, 20, 10, ATTR_NON_DISPLAY));  // password
  return handler;
}

describe('performAutoSignIn — sign-on confirmation before typing credentials', () => {
  it('refuses to type credentials on a non-sign-on screen (claim form)', async () => {
    const handler = claimEntryHandler();
    const autoSignIn = vi.spyOn(handler, 'autoSignIn');
    const sendRaw = vi.spyOn(handler.connection, 'sendRaw').mockImplementation(() => {});

    const result = await handler.performAutoSignIn('DNCL', 'LEGACY202640040');

    // No credential keystrokes: autoSignIn never runs, nothing hits the wire.
    expect(autoSignIn).not.toHaveBeenCalled();
    expect(sendRaw).not.toHaveBeenCalled();
    // Surfaces the live screen, not authenticated — the integrator's own
    // sign-on cascade handles any real sign-on the proxy declines.
    expect(result?.authenticated).toBe(false);
    // The credentials must not appear anywhere in the screen buffer.
    const content = handler.getScreenData().content || '';
    expect(content).not.toContain('DNCL');
    expect(content).not.toContain('LEGACY202640');
  });

  it('proceeds to type credentials on a genuine sign-on screen', async () => {
    const handler = signOnHandler();
    // Stub the fill itself so the test stays a pure unit (no host round-trip);
    // we only assert the gate let it through with the right credentials.
    const autoSignIn = vi.spyOn(handler, 'autoSignIn').mockReturnValue(false);

    await handler.performAutoSignIn('KIOSK', 'hunter2');

    expect(autoSignIn).toHaveBeenCalledWith('KIOSK', 'hunter2');
  });
});
