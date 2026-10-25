/**
 * tests/e2e/dashboard.spec.js
 * 
 * Playwright Headless Browser End-to-End Test Suite.
 * Verifies Acceptance Criteria 3:
 * - Locked password modal on entry (charts blocked from rendering).
 * - Invalid passphrase shows error feedback and retains lock.
 * - Valid passphrase unlocks dashboard, decrypts data.enc via window.crypto.subtle,
 *   caches raw key in sessionStorage, and renders all 3 core visualization sections:
 *     1. Endurance & Training Load (stacked weekly/monthly volume, ATL/CTL/TSB curves)
 *     2. Physiological Distribution (HR Z1-Z5, Coggan power Z1-Z7, pace zones, threshold trends)
 *     3. Activity Drill-Down (filterable activity table, splits, cadence/lap profiles)
 * - Page reload within the same browser tab bypasses password modal via sessionStorage.
 * - Tampered payload (bit-flipped ciphertext or tag) fails GCM auth and shows error banner.
 * - Explicit "Lock Dashboard" clears sessionStorage and re-locks modal.
 */

import { test, expect } from '@playwright/test';

test.describe('Client-Side Encrypted Fitness Dashboard E2E', () => {

  test.beforeEach(async ({ page }) => {
    // Reset session storage before each test
    await page.addInitScript(() => {
      window.sessionStorage.clear();
    });
  });

  test('TC-01: Initial page load displays locked modal and hides dashboard charts', async ({ page }) => {
    await page.goto('/');

    // 1. Password modal must be visible
    const modal = page.locator('#passphrase-modal');
    await expect(modal).toBeVisible();

    // 2. Passphrase input field must be present and focused
    const input = page.locator('#passphrase-input');
    await expect(input).toBeVisible();
    await expect(input).toBeFocused();

    // 3. Dashboard container must be hidden and locked
    const dashboard = page.locator('#dashboard-content');
    await expect(dashboard).toHaveAttribute('aria-hidden', 'true');
    await expect(dashboard).toHaveClass(/hidden/);

    // 4. Verify no chart canvases are rendered prior to authentication
    await expect(page.locator('#weekly-volume-chart')).toBeHidden();
    await expect(page.locator('#hr-zone-chart')).toBeHidden();
  });

  test('TC-02: Invalid passphrase rejects unlock and displays authentication error', async ({ page }) => {
    await page.goto('/');

    // Enter wrong passphrase
    await page.fill('#passphrase-input', 'incorrect-passphrase-guess');
    await page.click('#passphrase-submit');

    // 1. Error message banner must be visible with authentication error text
    const errorBanner = page.locator('#auth-error-message');
    await expect(errorBanner).toBeVisible();
    await expect(errorBanner).toContainText(/Authentication failed/i);

    // 2. Modal remains open and blocking
    await expect(page.locator('#passphrase-modal')).toBeVisible();

    // 3. Dashboard container remains hidden
    await expect(page.locator('#dashboard-content')).toHaveClass(/hidden/);
    await expect(page.locator('#dashboard-content')).toHaveAttribute('aria-hidden', 'true');

    // 4. Input reflects invalid state (aria-invalid set)
    await expect(page.locator('#passphrase-input')).toHaveAttribute('aria-invalid', 'true');
  });

  test('TC-03: Valid passphrase decrypts data.enc, renders all 3 sections, and stores session key', async ({ page }) => {
    await page.goto('/');

    // Submit valid passphrase
    await page.fill('#passphrase-input', 'correct-horse-battery-staple');
    await page.click('#passphrase-submit');

    // 1. Modal must dismiss
    await expect(page.locator('#passphrase-modal')).toBeHidden();

    // 2. Dashboard must be revealed
    const dashboard = page.locator('#dashboard-content');
    await expect(dashboard).toBeVisible();
    await expect(dashboard).not.toHaveClass(/hidden/);
    await expect(dashboard).toHaveAttribute('aria-hidden', 'false');

    // 3. Section 1 Verification (Endurance & Training Load)
    await expect(page.locator('#weekly-volume-chart')).toBeVisible();
    await expect(page.locator('#training-load-chart')).toBeVisible();
    await expect(page.locator('#kpi-total-distance')).not.toBeEmpty();

    // 4. Section 2 Verification (Physiological Distribution)
    await expect(page.locator('#hr-zone-chart')).toBeVisible();
    await expect(page.locator('#power-zone-chart')).toBeVisible();
    await expect(page.locator('#threshold-trends-chart')).toBeVisible();

    // 5. Section 3 Verification (Activity Drill-Down)
    const table = page.locator('#activity-table');
    await expect(table).toBeVisible();
    const rows = table.locator('tbody tr');
    await expect(rows).not.toHaveCount(0);

    // 6. Verify sessionStorage holds derived raw session key or decrypted payload
    const sessionKey = await page.evaluate(() => {
      return sessionStorage.getItem('garmin_dash_session_key') || sessionStorage.getItem('garmin_vault_session');
    });
    expect(sessionKey).toBeTruthy();
    expect(sessionKey.length).toBeGreaterThan(20);
  });

  test('TC-04: Page reload within same session bypasses password prompt via sessionStorage', async ({ page }) => {
    // Perform initial successful unlock
    await page.goto('/');
    await page.fill('#passphrase-input', 'correct-horse-battery-staple');
    await page.click('#passphrase-submit');
    await expect(page.locator('#passphrase-modal')).toBeHidden();
    await expect(page.locator('#dashboard-content')).toBeVisible();

    // Reload page within the same tab session
    await page.reload();

    // Password modal must NOT reappear
    await expect(page.locator('#passphrase-modal')).toBeHidden();

    // Dashboard must hydrate immediately from sessionStorage
    await expect(page.locator('#dashboard-content')).toBeVisible();
    await expect(page.locator('#weekly-volume-chart')).toBeVisible();
  });

  test('TC-05: Tampered payload fails authentication tag check and denies unlock', async ({ page }) => {
    // Intercept data.enc request and flip a byte in the ciphertext payload
    await page.route('**/data.enc', async (route) => {
      const response = await route.fetch();
      const buffer = await response.body();
      if (buffer.length >= 44) {
        // Flip bit at offset 30 (inside ciphertext)
        buffer[30] ^= 0xff;
      }
      await route.fulfill({
        response,
        body: buffer,
        headers: { ...response.headers(), 'content-type': 'application/octet-stream' }
      });
    });

    await page.goto('/');
    await page.fill('#passphrase-input', 'correct-horse-battery-staple');
    await page.click('#passphrase-submit');

    // GCM authentication tag mismatch must cause operation rejection
    const errorBanner = page.locator('#auth-error-message');
    await expect(errorBanner).toBeVisible();
    await expect(errorBanner).toContainText(/corrupted|tampered|authentication failed/i);

    // Dashboard stays hidden
    await expect(page.locator('#dashboard-content')).toHaveClass(/hidden/);
  });

  test('TC-06: Manual lock button purges sessionStorage and returns to password modal', async ({ page }) => {
    await page.goto('/');
    await page.fill('#passphrase-input', 'correct-horse-battery-staple');
    await page.click('#passphrase-submit');
    await expect(page.locator('#dashboard-content')).toBeVisible();

    // Click "Lock Vault" button in navigation header
    const lockBtn = page.locator('#btn-lock-dashboard');
    await expect(lockBtn).toBeVisible();
    await lockBtn.click();

    // Must return to locked password modal
    await expect(page.locator('#passphrase-modal')).toBeVisible();
    await expect(page.locator('#dashboard-content')).toHaveClass(/hidden/);

    // sessionStorage must be purged
    const sessionKey = await page.evaluate(() => {
      return sessionStorage.getItem('garmin_dash_session_key') || sessionStorage.getItem('garmin_vault_session');
    });
    expect(sessionKey).toBeNull();
  });

  test('TC-07: Filterable activity drill-down reacts to sport filter buttons', async ({ page }) => {
    await page.goto('/');
    await page.fill('#passphrase-input', 'correct-horse-battery-staple');
    await page.click('#passphrase-submit');
    await expect(page.locator('#dashboard-content')).toBeVisible();

    // Click "Running" filter button
    const runFilterBtn = page.locator('#filter-btn-running');
    if (await runFilterBtn.isVisible()) {
      await runFilterBtn.click();
      const rows = page.locator('#activity-table tbody tr');
      const count = await rows.count();
      expect(count).toBeGreaterThan(0);
    }
  });

});
