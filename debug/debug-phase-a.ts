/**
 * Phase A Debug: Sign-On Screen detailed interaction test
 * Tests: field positions, Tab cycling, typing, cursor positions
 */

import { chromium, Page } from 'playwright';
import * as fs from 'fs';
import * as path from 'path';

const CONFIG = {
  baseURL: 'http://localhost:5173/green-screen-react/',
  host: 'pub400.com',
  port: 23,
  username: process.env.DEBUG_USER || process.env.CONN_USERNAME || 'TARASOVD',
  password: process.env.DEBUG_PASS || process.env.CONN_PASSWORD || 'h5198fg091',
  screenshotDir: path.resolve(__dirname, 'screenshots/phase-a'),
  stateDir: path.resolve(__dirname, 'state-dumps/phase-a'),
  headless: process.env.DEBUG_HEADLESS !== 'false',
};

interface ScreenState {
  content: string;
  cursor_row: number;
  cursor_col: number;
  rows: number;
  cols: number;
  fields: Array<{
    row: number; col: number; length: number;
    is_input: boolean; is_protected: boolean;
    is_highlighted?: boolean; is_reverse?: boolean; is_underscored?: boolean;
  }>;
  screen_signature: string;
  timestamp: string;
}

let latestScreenState: ScreenState | null = null;
let step = 0;
const results: string[] = [];

function pass(msg: string) { results.push(`  PASS: ${msg}`); console.log(`  ✓ ${msg}`); }
function fail(msg: string) { results.push(`  FAIL: ${msg}`); console.log(`  ✗ ${msg}`); }
function info(msg: string) { results.push(`  INFO: ${msg}`); console.log(`  · ${msg}`); }

function setupWS(page: Page) {
  page.on('websocket', (ws) => {
    ws.on('framereceived', (frame) => {
      if (typeof frame.payload !== 'string') return;
      try {
        const msg = JSON.parse(frame.payload);
        if (msg.type === 'screen' && msg.data) latestScreenState = msg.data;
      } catch { }
    });
  });
}

function termBody(page: Page) { return page.locator('.gs-body').last(); }

async function snap(page: Page, label: string): Promise<ScreenState | null> {
  step++;
  const padded = String(step).padStart(2, '0');
  const scrPath = path.join(CONFIG.screenshotDir, `${padded}-${label}.png`);
  const termPath = path.join(CONFIG.screenshotDir, `${padded}-${label}-terminal.png`);
  const statePath = path.join(CONFIG.stateDir, `${padded}-${label}.json`);

  await page.screenshot({ path: scrPath, fullPage: true });
  try {
    const t = termBody(page);
    if (await t.isVisible()) await t.screenshot({ path: termPath });
  } catch { }

  const state = latestScreenState;
  fs.writeFileSync(statePath, JSON.stringify(state, null, 2));
  const inputFields = state?.fields?.filter(f => f.is_input) ?? [];
  console.log(`[${padded}] ${label} — cursor: (${state?.cursor_row ?? '?'}, ${state?.cursor_col ?? '?'}), fields: ${state?.fields?.length ?? '?'} (${inputFields.length} input)`);
  return state;
}

async function focusTerminal(page: Page) {
  await termBody(page).click();
  await page.waitForTimeout(200);
}

async function pressKey(page: Page, key: string, waitMs = 3000) {
  await termBody(page).press(key);
  await page.waitForTimeout(waitMs);
}

async function typeText(page: Page, text: string) {
  await focusTerminal(page);
  await termBody(page).pressSequentially(text, { delay: 60 });
  await page.waitForTimeout(300);
}

async function waitForScreen(prevSig: string | null, timeoutMs = 10000): Promise<ScreenState | null> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (latestScreenState && latestScreenState.screen_signature !== prevSig) return latestScreenState;
    await new Promise(r => setTimeout(r, 300));
  }
  return latestScreenState;
}

