import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { expect, test } from '@playwright/test';
const ADMIN_STATE = 'e2e/.auth/admin.json';
const OPERATOR_STATE = 'e2e/.auth/operator.json';

/**
 * Finance → Naše firma a bankovní účty (N3A-2a, doc 040 §8) in the browser: what blocks a live
 * invoice, the issuer's details with history, an invoice bank account checked against its IBAN,
 * the default account for CZK; refused without the permission. Synthetic company and accounts only.
 */
const screenshots = resolve(import.meta.dirname, '../../../docs/screenshots/finance');

test.describe('Naše firma a bankovní účty', () => {
  test.use({ storageState: ADMIN_STATE });

  test('fill the issuer, add a checked account, choose the CZK default; readiness follows', async ({
    page,
  }) => {
    await page.goto('/finance/settings/company');
    await expect(
      page.getByRole('heading', { level: 1, name: 'Naše firma a bankovní účty' }),
    ).toBeVisible();
    const readiness = page.getByTestId('issuer-readiness');
    await expect(readiness).toContainText('chybí údaje vystavitele');

    const form = page.getByTestId('issuer-form');
    await form.locator('[name=legalName]').fill('Testovací vystavitel s.r.o. (syntetický)');
    await form.locator('[name=addressLine1]').fill('Testovací 1');
    await form.locator('[name=postalCode]').fill('110 00');
    await form.locator('[name=city]').fill('Praha');
    await form.locator('[name=companyId]').fill('12345678');
    await form.locator('[name=vatStatus]').selectOption('VAT_PAYER');
    await form.locator('[name=vatId]').fill('CZ12345678');
    await form.locator('[name=email]').fill('fakturace@vystavitel.test');
    await form.locator('[name=reason]').fill('První vyplnění (test)');
    await form.getByRole('button', { name: 'Uložit novou verzi' }).click();
    await expect(readiness).not.toContainText('chybí údaje vystavitele');
    await expect(readiness).toContainText('není zvolen výchozí účet');
    await expect(page.getByTestId('issuer-history')).toContainText('verze 1');

    await page.getByText('Přidat účet').click();
    const account = page.getByTestId('account-form-new');
    await account.locator('[name=label]').fill('Hlavní účet CZK (test)');
    await account.locator('[name=accountPrefix]').fill('19');
    await account.locator('[name=accountNumber]').fill('2000145399');
    await account.locator('[name=bankCode]').fill('0800');
    // A wrong IBAN is refused with the reason, nothing stored.
    await account.locator('[name=iban]').fill('CZ65 0800 0000 1920 0014 5398');
    await account.locator('[name=reason]').fill('Zřízení (test)');
    await account.getByRole('button', { name: 'Uložit' }).click();
    await expect(account.getByRole('alert')).toBeVisible();
    await account.locator('[name=iban]').fill('CZ65 0800 0000 1920 0014 5399');
    await account.getByRole('button', { name: 'Uložit' }).click();
    const accounts = page.getByTestId('issuer-accounts');
    await expect(accounts).toContainText('CZ6508000000192000145399');
    await expect(accounts).toContainText('19-2000145399/0800');

    const choose = page.getByTestId('default-form-CZK');
    await choose.locator('[name=reason]').fill('Hlavní účet (test)');
    await choose.getByRole('button', { name: 'Zvolit výchozí' }).click();
    await expect(readiness).toContainText('CZK: z tohoto nastavení nic nechybí.');
    await expect(page.getByTestId('issuer-defaults')).toContainText('CZK: IB-');

    await mkdir(screenshots, { recursive: true });
    for (const width of [1440, 390]) {
      await page.setViewportSize({ width, height: 900 });
      await page.goto('/finance/settings/company');
      expect(
        await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
      ).toBe(true);
      await page.screenshot({
        path: resolve(screenshots, `finance-company-${width}.png`),
        fullPage: true,
      });
    }
  });
});

test.describe('without the issuer permission', () => {
  test.use({ storageState: OPERATOR_STATE });

  test('the page and its API are refused', async ({ page }) => {
    await page.goto('/finance/settings/company');
    await expect(page).toHaveURL(/\/forbidden$/);
    expect((await page.request.get('/api/admin/finance/issuer')).status()).toBe(403);
  });
});
