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

/**
 * Testovací faktury (N3A-2b, doc 040 §9) right after the issuer and its CZK default exist above:
 * one customer with two hotels (agreements set through the billing API), a summary TEST invoice
 * chosen in the browser, its detail and stored PDF, then a cancellation with a reason.
 */
test.describe('Testovací faktury', () => {
  test.use({ storageState: ADMIN_STATE });

  test('a summary TEST invoice of one customer: chosen, issued with its PDF, then cancelled', async ({
    page,
  }) => {
    const request = page.request;
    const json = async <T>(r: Awaited<ReturnType<typeof request.get>>) => {
      expect(r.ok(), await r.text()).toBe(true);
      return (await r.json()) as T;
    };
    const me = await json<{ sites: { id: string; code: string }[] }>(
      await request.get('/api/auth/me'),
    );
    const siteId = me.sites.find((x) => x.code === 'CZ-PREROV-01')!.id;
    const customer = await json<{ id: string; code: string }>(
      await request.post('/api/admin/finance/billing/customers', {
        data: {
          requestId: crypto.randomUUID(),
          customer: {
            legalName: 'Testovací hotely s.r.o. (E2E)',
            companyId: '87654321',
            vatId: null,
            addressLine1: 'Hotelová 7',
            addressLine2: null,
            postalCode: '602 00',
            city: 'Brno',
            countryCode: 'CZ',
            billingEmail: 'fakturace@hotely.test',
          },
        },
      }),
    );
    const agreements: string[] = [];
    for (const [name, rooms, price] of [
      ['Hotel Faktura Sever (E2E)', 10, '300.00'],
      ['Hotel Faktura Jih (E2E)', 5, '1234.56'],
    ] as const) {
      const hotel = await json<{ code: string }>(
        await request.post('/api/admin/hotels', {
          data: {
            requestId: crypto.randomUUID(),
            name,
            addressLine1: 'Hotelová 7',
            addressLine2: null,
            postalCode: '602 00',
            city: 'Brno',
            countryCode: 'CZ',
            contactName: 'Recepce',
            contactPhone: '+420 500 000 000',
            contactEmail: 'recepce@hotely.test',
            fulfillmentSiteId: siteId,
          },
        }),
      );
      const hotels = await json<{ id: string; code: string }[]>(
        await request.get('/api/admin/finance/billing/hotels'),
      );
      const created = await json<{ code: string }>(
        await request.post('/api/admin/finance/billing/agreements', {
          data: {
            requestId: crypto.randomUUID(),
            hotelId: hotels.find((h) => h.code === hotel.code)!.id,
            terms: {
              effectiveFrom: '2026-01',
              customerId: customer.id,
              contractNumber: null,
              billedRooms: rooms,
              ownPricePerRoomMonth: price,
              currency: 'CZK',
              paymentTermsDays: 14,
              billingTiming: 'ARREARS',
              validFrom: '2026-01-01',
              validTo: null,
              reason: 'Smlouva (syntetická)',
            },
          },
        }),
      );
      agreements.push(created.code);
    }

    await page.goto('/finance/invoices');
    await expect(page.getByRole('heading', { level: 1, name: 'Faktury' })).toBeVisible();
    await page.getByTestId('invoice-new').click();
    const form = page.getByTestId('test-invoice-form');
    await form.getByTestId('invoice-month').fill('2026-09');
    await form.getByRole('button', { name: 'Načíst smlouvy' }).click();
    for (const code of agreements) await form.getByTestId(`invoice-agreement-${code}`).check();
    await expect(form.getByTestId('invoice-selection')).toHaveText(
      'Vybráno 2 – celkem 9 172,80 CZK',
    );
    await mkdir(screenshots, { recursive: true });
    for (const width of [1440, 390, 320]) {
      await page.setViewportSize({ width, height: 900 });
      expect(
        await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
      ).toBe(true);
      await page.screenshot({
        path: resolve(screenshots, `finance-invoice-new-${width}.png`),
        fullPage: true,
      });
    }
    await page.setViewportSize({ width: 1280, height: 900 });
    await form.getByTestId('invoice-issue').click();
    await expect(page).toHaveURL(/\/finance\/invoices\/T\d{4}-\d{5}$/);
    const detail = page.getByTestId('invoice-detail');
    await expect(detail.getByTestId('invoice-total')).toHaveText('9 172,80 CZK');
    await expect(detail.getByTestId('invoice-lines')).toContainText('Hotel Faktura Sever (E2E)');
    await expect(detail.getByTestId('invoice-lines')).toContainText('Hotel Faktura Jih (E2E)');
    const number = page.url().split('/').at(-1)!;
    const pdf = await request.get(`/api/admin/finance/invoices/${number}/pdf`);
    expect(pdf.headers()['content-type']).toContain('application/pdf');
    expect((await pdf.body()).subarray(0, 5).toString()).toBe('%PDF-');
    for (const width of [1440, 390, 320]) {
      await page.setViewportSize({ width, height: 900 });
      expect(
        await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
      ).toBe(true);
      await page.screenshot({
        path: resolve(screenshots, `finance-invoice-detail-${width}.png`),
        fullPage: true,
      });
    }
    await page.setViewportSize({ width: 1280, height: 900 });
    await detail.getByTestId('cancel-invoice-reason').fill('Ukázka zrušení (test)');
    await detail.getByTestId('cancel-invoice-submit').click();
    await expect(detail).toContainText('Zrušena: Ukázka zrušení (test)');
    await page.goto('/finance/invoices');
    await expect(page.getByTestId('invoices')).toContainText(number);
    await expect(page.getByTestId('invoices')).toContainText('Zrušená');
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
