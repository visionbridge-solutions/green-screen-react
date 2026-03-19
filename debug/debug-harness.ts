/**
 * TN5250 Debug Harness — Standalone Playwright script for capturing
 * reference screenshots and extracting internal emulator state.
 *
 * Usage:
 *   1. Start the dev server: npm run dev
 *   2. Run: npx tsx debug/debug-harness.ts
 *
 * Outputs:
 *   - debug/screenshots/  — PNG screenshots (full page + terminal only)
 *   - debug/state-dumps/  — JSON state dumps (ScreenData from WebSocket)
 */

import { chromium, Page } from 'playwright';
import * as fs from 'fs';
import * as path from 'path';

// ═══════════════════════════════════════════════════════════════
// Configuration
// ═══════════════════════════════════════════════════════════════

const CONFIG = {
  baseURL: 'http://localhost:5173/green-screen-react/',
  host: 'pub400.com',
  port: 23,
  // Credentials — override via env: DEBUG_USER, DEBUG_PASS
  username: process.env.DEBUG_USER || 'TARASOVD',
  password: process.env.DEBUG_PASS || 'h5198fg091',
  screenshotDir: path.resolve(__dirname, 'screenshots'),
  stateDir: path.resolve(__dirname, 'state-dumps'),
  headless: process.env.DEBUG_HEADLESS !== 'false',
  timeout: 120_000,
};

// ═══════════════════════════════════════════════════════════════
// Types
// ═══════════════════════════════════════════════════════════════

interface ScreenState {
  content: string;
  cursor_row: number;
  cursor_col: number;
  rows: number;
  cols: number;
  fields: Array<{
    row: number;
    col: number;
    length: number;
    is_input: boolean;
    is_protected: boolean;
    is_highlighted?: boolean;
    is_reverse?: boolean;
    is_underscored?: boolean;
  }>;
  screen_signature: string;
  timestamp: string;
}

interface DebugSnapshot {
  step: number;
  label: string;
  screenshotPath: string;
  terminalScreenshotPath: string;
  statePath: string;
  state: ScreenState | null;
  capturedAt: string;
}

// ═══════════════════════════════════════════════════════════════
// State Store — populated by WebSocket message interception
// ═══════════════════════════════════════════════════════════════

let latestScreenState: ScreenState | null = null;

function setupWebSocketCapture(page: Page): void {
  page.on('websocket', (ws) => {
    ws.on('framereceived', (frame) => {
      if (typeof frame.payload !== 'string') return;
      try {
        const msg = JSON.parse(frame.payload);
        if (msg.type === 'screen' && msg.data) {
          latestScreenState = msg.data as ScreenState;
        }
      } catch {
        // ignore non-JSON
      }
    });
  });
}

// ═══════════════════════════════════════════════════════════════
// State Extraction
// ═══════════════════════════════════════════════════════════════

function getScreenState(): ScreenState | null {
  return latestScreenState;
}

function getScreenSignature(): string | null {
  return latestScreenState?.screen_signature ?? null;
}

// ═══════════════════════════════════════════════════════════════
// Locators
// ═══════════════════════════════════════════════════════════════

/** The active terminal is the last visible .gs-body on the page */
function termBody(page: Page) {
  return page.locator('.gs-body').last();
}

// ═══════════════════════════════════════════════════════════════
// Screenshot & State Dump
// ═══════════════════════════════════════════════════════════════

async function snap(page: Page, step: number, label: string): Promise<DebugSnapshot> {
  const paddedStep = String(step).padStart(2, '0');
  const baseName = `${paddedStep}-${label}`;

  const screenshotPath = path.join(CONFIG.screenshotDir, `${baseName}.png`);
  const terminalScreenshotPath = path.join(CONFIG.screenshotDir, `${baseName}-terminal.png`);
  const statePath = path.join(CONFIG.stateDir, `${baseName}.json`);

  // Full page screenshot
  await page.screenshot({ path: screenshotPath, fullPage: true });

  // Terminal-only screenshot (if terminal is visible)
  try {
    const terminal = termBody(page);
    if (await terminal.isVisible()) {
      await terminal.screenshot({ path: terminalScreenshotPath });
    }
  } catch {
    // Terminal not visible yet — skip
  }

  // State dump
  const state = getScreenState();
  fs.writeFileSync(statePath, JSON.stringify(state, null, 2));

  const snapshot: DebugSnapshot = {
    step,
    label,
    screenshotPath,
    terminalScreenshotPath,
    statePath,
    state,
    capturedAt: new Date().toISOString(),
  };

  const inputFields = state?.fields?.filter(f => f.is_input) ?? [];
  console.log(`  [${paddedStep}] ${label} — cursor: (${state?.cursor_row ?? '?'}, ${state?.cursor_col ?? '?'}), fields: ${state?.fields?.length ?? '?'} (${inputFields.length} input)`);

  return snapshot;
}

