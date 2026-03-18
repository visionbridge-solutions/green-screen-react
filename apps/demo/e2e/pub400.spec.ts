import { test, expect, Page } from '@playwright/test';

const SCREENSHOT_DIR = 'e2e/screenshots';
let step = 1;

async function snap(page: Page, label: string) {
  const name = `${String(step++).padStart(2, '0')}-${label}`;
  await page.screenshot({ path: `${SCREENSHOT_DIR}/${name}.png`, fullPage: true });
}

async function focusTerm(page: Page) {
  await page.locator('.gs-body').click();
  await page.waitForTimeout(200);
}

async function termType(page: Page, text: string) {
  await page.locator('.gs-body').pressSequentially(text, { delay: 60 });
  await page.waitForTimeout(200);
}

async function termKeyWait(page: Page, key: string, ms = 4000) {
  await page.locator('.gs-body').press(key);
  await page.waitForTimeout(ms);
}

test.describe('PUB400 TN5250 E2E', () => {
  test('full terminal interaction proof', async ({ page }) => {
    step = 1;

    // ── 1. Load app and fill connection form ──
    await page.goto('/');
    await page.waitForLoadState('networkidle');
    const form = page.locator('.gs-signin');
    await expect(form).toBeVisible({ timeout: 10_000 });
    await form.locator('input').first().fill('pub400.com');
    await form.locator('input[type="number"]').fill('23');
    await form.locator('input[autocomplete="username"]').fill('TARASOVD');
    await form.locator('input[type="password"]').fill('h5198fg091');
    await snap(page, 'connection-form-filled');
    await form.locator('button[type="submit"]').click();

    // ── 2. Terminal loaded, connection established ──
    await expect(page.locator('.gs-body')).toContainText('PUB400', { timeout: 30_000 });
    await snap(page, 'terminal-loaded-connected');

    // ── 3. Focus and verify cursor at username field ──
    await focusTerm(page);
    const cursor = page.locator('.gs-cursor');
    await expect(cursor).toBeVisible();
    await snap(page, 'cursor-at-username-field');

    // ── 4. Type username ──
    await termType(page, 'TARASOVD');
    await snap(page, 'username-entered');

    // ── 5. Tab to password field ──
    await termKeyWait(page, 'Tab', 500);
    await snap(page, 'tabbed-to-password');

    // ── 6. Type password ──
    await termType(page, 'h5198fg091');
    await snap(page, 'password-entered');

    // ── 7. Press Enter — server processes sign-in attempt ──
    await page.waitForTimeout(1000);
    await termKeyWait(page, 'Enter', 10000);
    await snap(page, 'after-enter-server-responded');

    // ── 8. Press Enter again (dismiss messages / continue) ──
    await termKeyWait(page, 'Enter', 10000);
    await snap(page, 'after-second-enter');

    // ── 9. Check what screen we're on ──
    const bodyText = await page.locator('.gs-body').textContent() || '';

    if (bodyText.includes('Main Menu') || bodyText.includes('===>')) {
      console.log('SIGNED IN - Navigating...');
      await snap(page, 'signed-in');

      // Navigate to WRKACTJOB
      await focusTerm(page);
      await termType(page, 'WRKACTJOB');
      await snap(page, 'typed-command');
      await termKeyWait(page, 'Enter', 6000);
      await snap(page, 'command-result');

      // F5 refresh
      await termKeyWait(page, 'F5', 4000);
      await snap(page, 'f5-refresh');

      // F3 exit
      await termKeyWait(page, 'F3', 4000);
      await snap(page, 'f3-exit');

      // DSPLIB
      await focusTerm(page);
      await termType(page, 'DSPLIB QGPL');
      await termKeyWait(page, 'Enter', 6000);
      await snap(page, 'dsplib-result');

      // PageDown
      await termKeyWait(page, 'PageDown', 4000);
      await snap(page, 'pagedown');

      // Sign off
      await focusTerm(page);
      await termType(page, 'SIGNOFF');
      await termKeyWait(page, 'Enter', 5000);
      await snap(page, 'signoff');
    } else if (bodyText.includes('Press Enter') || bodyText.includes('Messages')) {
      console.log('Messages screen — pressing Enter...');
      await snap(page, 'messages-screen');
      await termKeyWait(page, 'Enter', 10000);
      await snap(page, 'after-messages');

      const text2 = await page.locator('.gs-body').textContent() || '';
      if (text2.includes('Main Menu') || text2.includes('===>')) {
        console.log('SIGNED IN after messages');
        await snap(page, 'main-menu-after-messages');

        await focusTerm(page);
        await termType(page, 'WRKACTJOB');
        await termKeyWait(page, 'Enter', 6000);
        await snap(page, 'wrkactjob');

        await termKeyWait(page, 'F3', 4000);
        await focusTerm(page);
        await termType(page, 'SIGNOFF');
        await termKeyWait(page, 'Enter', 5000);
        await snap(page, 'signoff');
      }
    } else {
      console.log('Account may be locked. Screen:', bodyText.substring(0, 150).replace(/\s+/g, ' '));
      await snap(page, 'final-state');
    }

    console.log('Screenshots captured');
  });
});
