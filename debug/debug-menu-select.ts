/**
 * Test: Type '1' in the selection field (1,2) on main menu and press Enter
 */
import { chromium, Page } from 'playwright';
import * as fs from 'fs';
import * as path from 'path';

const CONFIG = {
  baseURL: 'http://localhost:5173/green-screen-react/',
  host: 'pub400.com',
  port: 23,
  username: process.env.CONN_USERNAME || 'TARASOVD',
  password: process.env.CONN_PASSWORD || 'h5198fg091',
  screenshotDir: path.resolve(__dirname, 'screenshots/menu-select'),
};

let latestState: any = null;

function setupWS(page: Page) {
  page.on('websocket', ws => {
    ws.on('framereceived', frame => {
      if (typeof frame.payload !== 'string') return;
      try {
        const msg = JSON.parse(frame.payload);
        if (msg.type === 'screen' && msg.data) latestState = msg.data;
      } catch {}
    });
  });
}

function termBody(page: Page) { return page.locator('.gs-body').last(); }

async function snap(page: Page, label: string) {
  fs.mkdirSync(CONFIG.screenshotDir, { recursive: true });
  try {
    const t = termBody(page);
    if (await t.isVisible()) await t.screenshot({ path: path.join(CONFIG.screenshotDir, `${label}.png`) });
  } catch {}
  const s = latestState;
  const inputFields = s?.fields?.filter((f: any) => f.is_input) ?? [];
  console.log(`[${label}] cursor: (${s?.cursor_row}, ${s?.cursor_col}), fields: ${s?.fields?.length} (${inputFields.length} input)`);
  if (s?.content) {
    const lines = s.content.split('\n');
    // Show first 3 and last 3 lines
    for (let i = 0; i < Math.min(3, lines.length); i++) {
      console.log(`  Row ${String(i+1).padStart(2)}: ${lines[i]}`);
    }
    console.log(`  ...`);
    for (let i = Math.max(0, lines.length - 3); i < lines.length; i++) {
      console.log(`  Row ${String(i+1).padStart(2)}: ${lines[i]}`);
    }
  }
}

async function main() {
  const browser = await chromium.launch({ headless: true });
  const page = await (await browser.newContext({ viewport: { width: 1280, height: 900 } })).newPage();
  setupWS(page);

  try {
    await page.goto(CONFIG.baseURL);
    await page.waitForLoadState('networkidle');

    const form = page.locator('.gs-signin');
    await form.waitFor({ state: 'visible', timeout: 10000 });
    await form.locator('input').first().fill(CONFIG.host);
    await form.locator('input[type="number"]').fill(String(CONFIG.port));
    await form.locator('input[autocomplete="username"]').fill(CONFIG.username);
    await form.locator('input[type="password"]').fill(CONFIG.password);
    await form.locator('button[type="submit"]').click();

    await termBody(page).waitFor({ state: 'visible', timeout: 30000 });
    const start = Date.now();
    while (Date.now() - start < 30000) {
      if (latestState?.content?.trim()) break;
      await new Promise(r => setTimeout(r, 500));
    }
    await page.waitForTimeout(3000);

    // Navigate to main menu
    for (let i = 0; i < 5; i++) {
      if (latestState?.content?.includes('Main Menu') || latestState?.content?.includes('===>')) break;
      await termBody(page).press('Enter');
      await page.waitForTimeout(5000);
    }

    console.log('=== Main Menu ===');
    await snap(page, '01-main-menu');

    // Tab to the selection field (1,2)
    console.log('\n--- Tab to selection field ---');
    await termBody(page).click();
    await termBody(page).press('Tab');
    await page.waitForTimeout(500);
    console.log(`After Tab: cursor at (${latestState?.cursor_row}, ${latestState?.cursor_col})`);

    // Check if cursor is on the (1,2) field
    if (latestState?.cursor_row === 1 && latestState?.cursor_col === 2) {
      console.log('Cursor on selection field (1,2) — typing "1" + Enter');
    } else {
      // Tab again to get there
      await termBody(page).press('Tab');
      await page.waitForTimeout(500);
      console.log(`After 2nd Tab: cursor at (${latestState?.cursor_row}, ${latestState?.cursor_col})`);
    }

    await snap(page, '02-before-type');

    // Type '1' in the selection field
    await termBody(page).pressSequentially('1', { delay: 60 });
    await page.waitForTimeout(300);
    await snap(page, '03-typed-1');

    // Press Enter
    const prevSig = latestState?.screen_signature;
    await termBody(page).press('Enter');
    await page.waitForTimeout(8000);

    // Wait for screen change
    const startWait = Date.now();
    while (Date.now() - startWait < 10000) {
      if (latestState?.screen_signature !== prevSig) break;
      await new Promise(r => setTimeout(r, 500));
    }

    console.log('\n--- After Enter ---');
    await snap(page, '04-after-enter');

    const content = latestState?.content || '';
    if (content.includes('User tasks') || content.includes('User Tasks') || content.includes('MAIN')) {
      console.log('\nResult: Screen changed (check screenshot)');
    }
    if (content.includes('not valid') || content.includes('Type option')) {
      console.log('\nResult: ERROR — "Type option number or command" or similar error');
    }

    // Sign off
    await termBody(page).press('F3');
    await page.waitForTimeout(4000);
    await termBody(page).click();
    await termBody(page).pressSequentially('SIGNOFF', { delay: 60 });
    await termBody(page).press('Enter');
    await page.waitForTimeout(3000);

  } catch (err) {
    console.error('Error:', err);
  } finally {
    await page.waitForTimeout(1000);
    await browser.close();
    console.log('\nDone.');
  }
}

main().catch(err => { console.error('Fatal:', err); process.exit(1); });