async function main() {
  fs.mkdirSync(CONFIG.screenshotDir, { recursive: true });
  fs.mkdirSync(CONFIG.stateDir, { recursive: true });

  console.log('=== Phase A: Sign-On Screen Detailed Test ===\n');

  const browser = await chromium.launch({ headless: CONFIG.headless });
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await context.newPage();
  setupWS(page);

  try {
    // Connect without auto-sign-in credentials to test the sign-on screen
    await page.goto(CONFIG.baseURL);
    await page.waitForLoadState('networkidle');

    // Fill connection form WITHOUT credentials to see sign-on screen
    const form = page.locator('.gs-signin');
    await form.waitFor({ state: 'visible', timeout: 10000 });
    await form.locator('input').first().fill(CONFIG.host);
    await form.locator('input[type="number"]').fill(String(CONFIG.port));
    // Leave username/password empty so we get sign-on screen without auto-signin
    await form.locator('button[type="submit"]').click();

    await termBody(page).waitFor({ state: 'visible', timeout: 30000 });

    // Wait for screen content
    const start = Date.now();
    while (Date.now() - start < 30000) {
      if (latestScreenState?.content?.trim()) break;
      await new Promise(r => setTimeout(r, 500));
    }
    await page.waitForTimeout(3000);

    // === CHECK 1: Sign-on screen content ===
    console.log('\n--- Check 1: Sign-on screen content ---');
    const state = await snap(page, 'signon');
    if (!state) { fail('No screen state received'); return; }

    const lines = state.content.split('\n');

    // Check welcome text
    if (lines[0]?.includes('Welcome') || lines[0]?.includes('PUB400')) {
      pass(`Row 0 has welcome text: "${lines[0].trim().substring(0, 60)}..."`);
    } else {
      fail(`Row 0 expected welcome text, got: "${lines[0]?.trim().substring(0, 60)}"`);
    }

    // Check for username and password labels
    const hasUserLabel = lines.some(l => l.includes('user name') || l.includes('User'));
    const hasPwLabel = lines.some(l => l.includes('Password') || l.includes('password'));
    if (hasUserLabel) pass('Username label found');
    else fail('Username label not found');
    if (hasPwLabel) pass('Password label found');
    else fail('Password label not found');

    // === CHECK 2: Field structure ===
    console.log('\n--- Check 2: Field structure ---');
    const inputFields = state.fields.filter(f => f.is_input);
    const protFields = state.fields.filter(f => f.is_protected);
    info(`Total fields: ${state.fields.length}, input: ${inputFields.length}, protected: ${protFields.length}`);

    if (inputFields.length >= 2) {
      pass(`At least 2 input fields found (${inputFields.length})`);
    } else {
      fail(`Expected at least 2 input fields, got ${inputFields.length}`);
    }

    // Check that username field has underscore attribute
    const userField = inputFields.find(f => f.is_underscored);
    if (userField) {
      pass(`Username field (underscored) at (${userField.row}, ${userField.col}) len=${userField.length}`);
    } else {
      fail('No underscored input field found (expected username field)');
    }

    // === CHECK 3: Cursor position ===
    console.log('\n--- Check 3: Cursor position ---');
    if (userField) {
      if (state.cursor_row === userField.row && state.cursor_col === userField.col) {
        pass(`Cursor on username field start: (${state.cursor_row}, ${state.cursor_col})`);
      } else {
        fail(`Cursor at (${state.cursor_row}, ${state.cursor_col}), expected (${userField.row}, ${userField.col})`);
      }
    }

    // === CHECK 4: Tab cycling ===
    console.log('\n--- Check 4: Tab cycling through input fields ---');
    await focusTerminal(page);

    const tabPositions: Array<{ row: number; col: number }> = [];
    tabPositions.push({ row: state.cursor_row, col: state.cursor_col });

    for (let i = 0; i < inputFields.length + 1; i++) {
      await pressKey(page, 'Tab', 500);
      const tabState = latestScreenState;
      if (tabState) {
        tabPositions.push({ row: tabState.cursor_row, col: tabState.cursor_col });
      }
    }
    await snap(page, 'after-tab-cycle');

    info(`Tab positions: ${tabPositions.map(p => `(${p.row},${p.col})`).join(' → ')}`);

    // Check Tab visits all input fields
    const fieldPositions = inputFields.map(f => `${f.row},${f.col}`);
    const visitedPositions = tabPositions.map(p => `${p.row},${p.col}`);
    const allVisited = fieldPositions.every(fp => visitedPositions.includes(fp));
    if (allVisited) {
      pass('Tab visits all input fields');
    } else {
      const missed = fieldPositions.filter(fp => !visitedPositions.includes(fp));
      fail(`Tab missed fields: ${missed.join('; ')}`);
    }

    // Check wrap-around (last Tab should return to first field)
    const firstPos = tabPositions[0];
    const lastPos = tabPositions[tabPositions.length - 1];
    if (firstPos.row === lastPos.row && firstPos.col === lastPos.col) {
      pass('Tab wraps around to first field');
    } else {
      info(`First: (${firstPos.row},${firstPos.col}), Last: (${lastPos.row},${lastPos.col}) — may not have wrapped yet`);
    }

    // === CHECK 5: Typing in username field ===
    console.log('\n--- Check 5: Typing text ---');
    // Move cursor to username field first
    if (userField) {
      // Press Tab until we're on the username field
      for (let i = 0; i < inputFields.length + 1; i++) {
        if (latestScreenState?.cursor_row === userField.row &&
            latestScreenState?.cursor_col === userField.col) break;
        await pressKey(page, 'Tab', 300);
      }
    }

    const beforeType = latestScreenState;
    await typeText(page, 'TEST');
    await snap(page, 'typed-test');

    const afterType = latestScreenState;
    if (afterType) {
      const typedLine = afterType.content.split('\n')[userField?.row ?? 0] ?? '';
      if (typedLine.includes('TEST')) {
        pass('Typed "TEST" appears on screen at correct position');
      } else {
        fail(`Typed "TEST" not found on row ${userField?.row}. Line: "${typedLine.trim()}"`);
      }
    }

    // === CHECK 6: Enter with empty password → error ===
    console.log('\n--- Check 6: Enter with invalid credentials ---');
    const prevSig = latestScreenState?.screen_signature ?? null;
    await pressKey(page, 'Enter', 8000);
    const errorState = await waitForScreen(prevSig, 10000);
    await snap(page, 'error-response');

    if (errorState) {
      // Check for error message or sign-on failure indicator
      const errorLines = errorState.content.split('\n');
      const lastLine = errorLines[errorLines.length - 1]?.trim();
      const hasError = errorLines.some(l =>
        l.toLowerCase().includes('not correct') ||
        l.toLowerCase().includes('not valid') ||
        l.toLowerCase().includes('error') ||
        l.toLowerCase().includes('incorrect') ||
        l.toLowerCase().includes('password')
      );
      if (hasError) {
        pass('Error message displayed for invalid credentials');
      } else {
        info(`No obvious error text found. Last line: "${lastLine}"`);
        info('Screen may have transitioned (e.g., to a different prompt)');
      }
    }

    // === CHECK 7: Sign in with valid credentials ===
    console.log('\n--- Check 7: Valid sign-in ---');
    // We may still be on sign-on screen or an error screen
    // Try typing valid username
    // First, clear previous input and re-enter
    // Navigate to username field
    for (let i = 0; i < inputFields.length + 1; i++) {
      const s = latestScreenState;
      if (s && userField && s.cursor_row === userField.row) break;
      await pressKey(page, 'Tab', 300);
    }

    // Clear field and type username
    await focusTerminal(page);
    // Select all text in field (Home then type to overwrite)
    await typeText(page, CONFIG.username);
    await pressKey(page, 'Tab', 500);
    await typeText(page, CONFIG.password);

    const preSig = latestScreenState?.screen_signature ?? null;
    await pressKey(page, 'Enter', 10000);
    await waitForScreen(preSig, 15000);
    await snap(page, 'after-valid-signin');

    // Handle possible message screens
    for (let attempt = 0; attempt < 5; attempt++) {
      const content = latestScreenState?.content ?? '';
      if (content.includes('Main Menu') || content.includes('===>')) break;
      await pressKey(page, 'Enter', 5000);
    }
    await snap(page, 'main-menu');

    const menuState = latestScreenState;
    if (menuState?.content.includes('Main Menu')) {
      pass('Successfully reached Main Menu');
    } else {
      info('Did not reach Main Menu — may need more Enter presses or different flow');
    }

    // === Phase B: Navigation check ===
    if (menuState?.content.includes('===>')) {
      console.log('\n--- Phase B: Navigation ---');

      // Test WRKSPLF command
      const sig1 = latestScreenState?.screen_signature ?? null;
      await focusTerminal(page);
      await typeText(page, 'WRKSPLF');
      await pressKey(page, 'Enter', 6000);
      await waitForScreen(sig1, 8000);
      await snap(page, 'wrksplf');

      const wrksplf = latestScreenState;
      if (wrksplf?.content.includes('Spooled') || wrksplf?.content.includes('spool')) {
        pass('WRKSPLF screen loaded');
      } else {
        info(`WRKSPLF: got screen with content starting: "${wrksplf?.content.substring(0, 100)}"`);
      }

      // F3 to go back
      const sig2 = latestScreenState?.screen_signature ?? null;
      await pressKey(page, 'F3', 5000);
      await waitForScreen(sig2, 6000);
      await snap(page, 'f3-back');

      const backState = latestScreenState;
      if (backState?.content.includes('Main Menu') || backState?.content.includes('===>')) {
        pass('F3 returned to previous screen');
      } else {
        info('F3 did not return to Main Menu');
      }

      // Test F12
      const sig3 = latestScreenState?.screen_signature ?? null;
      await focusTerminal(page);
      await typeText(page, 'WRKACTJOB');
      await pressKey(page, 'Enter', 6000);
      await waitForScreen(sig3, 8000);
      await snap(page, 'wrkactjob');

      const sig4 = latestScreenState?.screen_signature ?? null;
      await pressKey(page, 'F12', 5000);
      await waitForScreen(sig4, 6000);
      await snap(page, 'f12-back');

      if (latestScreenState?.content.includes('Main Menu') || latestScreenState?.content.includes('===>')) {
        pass('F12 returned to previous screen');
      } else {
        info('F12 did not return to Main Menu');
      }

      // === Phase C: Subfile screen test ===
      console.log('\n--- Phase C: Subfile/List screen ---');
      const sig5 = latestScreenState?.screen_signature ?? null;
      await focusTerminal(page);
      await typeText(page, 'WRKACTJOB');
      await pressKey(page, 'Enter', 6000);
      await waitForScreen(sig5, 8000);
      await snap(page, 'wrkactjob-list');

      const listState = latestScreenState;
      if (listState) {
        const listInputs = listState.fields.filter(f => f.is_input);
        info(`List screen: ${listState.fields.length} fields, ${listInputs.length} input`);

        // Check column alignment
        const listLines = listState.content.split('\n');
        const headerLine = listLines.find(l => l.includes('Subsystem') || l.includes('Job'));
        if (headerLine) {
          pass(`Column header found: "${headerLine.trim().substring(0, 60)}"`);
        }

        // Check "More..." indicator
        if (listState.content.includes('More...') || listState.content.includes('Bottom')) {
          pass('Scroll indicator (More.../Bottom) present');
        } else {
          info('No scroll indicator found');
        }

        // PageDown
        const sig6 = latestScreenState?.screen_signature ?? null;
        await pressKey(page, 'PageDown', 4000);
        await waitForScreen(sig6, 6000);
        await snap(page, 'pagedown');

        if (latestScreenState?.screen_signature !== sig6) {
          pass('PageDown loaded new data');
        } else {
          info('PageDown may not have changed the screen');
        }

        // PageUp back
        const sig7 = latestScreenState?.screen_signature ?? null;
        await pressKey(page, 'PageUp', 4000);
        await waitForScreen(sig7, 6000);
        await snap(page, 'pageup');
      }

      // F3 exit
      await pressKey(page, 'F3', 4000);

      // === Phase E: Error handling ===
      console.log('\n--- Phase E: Error handling ---');
      const sig8 = latestScreenState?.screen_signature ?? null;
      await focusTerminal(page);
      await typeText(page, 'XYZXYZ');
      await pressKey(page, 'Enter', 5000);
      await waitForScreen(sig8, 6000);
      await snap(page, 'garbage-command');

      const errState = latestScreenState;
      if (errState) {
        const errLines = errState.content.split('\n');
        const msgLine = errLines[errLines.length - 1]?.trim();
        if (msgLine && msgLine.length > 0 && msgLine !== ' '.repeat(80).trim()) {
          pass(`Error message on last line: "${msgLine.substring(0, 60)}"`);
        } else {
          info('No obvious error on last line');
        }
      }
    }

    // Sign off
    console.log('\n--- Signing off ---');
    await focusTerminal(page);
    await typeText(page, 'SIGNOFF');
    await pressKey(page, 'Enter', 5000);
    await snap(page, 'signoff');

    // Print summary
    console.log('\n=== Test Summary ===');
    const passes = results.filter(r => r.includes('PASS')).length;
    const fails = results.filter(r => r.includes('FAIL')).length;
    const infos = results.filter(r => r.includes('INFO')).length;
    console.log(`Passed: ${passes}, Failed: ${fails}, Info: ${infos}`);
    console.log('');
    for (const r of results) console.log(r);

  } catch (err) {
    console.error('Error:', err);
    try { await snap(page, 'error-state'); } catch { }
  } finally {
    await page.waitForTimeout(1000);
    await context.close();
    await browser.close();
    console.log('\nBrowser closed. Connection released.');
  }
}

main().catch(err => { console.error('Fatal:', err); process.exit(1); });
