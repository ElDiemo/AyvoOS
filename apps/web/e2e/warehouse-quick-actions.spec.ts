import { resolve } from 'node:path';
import { expect, test } from '@playwright/test';
import { noOverflow } from './dispatch-setup';

/**
 * Sklad → rychlé akce (UX handoff 2026-11-07): "Přijmout vratku", "Po mytí" and "Přijmout zboží"
 * on top of the warehouse overview — existing pages, each shown only with that page's permission,
 * reachable by keyboard in this order with a visible focus, at 390 px and 1440 px. Read-only.
 */
const SHOTS = resolve(import.meta.dirname, '../../../docs/screenshots/warehouse');
const ADMIN = 'e2e/.auth/admin.json';
const OPERATOR = 'e2e/.auth/operator.json';

test.use({ timezoneId: 'Europe/Prague' });

for (const width of [390, 1440] as const) {
  test(`the administrator sees the three quick actions first, at ${width} px`, async ({
    browser,
  }) => {
    const context = await browser.newContext({ storageState: ADMIN });
    const page = await context.newPage();
    await page.setViewportSize({ width, height: 900 });
    await page.goto('/warehouse');
    const quick = page.getByTestId('quick-actions');
    await expect(quick.getByRole('link')).toHaveText([
      /^Přijmout vratku/,
      /^Po mytí/,
      /^Přijmout zboží/,
    ]);
    await expect(page.getByTestId('quick-returns')).toHaveAttribute('href', '/warehouse/returns');
    await expect(page.getByTestId('quick-after-wash')).toHaveAttribute(
      'href',
      '/warehouse/after-wash',
    );
    await expect(page.getByTestId('quick-goods')).toHaveAttribute(
      'href',
      '/warehouse/receipts/new',
    );
    // On top of the overview: above the stock and "Vyžaduje pozornost".
    const top = async (testId: string) => (await page.getByTestId(testId).boundingBox())!.y;
    expect(await top('quick-actions')).toBeLessThan(await top('overview-stock'));
    expect(await top('quick-actions')).toBeLessThan(await top('attention'));
    // Touch targets of at least 44 px.
    for (const link of await quick.getByRole('link').all()) {
      expect((await link.boundingBox())!.height).toBeGreaterThanOrEqual(44);
    }
    await noOverflow(page);
    await page.screenshot({ path: `${SHOTS}/quick-actions-admin-${width}.png`, fullPage: true });
    await context.close();
  });
}

test('keyboard: the actions follow each other with a visible focus, and Enter opens the page', async ({
  browser,
}) => {
  const context = await browser.newContext({ storageState: ADMIN });
  const page = await context.newPage();
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/warehouse');
  await page.waitForLoadState('networkidle');
  // Reached by Tab right after the page header's action, then one after the other.
  await page.getByTestId('next-action').focus();
  await expect(page.getByTestId('next-action')).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(page.getByTestId('quick-returns')).toBeFocused();
  const ring = (testId: string) =>
    page.getByTestId(testId).evaluate((el) => getComputedStyle(el).boxShadow);
  expect(await ring('quick-returns')).not.toBe('none');
  await page.keyboard.press('Tab');
  await expect(page.getByTestId('quick-after-wash')).toBeFocused();
  expect(await ring('quick-after-wash')).not.toBe('none');
  await page.keyboard.press('Tab');
  await expect(page.getByTestId('quick-goods')).toBeFocused();
  await page.screenshot({ path: `${SHOTS}/quick-actions-focus-1440.png` });
  await page.keyboard.press('Shift+Tab');
  await expect(page.getByTestId('quick-after-wash')).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(/\/warehouse\/after-wash$/);
  await expect(page.getByRole('heading', { name: 'Po mytí', exact: true })).toBeVisible();
  await page.goBack();
  await page.waitForLoadState('networkidle');
  await page.getByTestId('next-action').focus();
  await page.keyboard.press('Tab');
  await expect(page.getByTestId('quick-returns')).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(/\/warehouse\/returns$/);
  await expect(page.getByRole('heading', { name: 'Příjem vratek', exact: true })).toBeVisible();
  await context.close();
});

test('by role: a warehouse supervisor without returns:receive sees only "Přijmout zboží"', async ({
  browser,
}) => {
  const context = await browser.newContext({ storageState: OPERATOR });
  const page = await context.newPage();
  await page.setViewportSize({ width: 390, height: 900 });
  await page.goto('/warehouse');
  const quick = page.getByTestId('quick-actions');
  await expect(quick.getByRole('link')).toHaveText([/^Přijmout zboží/]);
  await expect(page.getByTestId('quick-returns')).toHaveCount(0);
  await expect(page.getByTestId('quick-after-wash')).toHaveCount(0);
  // The pages behind the hidden actions stay closed for this role, as before.
  await page.goto('/warehouse/after-wash');
  await expect(page).toHaveURL(/\/forbidden$/);
  await page.goto('/warehouse');
  await page.getByTestId('quick-goods').click();
  await expect(page).toHaveURL(/\/warehouse\/receipts\/new$/);
  await page.goto('/warehouse');
  await expect(page.getByTestId('quick-goods')).toBeVisible();
  await expect(page.getByTestId('overview-stock')).toBeVisible();
  await noOverflow(page);
  await page.screenshot({ path: `${SHOTS}/quick-actions-operator-390.png`, fullPage: true });
  await context.close();
});
