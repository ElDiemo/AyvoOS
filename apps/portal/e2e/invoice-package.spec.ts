import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test, type Page } from '@playwright/test';

const STUB = 'http://127.0.0.1:4301';
const control = (page: Page, body: Record<string, unknown>) =>
  page.request.post(`${STUB}/__control`, { data: body });

const shot = async (page: Page, name: string) => {
  const dir = process.env.PORTAL_SCREENSHOTS;
  if (!dir) return;
  mkdirSync(dir, { recursive: true });
  await page.screenshot({
    path: join(dir, `${name}-${page.viewportSize()!.width}.png`),
    fullPage: true,
  });
};

async function signIn(page: Page) {
  await page.goto('/login');
  await page.locator('[name=email]').fill('recepce@hotel-e2e.test');
  await page.locator('[name=password]').fill('Dlouhe portalove heslo 2026');
  await page.getByRole('button', { name: 'Pokračovat' }).click();
  await page.locator('[name=code]').fill('123456');
  await page.getByRole('button', { name: 'Přihlásit' }).click();
  await expect(page.getByRole('heading', { name: 'Moje hotely' })).toBeVisible();
}

/**
 * "Balíček za období" against the Finance stub (which invoices go into the ZIP, once, is tested
 * against the real Finance in the API suite): the form downloads the ZIP of the chosen months; an
 * invalid, empty or too large period comes back to "Faktury" with its reason; nothing without a
 * session.
 */
test.describe('hotel portal: invoice package for a period', () => {
  test.afterEach(async ({ page }) => {
    await control(page, { packageMode: 'ok' });
  });

  test('the form downloads the ZIP; refused periods come back with their reason', async ({
    page,
  }) => {
    await signIn(page);
    await page.getByRole('link', { name: 'Faktury' }).click();
    const box = page.getByTestId('invoice-package');
    await box.getByLabel('Od měsíce').fill('2026-08');
    await box.getByLabel('Do měsíce').fill('2026-10');
    const download = page.waitForEvent('download');
    await box.getByRole('button', { name: 'Stáhnout balíček (ZIP)' }).click();
    expect((await download).suggestedFilename()).toBe('AYVO-faktury-2026-08-2026-10.zip');

    const direct = await page.request.get('/invoices/package?from=2026-08&to=2026-10');
    expect(direct.status()).toBe(200);
    expect(direct.headers()['content-type']).toBe('application/zip');
    expect(direct.headers()['cache-control']).toBe('private, no-store');
    expect(direct.headers()['content-security-policy']).toContain("default-src 'none'");

    // More than 12 months or reversed: refused here already, never sent to Finance.
    await page.goto('/invoices/package?from=2025-01&to=2026-06');
    await expect(page).toHaveURL(/\/invoices\?balicek=INVALID_PERIOD/);
    await expect(page.getByTestId('invoice-package').getByRole('alert')).toContainText(
      'nejvýše 12 měsíců',
    );
    await control(page, { packageMode: 'empty' });
    await page.goto('/invoices/package?from=2025-01&to=2025-02');
    await expect(page.getByTestId('invoice-package').getByRole('alert')).toContainText(
      'nejsou žádné faktury',
    );
    await expect(page.getByTestId('invoice-package').getByLabel('Od měsíce')).toHaveValue(
      '2025-01',
    );
    await shot(page, 'invoice-package');
    await control(page, { packageMode: 'large' });
    await page.goto('/invoices/package?from=2026-01&to=2026-12');
    await expect(page.getByTestId('invoice-package').getByRole('alert')).toContainText(
      'příliš velký',
    );

    await page.context().clearCookies();
    expect((await page.request.get('/invoices/package?from=2026-08&to=2026-10')).status()).toBe(
      401,
    );
  });
});