// ═══════════════════════════════════════════════════════════════
// Terminal Interaction
// ═══════════════════════════════════════════════════════════════

async function focusTerminal(page: Page): Promise<void> {
  await termBody(page).click();
  await page.waitForTimeout(200);
}

async function typeText(page: Page, text: string): Promise<void> {
  await focusTerminal(page);
  await termBody(page).pressSequentially(text, { delay: 60 });
  await page.waitForTimeout(200);
}

async function pressKey(page: Page, key: string, waitMs = 4000): Promise<void> {
  await termBody(page).press(key);
  await page.waitForTimeout(waitMs);
}

async function waitForScreenUpdate(
  previousSignature: string | null,
  timeoutMs = 10000,
): Promise<ScreenState | null> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const state = getScreenState();
    if (state && state.screen_signature !== previousSignature) return state;
    await new Promise(r => setTimeout(r, 300));
  }
  return getScreenState();
}

async function execCommand(page: Page, command: string, waitMs = 6000): Promise<ScreenState | null> {
  const prevSig = getScreenSignature();
  await focusTerminal(page);
  await typeText(page, command);
  await pressKey(page, 'Enter', waitMs);
  return waitForScreenUpdate(prevSig, waitMs);
}

// ═══════════════════════════════════════════════════════════════
// Screen Text Dump (human-readable)
// ═══════════════════════════════════════════════════════════════

function dumpScreenText(state: ScreenState): string {
  const lines = state.content.split('\n');
  const out: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    out.push(`Row ${String(i + 1).padStart(2, '0')}: ${lines[i]}`);
  }
  out.push(`Cursor: (${state.cursor_row}, ${state.cursor_col})`);
  out.push(`Fields (${state.fields.length}):`);
  for (const f of state.fields) {
    const type = f.is_input ? 'INPUT' : 'PROT';
    const attrs: string[] = [];
    if (f.is_highlighted) attrs.push('HI');
    if (f.is_reverse) attrs.push('REV');
    if (f.is_underscored) attrs.push('UL');
    out.push(`  (${f.row},${f.col}) len=${f.length} ${type} ${attrs.join(',')}`);
  }
  return out.join('\n');
}

// ═══════════════════════════════════════════════════════════════
// Sign-In Flow
// ═══════════════════════════════════════════════════════════════

async function fillConnectionForm(page: Page): Promise<void> {
  const form = page.locator('.gs-signin');
  await form.waitFor({ state: 'visible', timeout: 10_000 });

  await form.locator('input').first().fill(CONFIG.host);
  await form.locator('input[type="number"]').fill(String(CONFIG.port));
  await form.locator('input[autocomplete="username"]').fill(CONFIG.username);
  await form.locator('input[type="password"]').fill(CONFIG.password);
}

async function submitAndWaitForTerminal(page: Page): Promise<void> {
  const form = page.locator('.gs-signin');
  await form.locator('button[type="submit"]').click();

  // Wait for terminal body to appear
  await termBody(page).waitFor({ state: 'visible', timeout: 30_000 });

  // Wait for screen content to arrive via WebSocket
  const start = Date.now();
  while (Date.now() - start < 30_000) {
    const state = getScreenState();
    if (state && state.content && state.content.trim().length > 0) break;
    await new Promise(r => setTimeout(r, 500));
  }
  await page.waitForTimeout(2000);
}

async function signOff(page: Page): Promise<void> {
  try {
    await focusTerminal(page);
    await typeText(page, 'SIGNOFF');
    await pressKey(page, 'Enter', 5000);
  } catch {
    console.log('  Warning: signoff may have failed');
  }
}

// ═══════════════════════════════════════════════════════════════
// Main Scenario
// ═══════════════════════════════════════════════════════════════

