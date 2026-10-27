import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { expect, test } from '@playwright/test';
const ADMIN_STATE = 'e2e/.auth/admin.json';
const OPERATOR_STATE = 'e2e/.auth/operator.json';

/**
 * Finance → Smlouvy hotelů (doc 040, N3A-1 in the UI): a customer (the billed company), the
 * agreement of a hotel with its rooms and own price, a new version of the terms with a reason, and
 * a default price — all in the browser; refused without the permission. Synthetic data only.
 */
const screenshots = resolve(import.meta.dirname, '../../../docs/screenshots/finance');

test.describe('Smlouvy hotelů', () => {
  test.use({ storageState: ADMIN_STATE });

  test('a customer, a hotel agreement with its own price, a new version and a default price', async ({
    page,
  }) => {
    const request = page.request;
    const me = (await (await request.get('/api/auth/me')).json()) as {
      sites: { id: string; code: string }[];
    };
    const hotel = (await (
      await request.post('/api/admin/hotels', {
        data: {
          requestId: crypto.randomUUID(),
          name: 'Hotel Smlouva (E2E)',
          addressLine1: 'Smluvní 3',
          addressLine2: null,
          postalCode: '779 00',
          city: 'Olomouc',
          countryCode: 'CZ',
          contactName: 'Recepce',
          contactPhone: '+420 500 000 002',
          contactEmail: 'recepce@smlouva.test',
          fulfillmentSiteId: me.sites.find((s) => s.code === 'CZ-PREROV-01')!.id,
        },
      })
    ).json()) as { code: string };

    await page.goto('/finance/billing');
    await expect(page.getByRole('heading', { level: 1, name: 'Smlouvy hotelů' })).toBeVisible();
    await page.getByTestId('customer-new-open').click();
    const customer = page.getByTestId('customer-new');
    await customer.locator('[name=legalName]').fill('Hotelová skupina Morava s.r.o. (E2E)');
    await customer.locator('[name=companyId]').fill('12345678');
    await customer.locator('[name=addressLine1]').fill('Smluvní 3');
    await customer.locator('[name=postalCode]').fill('779 00');
    await customer.locator('[name=city]').fill('Olomouc');
    await customer.locator('[name=billingEmail]').fill('fakturace@morava.test');
    await customer.getByTestId('customer-save').click();
    // Saved: said so, the form stays open and empty for the next one.
    await expect(customer.getByRole('status')).toHaveText('Uloženo.');
    await expect(customer.locator('[name=legalName]')).toHaveValue('');
    await expect(page.getByTestId('billing-customers')).toContainText(
      'Hotelová skupina Morava s.r.o. (E2E)',
    );

    await page.getByTestId('agreement-new-open').click();
    const agreement = page.getByTestId('agreement-new');
    await agreement
      .locator('[name=hotelId]')
      .selectOption({ label: `Hotel Smlouva (E2E) (${hotel.code})` });
    const customerOption = await agreement
      .locator('[name=customerId] option', { hasText: 'Hotelová skupina Morava s.r.o. (E2E)' })
      .first()
      .getAttribute('value');
    await agreement.locator('[name=customerId]').selectOption(customerOption!);
    await agreement.locator('[name=billedRooms]').fill('12');
    await agreement.locator('[name=ownPrice]').fill('350.00');
    await agreement.locator('[name=reason]').fill('Smlouva podepsána (syntetická)');
    await agreement.getByTestId('agreement-save').click();
    const list = page.getByTestId('billing-agreements');
    const row = list.locator('li').filter({ hasText: 'Hotel Smlouva (E2E)' });
    await expect(row).toContainText('12 pokojů · 350,00 CZK (vlastní cena)');
    await expect(row).toContainText('Hotelová skupina Morava s.r.o. (E2E)');

    // A new version of the terms (a reason; the history keeps both).
    await row.getByRole('link').click();
    await expect(page).toHaveURL(/\/finance\/billing\/agreements\/BA-\d{6}$/);
    const version = page.locator('[data-testid^="agreement-version-BA-"]');
    await version.locator('[name=billedRooms]').fill('14');
    await version.locator('[name=reason]').fill('Rozšíření o 2 pokoje (test)');
    await version.getByTestId('agreement-version-save').click();
    const history = page.getByTestId('agreement-history');
    await expect(history.locator('li')).toHaveCount(2);
    await expect(history.locator('li').first()).toContainText('14 pokojů');
    await expect(history).toContainText('Rozšíření o 2 pokoje (test)');

    await page.goto('/finance/billing');
    await page.getByText('Nová cena').click();
    const price = page.getByTestId('price-new');
    await price.locator('[name=price]').fill('299.00');
    await price.locator('[name=reason]').fill('Ceník 2026 (test)');
    await price.getByTestId('price-save').click();
    await expect(page.getByTestId('billing-prices')).toContainText('299,00 CZK');

    await mkdir(screenshots, { recursive: true });
    for (const width of [1440, 390, 320]) {
      await page.setViewportSize({ width, height: 900 });
      await page.goto('/finance/billing');
      expect(
        await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
      ).toBe(true);
      await page.screenshot({
        path: resolve(screenshots, `finance-billing-${width}.png`),
        fullPage: true,
      });
    }
  });
});

test.describe('without the billing permission', () => {
  test.use({ storageState: OPERATOR_STATE });

  test('the page and its API are refused', async ({ page }) => {
    await page.goto('/finance/billing');
    await expect(page).toHaveURL(/\/forbidden$/);
    expect((await page.request.get('/api/admin/finance/billing/customers')).status()).toBe(403);
  });
});
