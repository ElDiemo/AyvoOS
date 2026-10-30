import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
const ADMIN_STATE = 'e2e/.auth/admin.json';

/**
 * Platby (doc 044 U4), synthetic payments: a bounded page, filters and search on the server, by the
 * keyboard too, a detail with everything else, and two different links from the overview.
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

test.describe('Platby', () => {
  test.use({ storageState: ADMIN_STATE });

  test('a bounded list, filters, search, detail; the overview links differ', async ({ page }) => {
    test.setTimeout(120_000);
    const name = `Hledaný ${crypto.randomUUID().slice(0, 6)}`;
    const entry = (over: Record<string, unknown>) => ({
      reference: `UX4-${crypto.randomUUID().slice(0, 8).toUpperCase()}`,
      amount: '10.00',
      currency: 'CZK',
      bookedOn: '2026-05-01',
      variableSymbol: null,
      counterpartyName: null,
      message: null,
      ...over,
    });
    const res = await page.request.post('/api/admin/finance/payments/simulate', {
      data: {
        requestId: crypto.randomUUID(),
        entries: [
          entry({ counterpartyName: name, amount: '777.77' }),
          ...Array.from({ length: 30 }, () => entry({})),
        ],
      },
    });
    expect(res.ok(), await res.text()).toBe(true);

    await page.goto('/finance/payments');
    const rows = page.getByTestId('payments').locator('li[data-testid^="payment-PP-"]');
    await expect(rows).toHaveCount(25);
    await expect(page.getByTestId('payments-found')).toContainText('Zobrazeno 1–25');
    await expect(page.getByTestId('payments')).not.toContainText('UX4-');
    await shots(page, 'ux4-payments');
    await page.getByTestId('payments-next').click();
    await expect(page).toHaveURL(/page=2/);
    await expect(page.getByTestId('payments-found')).toContainText('Zobrazeno 26–');

    // By the keyboard: type and Enter.
    await page.getByTestId('payments-q').fill(name);
    await page.keyboard.press('Enter');
    await expect(page).toHaveURL(/q=/);
    await expect(rows).toHaveCount(1);
    await expect(rows).toContainText(name);
    await shots(page, 'ux4-payments-search');
    await page.getByTestId('payments-filter-ALLOCATED').click();
    await expect(page).toHaveURL(/filter=ALLOCATED/);
    await expect(page.getByTestId('payments-found')).toContainText('Nic nenalezeno');
    await page.goto(`/finance/payments?q=${encodeURIComponent(name)}`);

    await rows.getByRole('link').first().focus();
    await page.keyboard.press('Enter');
    await expect(page).toHaveURL(/\/finance\/payments\/PP-\d+$/);
    await expect(page.getByRole('main')).toContainText('UX4-');
    await expect(page.getByTestId('payment-allocations')).toContainText('Zatím bez přiřazení');
    await shots(page, 'ux4-payment-detail');

    await page.goto('/finance');
    for (const filter of ['REVIEW', 'CHANGED'])
      await expect(page.locator(`a[href="/finance/payments?filter=${filter}"]`)).toHaveCount(1);
  });
});
