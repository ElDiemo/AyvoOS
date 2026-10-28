import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { expect, test } from '@playwright/test';
const ADMIN_STATE = 'e2e/.auth/admin.json';
const OPERATOR_STATE = 'e2e/.auth/operator.json';

/**
 * Finance → Banka a platby → Pohyby z banky (N3B-1, doc 041; doc 042) in the browser, against the SIMULATED RB Premium API
 * started by the e2e server (synthetic entries living only in the simulation): the connection is
 * labelled as a simulation, the certificate readable with its expiry, a read stores the entries
 * with exact amounts and symbols, a second read adds nothing, filters, phone layout; a user
 * without the permission sees no page. Never a real bank, certificate or account.
 */
const screenshots = resolve(import.meta.dirname, '../../../docs/screenshots/finance');

test.describe('Pohyby z banky', () => {
  test.use({ storageState: ADMIN_STATE });

  test('read from the (simulated) bank, see exact amounts and symbols, read again without duplicates, filter', async ({
    page,
  }) => {
    await page.goto('/finance/bank');
    await expect(page.getByRole('heading', { level: 1, name: 'Pohyby z banky' })).toBeVisible();
    const connection = page.getByTestId('bank-connection');
    await expect(connection).toContainText('Simulovaná banka pro automatické testy');
    await expect(page.getByTestId('bank-certificate')).toContainText('načten, platný do');
    await expect(connection).toContainText('Účet 1234567890 · CZK');

    await page.getByTestId('bank-sync').click();
    await expect(connection).toContainText('Načteno.');
    const list = page.getByTestId('bank-transactions');
    await expect(list).toContainText('15 000,50 CZK');
    await expect(list).toContainText('−1 668,59 CZK');
    await expect(list).toContainText('0012345 / – / –');
    await expect(list).toContainText('Testovací hotel s.r.o.');
    await expect(list).toContainText('19-2000145399/0800');
    // No pairing state per transaction is claimed; the page points to Platby a přiřazení.
    await expect(list).not.toContainText('Nespárováno');
    await expect(page.getByTestId('bank-to-payments')).toContainText('Platby a přiřazení');
    // Nothing secret is ever on the page (no certificate, password or client id).
    await expect(page.locator('body')).not.toContainText(/fake-rb-client|password|heslo:/i);

    const rows = page.getByTestId('bank-transaction');
    const count = await rows.count();
    expect(count).toBeGreaterThanOrEqual(3);
    await page.getByTestId('bank-sync').click();
    await expect(connection).toContainText('nových 0, změněných 0');
    await page.reload();
    await expect(rows).toHaveCount(count);
    await expect(connection).toContainText('Poslední úspěšné načtení');

    // The filters stay closed until used (doc 042, UI-03).
    await expect(page.getByTestId('bank-filters')).toBeHidden();
    await page.getByTestId('bank-filters-box').locator('summary').click();
    await page.getByTestId('bank-filters').getByLabel('Směr').selectOption('DBIT');
    await page.getByTestId('bank-filters').getByRole('button', { name: 'Filtrovat' }).click();
    await expect(page).toHaveURL(/direction=DBIT/);
    await expect(rows).toHaveCount(1);
    await expect(rows.first()).toContainText('Testovací dodavatel a.s.');
    await page.getByRole('link', { name: 'Zrušit filtry' }).click();

    await mkdir(screenshots, { recursive: true });
    for (const width of [1440, 390]) {
      await page.setViewportSize({ width, height: 900 });
      await page.goto('/finance/bank');
      expect(
        await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
      ).toBe(true);
      await page.screenshot({
        path: resolve(screenshots, `finance-bank-${width}.png`),
        fullPage: true,
      });
    }
    await expect(page.getByTestId('bank-transaction-card').first()).toBeVisible();
  });
});

test.describe('without the bank permission', () => {
  test.use({ storageState: OPERATOR_STATE });

  test('the page and its API are refused', async ({ page }) => {
    await page.goto('/finance/bank');
    await expect(page).toHaveURL(/\/forbidden$/);
    expect((await page.request.get('/api/admin/finance/bank/status')).status()).toBe(403);
    expect((await page.request.post('/api/admin/finance/bank/sync', { data: {} })).status()).toBe(
      403,
    );
  });
});
