import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { expect, test } from '@playwright/test';
const ADMIN_STATE = 'e2e/.auth/admin.json';
const OPERATOR_STATE = 'e2e/.auth/operator.json';

/**
 * Finance → Naše firma a účty → Výchozí sazba DPH pro tuzemské faktury (owner 2026-11-03, doc 040
 * §17) in the browser: nothing prefilled, an unclear rate refused, a rate valid from a day and a
 * later one, the history; refused without finance:issuer_manage. Synthetic values only.
 */
const screenshots = resolve(import.meta.dirname, '../../../docs/screenshots/finance');

test.describe('Výchozí sazba DPH', () => {
  test.use({ storageState: ADMIN_STATE });

  test('no rate prefilled; an unclear one refused; rates from a day with history', async ({
    page,
  }) => {
    const r = page.request;
    const before = (await (await r.get('/api/admin/finance/issuer/vat-rates')).json()) as {
      versions: unknown[];
    };
    await page.goto('/finance/settings/company');
    const block = page.getByTestId('issuer-vat-rate');
    await expect(block.getByRole('heading')).toHaveText('Výchozí sazba DPH pro tuzemské faktury');
    await expect(block).toContainText('jsou bez DPH');
    if (before.versions.length === 0)
      await expect(page.getByTestId('vat-rate-current')).toContainText('není zadaná');
    const form = page.getByTestId('vat-rate-form');
    await expect(form.locator('[name=ratePercent]')).toHaveValue('');
    await expect(form.locator('[name=validFrom]')).toHaveValue('');

    // Unclear or out of range: refused here, nothing stored.
    await form.locator('[name=validFrom]').fill('2026-01-01');
    await form.locator('[name=reason]').fill('Sazba podle správce (test)');
    for (const bad of ['0', '100', '21.5.0', '12,555']) {
      await form.locator('[name=ratePercent]').fill(bad);
      await form.getByTestId('vat-rate-save').click();
      await expect(form.getByRole('alert')).toContainText('Sazbu zadejte v procentech');
    }
    expect(
      ((await (await r.get('/api/admin/finance/issuer/vat-rates')).json()) as { versions: [] })
        .versions,
    ).toHaveLength(before.versions.length);

    // Czech notation is accepted: 21 from 1 January 2026.
    await form.locator('[name=ratePercent]').fill('21');
    await form.getByTestId('vat-rate-save').click();
    await expect(page.getByTestId('vat-rate-current')).toContainText('Dnes platí 21,00 %');
    await expect(page.getByTestId('vat-rate-effective')).toContainText('od 1. 1. 2026: 21,00 %');
    // The form starts empty again.
    await expect(form.locator('[name=ratePercent]')).toHaveValue('');

    // A later rate (synthetic) does not change today's one; the history keeps both.
    await form.locator('[name=validFrom]').fill('2099-01-01');
    await form.locator('[name=ratePercent]').fill('12,5');
    await form.locator('[name=reason]').fill('Budoucí sazba (test)');
    await form.getByTestId('vat-rate-save').click();
    await expect(page.getByTestId('vat-rate-effective')).toContainText('od 1. 1. 2099: 12,50 %');
    await expect(page.getByTestId('vat-rate-current')).toContainText('Dnes platí 21,00 %');
    await page.getByText('Historie změn').click();
    await expect(page.getByTestId('vat-rate-history').locator('li')).toHaveCount(
      before.versions.length + 2,
    );

    await mkdir(screenshots, { recursive: true });
    for (const width of [1440, 390, 320]) {
      await page.setViewportSize({ width, height: 900 });
      await page.goto('/finance/settings/company');
      await expect(page.getByTestId('issuer-vat-rate')).toBeVisible();
      expect(
        await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
      ).toBe(true);
      await page
        .getByTestId('issuer-vat-rate')
        .screenshot({ path: resolve(screenshots, `finance-vat-rate-${width}.png`) });
    }
  });
});

test.describe('Výchozí sazba DPH bez oprávnění', () => {
  test.use({ storageState: OPERATOR_STATE });

  test('the API is refused without finance:issuer_manage', async ({ page }) => {
    expect((await page.request.get('/api/admin/finance/issuer/vat-rates')).status()).toBe(403);
    expect(
      (
        await page.request.post('/api/admin/finance/issuer/vat-rates', {
          data: {
            requestId: crypto.randomUUID(),
            expectedRevision: null,
            validFrom: '2026-01-01',
            ratePercent: '21',
            reason: 'test',
          },
        })
      ).status(),
    ).toBe(403);
  });
});
