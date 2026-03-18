import { test, expect, Page } from '@playwright/test';

const SCREENSHOT_DIR = 'e2e/screenshots';
let step = 1;

async function snap(page: Page, label: string) {
  const name = `${String(step++).padStart(2, '0')}-hint-${label}`;
  await page.screenshot({ path: `${SCREENSHOT_DIR}/${name}.png`, fullPage: true });
}

test.describe('AutoSignIn hint UX', () => {
  test('shows "press Enter to continue" hint after autoSignIn, dismisses on keypress', async ({ page }) => {
    step = 1;

    // 1. Load app
    await page.goto('/');
    await page.waitForLoadState('networkidle');

    // 2. Fill the inline sign-in form with credentials
    const form = page.locator('.gs-signin');
    await expect(form).toBeVisible({ timeout: 10_000 });
    await form.locator('input').first().fill('pub400.com');
    await form.locator('input[type="number"]').fill('23');
    await form.locator('input[autocomplete="username"]').fill('TARASOVD');
    await form.locator('input[type="password"]').fill('h5198fg091');
    await snap(page, 'form-filled');

    // 3. Submit — triggers autoSignIn on the proxy
    await form.locator('button[type="submit"]').click();

    // 4. Wait for connection to succeed (ConnectPanel renders "Connected to ...")
    await expect(page.locator('.connect-status.connected')).toBeVisible({ timeout: 30_000 });

    // 5. Wait for terminal screen content — use the connected terminal's screen
    // The mock terminal wrapper has display:none but its .gs-screen-content is still in DOM.
    // The connected terminal's screen-content is the visible one.
    await expect(page.locator('.gs-screen-content:visible').first()).toContainText('PUB400', { timeout: 15_000 });
    await snap(page, 'terminal-loaded');

    // 6. Verify the hint banner is visible
    const hint = page.locator('.gs-signin-hint');
    await expect(hint).toBeVisible({ timeout: 5_000 });
    await expect(hint).toHaveText('Signed in — press Enter to continue');
    await snap(page, 'hint-visible');

    // 7. Click the connected terminal to focus, press Enter to dismiss hint
    await page.locator('.gs-screen-content:visible').first().click();
    await page.waitForTimeout(300);
    await page.keyboard.press('Enter');
    await page.waitForTimeout(1000);

    // 8. Verify the hint is dismissed
    await expect(hint).not.toBeVisible({ timeout: 5_000 });
    await snap(page, 'hint-dismissed');

    // 9. Wait for the main menu to load
    await page.waitForTimeout(8000);
    await snap(page, 'after-enter');

    // 10. Sign off to free the pub400 connection
    const bodyText = await page.locator('.gs-screen-content:visible').first().textContent() || '';
    if (bodyText.includes('Main Menu') || bodyText.includes('===>')) {
      await page.keyboard.type('SIGNOFF', { delay: 60 });
      await page.keyboard.press('Enter');
      await page.waitForTimeout(3000);
      await snap(page, 'signoff');
    } else {
      // May need another Enter for messages screen
      await page.keyboard.press('Enter');
      await page.waitForTimeout(8000);
      const text2 = await page.locator('.gs-screen-content:visible').first().textContent() || '';
      if (text2.includes('Main Menu') || text2.includes('===>')) {
        await page.keyboard.type('SIGNOFF', { delay: 60 });
        await page.keyboard.press('Enter');
        await page.waitForTimeout(3000);
      }
      await snap(page, 'signoff');
    }

    console.log('AutoSignIn hint test complete');
  });
});
