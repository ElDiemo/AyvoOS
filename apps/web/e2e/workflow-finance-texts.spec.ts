import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
const ADMIN_STATE = 'e2e/.auth/admin.json';

/**
 * What the pages say about what really happens (doc 044 U1): the hotel form names Finance, the
 * issuer's readiness holds for TEST invoices too (the API refuses them with ISSUER_NOT_READY), and
 * the export for the accountant holds received documents only.
 */
const screenshots = resolve(import.meta.dirname, '../../../docs/screenshots/finance');

async function shots(page: Page, name: string) {
  await mkdir(screenshots, { recursive: true });
  for (const [width, height] of [
    [1440, 900],
    [390, 844],
    [320, 700],
  ] as const) {
    await page.setViewportSize({ width, height });
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow, `${name} at ${width}`).toBeLessThanOrEqual(0);
    await page.screenshot({ path: resolve(screenshots, `${name}-${width}.png`), fullPage: true });
  }
  await page.setViewportSize({ width: 1440, height: 900 });
}

test.describe('Pravdivé texty', () => {
  test.use({ storageState: ADMIN_STATE });

  test('new hotel, readiness and export say what the system does', async ({ page }) => {
    await page.goto('/hotels/new');
    await expect(page.getByRole('main')).toContainText('smlouvu a fakturaci k němu vede Finance');
    await expect(page.getByRole('main')).not.toContainText('Smlouvy, fakturace ani');
    await shots(page, 'ux1-hotel-new');

    await page.goto('/finance/settings/company');
    const readiness = page.getByTestId('issuer-readiness');
    await expect(readiness).toContainText(
      'Bez těchto údajů nevznikne žádná faktura, ani testovací',
    );
    await expect(readiness).not.toContainText('Blokuje jen ostré');
    await shots(page, 'ux1-issuer-readiness');

    await page.goto('/finance/exports');
    await expect(page.getByRole('main')).toContainText('přijatých dokladů');
    await expect(page.getByRole('main')).toContainText('Vydané faktury v něm nejsou');
    await shots(page, 'ux1-exports');
  });
});
