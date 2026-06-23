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

// The performAutoSignIn() gate above checks a snapshot taken before typing. But
// autoSignIn() resolves its target fields from the LIVE screen, and a job-reattach
// reconnect can swap the sign-on screen for the resumed application screen between
// the gate and the keystrokes. autoSignIn() must therefore re-confirm the live
// screen itself — these tests pin that second, atomic gate directly.
describe('autoSignIn — live-screen re-confirmation (reattach race)', () => {
  it('refuses to type when the live screen is not a sign-on (entry form swapped in)', () => {
    const handler = claimEntryHandler();
    const sendRaw = vi.spyOn(handler.connection, 'sendRaw').mockImplementation(() => {});

    // Stands in for the race end-state: the snapshot gate already passed on the
    // sign-on frame, but the resumed claim form is what's live when we type.
    const typed = handler.autoSignIn('DNCL', 'LEGACY202640040');

    expect(typed).toBe(false);
    expect(sendRaw).not.toHaveBeenCalled();
    const content = handler.getScreenData().content || '';
    expect(content).not.toContain('DNCL');
    expect(content).not.toContain('LEGACY202640');
  });

  it('types credentials when the live screen really is a sign-on', () => {
    const handler = signOnHandler();
    const sendRaw = vi.spyOn(handler.connection, 'sendRaw').mockImplementation(() => {});

    const typed = handler.autoSignIn('KIOSK', 'hunter2');

    expect(typed).toBe(true);
    expect(sendRaw).toHaveBeenCalledTimes(1);
    // Username lands in the visible user field; the password is wiped from the
    // buffer once the AID is built, so it never lingers as plaintext.
    expect(handler.getScreenData().content || '').toContain('KIOSK');
  });
});

// autoSignIn() saves the credentials before submitting so a FAILED sign-on (the
// host re-displays the sign-on screen with the fields cleared) can be re-filled.
// restoreFields() must only ever do that on a sign-on screen — a SUCCESSFUL
// sign-on lands on a menu/application screen, and restoring by field attribute
// there smears the username/password into the next input field (e.g. the menu
// command line), which is the second leak observed live ("DNCL2DEMO" in the
// command line). These tests pin that guard.
describe('restoreFields — never restores saved credentials onto a non-sign-on screen', () => {
  it('refuses to smear saved sign-on fields onto a menu command line', () => {
    const handler = signOnHandler();
    vi.spyOn(handler.connection, 'sendRaw').mockImplementation(() => {});
    // Save the credentials by signing on for real.
    expect(handler.autoSignIn('DNCL2', 'DNCL2DEMO')).toBe(true);

    // Host authenticates and lands on a MENU with a command line (underscore
    // input) and no sign-on text — exactly where the leak appeared.
    handler.screen.reset();
    writeText(handler, 19, 2, 'Selection or command');
    writeText(handler, 20, 0, '===>');
    handler.screen.fields.push(field(20, 6, 60, ATTR_UNDERSCORE)); // command line

    handler.restoreFields();

    // Neither the username nor the password is smeared into the command line.
    expect(handler.getScreenData().content || '').not.toContain('DNCL2');
  });

  it('still restores credentials onto a re-displayed sign-on screen (failed sign-on)', () => {
    const handler = signOnHandler();
    vi.spyOn(handler.connection, 'sendRaw').mockImplementation(() => {});
    expect(handler.autoSignIn('KIOSK', 'hunter2')).toBe(true);

    // Failed sign-on: the host re-displays the sign-on screen with cleared fields.
    handler.screen.reset();
    writeText(handler, 0, 30, 'Sign On');
    writeText(handler, 5, 2, 'User');
    writeText(handler, 6, 2, 'Password');
    handler.screen.fields.push(field(5, 20, 10, ATTR_UNDERSCORE));
    handler.screen.fields.push(field(6, 20, 10, ATTR_NON_DISPLAY));

    handler.restoreFields();

    // The user's credentials are refilled so a failed attempt isn't lost.
    expect(handler.getScreenData().content || '').toContain('KIOSK');
  });
});
