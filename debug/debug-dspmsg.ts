/**
 * Debug: Capture DSPMSG screen state and Tab behavior
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
  screenshotDir: path.resolve(__dirname, 'screenshots/dspmsg'),
  stateDir: path.resolve(__dirname, 'state-dumps/dspmsg'),
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
    color?: string;
  }>;
  screen_signature: string;
}

let latestState: ScreenState | null = null;
let step = 0;

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
  step++;
  const pad = String(step).padStart(2, '0');
  fs.mkdirSync(CONFIG.screenshotDir, { recursive: true });
  fs.mkdirSync(CONFIG.stateDir, { recursive: true });
  try { const t = termBody(page); if (await t.isVisible()) await t.screenshot({ path: path.join(CONFIG.screenshotDir, `${pad}-${label}.png`) }); } catch {}
  const s = latestState;
  fs.writeFileSync(path.join(CONFIG.stateDir, `${pad}-${label}.json`), JSON.stringify(s, null, 2));
  console.log(`[${pad}] ${label} — cursor: (${s?.cursor_row}, ${s?.cursor_col}), fields: ${s?.fields?.length} (${s?.fields?.filter(f=>f.is_input).length} input)`);
  return s;
}

async function main() {
  const browser = await chromium.launch({ headless: true });
  const page = await (await browser.newContext({ viewport: { width: 1280, height: 900 } })).newPage();
  setupWS(page);

  try {
    await page.goto(CONFIG.baseURL);
    await page.waitForLoadState('networkidle');

    // Connect with credentials for auto-sign-in
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
    await snap(page, 'main-menu');

    // Run DSPMSG
    await termBody(page).click();
    await termBody(page).pressSequentially('DSPMSG', { delay: 60 });
    await termBody(page).press('Enter');
    await page.waitForTimeout(6000);
    const dspmsgState = await snap(page, 'dspmsg');

    if (dspmsgState) {
      console.log('\n=== DSPMSG Field Analysis ===');
      const lines = dspmsgState.content.split('\n');
      for (const f of dspmsgState.fields) {
        const lineText = lines[f.row] || '';
        const fieldText = lineText.substring(f.col, f.col + Math.min(f.length, 40));
        console.log(`  (${String(f.row).padStart(2)},${String(f.col).padStart(2)}) len=${String(f.length).padStart(3)} ${f.is_input ? 'INPUT' : 'PROT '} color=${(f.color || 'green').padEnd(10)} ul=${f.is_underscored||false} hi=${f.is_highlighted||false} text="${fieldText.trim()}"`);
      }

      const inputFields = dspmsgState.fields.filter(f => f.is_input);
      console.log(`\nInput fields (${inputFields.length}):`);
      for (const f of inputFields) {
        const lineText = lines[f.row] || '';
        const fieldText = lineText.substring(f.col, f.col + Math.min(f.length, 40));
        console.log(`  (${f.row},${f.col}) len=${f.length} ul=${f.is_underscored||false} text="${fieldText.trim()}"`);
      }

      console.log(`\nCursor: (${dspmsgState.cursor_row}, ${dspmsgState.cursor_col})`);
    }

    // Test Tab cycling
    console.log('\n=== Tab Cycling Test ===');
    await termBody(page).click();
    for (let i = 0; i < 6; i++) {
      await termBody(page).press('Tab');
      await page.waitForTimeout(300);
      const s = latestState;
      console.log(`  Tab ${i+1}: cursor → (${s?.cursor_row}, ${s?.cursor_col})`);
    }
    await snap(page, 'after-tabs');

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