async function main() {
  // Ensure output directories
  fs.mkdirSync(CONFIG.screenshotDir, { recursive: true });
  fs.mkdirSync(CONFIG.stateDir, { recursive: true });

  console.log('=== TN5250 Debug Harness ===');
  console.log(`Target: ${CONFIG.host}:${CONFIG.port}`);
  console.log(`Headless: ${CONFIG.headless}`);
  console.log(`Output: ${CONFIG.screenshotDir}`);
  console.log('');

  const browser = await chromium.launch({ headless: CONFIG.headless });
  const context = await browser.newContext({
    viewport: { width: 1280, height: 900 },
  });
  const page = await context.newPage();

  // Capture WebSocket messages for state extraction
  setupWebSocketCapture(page);

  let step = 1;

  try {
    // ── 01. Load app ──
    console.log('Phase 1: Loading app and connecting...');
    await page.goto(CONFIG.baseURL);
    await page.waitForLoadState('networkidle');
    await snap(page, step++, 'connection-form');

    // ── 02. Fill and submit connection form ──
    await fillConnectionForm(page);
    await submitAndWaitForTerminal(page);
    await snap(page, step++, 'initial-connect');

    // Wait for screen to stabilize
    await page.waitForTimeout(3000);
    await snap(page, step++, 'sign-on-screen');

    // ── 03. Check if auto-sign-in already happened ──
    // (when credentials are provided in the form, auto-sign-in runs server-side)
    const bodyText = await termBody(page).textContent() || '';
    const alreadySignedIn = !bodyText.includes('Sign On');

    if (!alreadySignedIn) {
      // Manual sign-in path
      console.log('Phase 2: Manual sign-in flow...');
      await focusTerminal(page);
      await typeText(page, CONFIG.username);
      await snap(page, step++, 'username-entered');

      await pressKey(page, 'Tab', 500);
      await typeText(page, CONFIG.password);
      await snap(page, step++, 'password-entered');

      await page.waitForTimeout(1000);
      await pressKey(page, 'Enter', 10000);
      await snap(page, step++, 'after-sign-in');
    } else {
      console.log('Phase 2: Auto-sign-in completed, capturing post-signin state...');
      await snap(page, step++, 'auto-signed-in');
      // Skip manual steps — renumber to keep consistent
      step += 2;
    }

    // ── 04. Handle message/welcome screens until main menu ──
    console.log('Phase 3: Navigating to main menu...');
    for (let attempt = 0; attempt < 5; attempt++) {
      const screenText = await termBody(page).textContent() || '';
      if (screenText.includes('Main Menu') || screenText.includes('===>')) break;
      await pressKey(page, 'Enter', 8000);
    }

    await snap(page, step++, 'main-menu');

    // ── 05. Navigate and capture screens ──
    const currentText = await termBody(page).textContent() || '';
    if (currentText.includes('Main Menu') || currentText.includes('===>') ||
        currentText.includes('command') || currentText.includes('selection')) {
      console.log('Phase 4: Capturing reference screens...');

      // WRKACTJOB
      await execCommand(page, 'WRKACTJOB');
      await snap(page, step++, 'wrkactjob');

      // F5 refresh
      await pressKey(page, 'F5', 4000);
      await snap(page, step++, 'wrkactjob-f5');

      // F3 exit
      await pressKey(page, 'F3', 4000);

      // DSPLIB
      await execCommand(page, 'DSPLIB QGPL');
      await snap(page, step++, 'dsplib');

      // PageDown
      await pressKey(page, 'PageDown', 4000);
      await snap(page, step++, 'pagedown');

      // F3 exit
      await pressKey(page, 'F3', 4000);

      // Sign off
      console.log('Phase 5: Signing off...');
      await signOff(page);
      await snap(page, step++, 'signoff');
    } else {
      console.log(`Warning: Not on main menu. Screen content starts with:`);
      console.log(currentText.substring(0, 200));
      await snap(page, step++, 'unexpected-screen');
      await signOff(page);
      await snap(page, step++, 'signoff');
    }

    // Print summary
    console.log('');
    console.log(`=== Done: ${step - 1} snapshots captured ===`);
    console.log(`Screenshots: ${CONFIG.screenshotDir}`);
    console.log(`State dumps: ${CONFIG.stateDir}`);

    // Print screen dump of last captured state
    const finalState = getScreenState();
    if (finalState) {
      console.log('');
      console.log('Last screen dump:');
      console.log(dumpScreenText(finalState));
    }

  } catch (err) {
    console.error('Error during debug harness run:', err);
    try { await snap(page, 99, 'error-state'); } catch { /* ignore */ }
    try { await signOff(page); } catch { /* ignore */ }
  } finally {
    // Always close browser (releases pub400 connection)
    await page.waitForTimeout(1000);
    await context.close();
    await browser.close();
    console.log('Browser closed. Connection released.');
  }
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
