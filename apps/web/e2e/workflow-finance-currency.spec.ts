import { expect, test } from '@playwright/test';

const ADMIN_STATE = 'e2e/.auth/admin.json';

/** INPUT107-R1: a currency other than the usual two, by hand in the browser. Synthetic data only. */
test.describe('Jiná měna', () => {
  test.use({ storageState: ADMIN_STATE });

  test('a contract and a default price in GBP: saved, shown, edited; an invalid code is refused', async ({
    page,
  }) => {
    const request = page.request;
    const run = crypto.randomUUID().slice(0, 6);
    const me = (await (await request.get('/api/auth/me')).json()) as {
      sites: { id: string; code: string }[];
    };
    const hotel = (await (
      await request.post('/api/admin/hotels', {
        data: {
          requestId: crypto.randomUUID(),
          name: `Hotel Libra ${run} (E2E)`,
          addressLine1: 'Měnová 1',
          addressLine2: null,
          postalCode: '779 00',
          city: 'Olomouc',
          countryCode: 'CZ',
          contactName: 'Recepce',
          contactPhone: '+420 500 000 003',
          contactEmail: 'recepce@libra.test',
          fulfillmentSiteId: me.sites.find((s) => s.code === 'CZ-PREROV-01')!.id,
        },
      })
    ).json()) as { code: string };
    const payer = `Libra ${run} s.r.o. (E2E)`;
    const created = await request.post('/api/admin/finance/billing/customers', {
      data: {
        requestId: crypto.randomUUID(),
        customer: {
          legalName: payer,
          companyId: '12345678',
          vatId: null,
          addressLine1: 'Měnová 1',
          addressLine2: null,
          postalCode: '779 00',
          city: 'Olomouc',
          countryCode: 'CZ',
          billingEmail: 'fakturace@libra.test',
          documentLanguage: 'en',
        },
      },
    });
    expect(created.ok(), await created.text()).toBe(true);

    await page.goto('/finance/billing');
    await page.getByTestId('agreement-new-open').click();
    const agreement = page.getByTestId('agreement-new');
    await agreement.locator('[name=hotelId]').selectOption({
      label: `Hotel Libra ${run} (E2E) (${hotel.code})`,
    });
    const option = await agreement
      .locator('[name=customerId] option', { hasText: payer })
      .first()
      .getAttribute('value');
    await agreement.locator('[name=customerId]').selectOption(option!);
    await agreement.locator('[name=billedRooms]').fill('7');
    await agreement.locator('[name=ownPrice]').fill('41,50');
    await agreement.locator('[name=reason]').fill('Smlouva v librách (syntetická)');
    const currency = agreement.locator('[name=currency]');
    // Typed by hand, in lower case, not chosen from a closed list.
    await currency.fill('gb1');
    // Chosen explicitly: a new agreement preselects neither (review SMOKE-2).
    await agreement.locator('[name=billingTiming]').selectOption('ARREARS');
    await agreement.locator('[name=paymentTermsDays]').fill('14');
    await agreement.getByTestId('agreement-save').click();
    expect(await currency.evaluate((i: HTMLInputElement) => i.validity.valid)).toBe(false);
    await currency.fill('gbp');
    await expect(currency).toHaveValue('GBP');
    // Chosen explicitly: a new agreement preselects neither (review SMOKE-2).
    await agreement.locator('[name=billingTiming]').selectOption('ARREARS');
    await agreement.locator('[name=paymentTermsDays]').fill('14');
    await agreement.getByTestId('agreement-save').click();
    const row = page
      .getByTestId('billing-agreements')
      .locator('li')
      .filter({ hasText: `Hotel Libra ${run}` });
    await expect(row).toContainText('7 pokojů · 41,50 GBP (vlastní cena)');

    // The following edit keeps the currency; the history holds both.
    await row.getByRole('link').click();
    await expect(page).toHaveURL(/\/finance\/billing\/agreements\/BA-\d{6}$/);
    const version = page.locator('[data-testid^="agreement-version-BA-"]');
    await expect(version.locator('[name=currency]')).toHaveValue('GBP');
    await version.locator('[name=billedRooms]').fill('9');
    await version.locator('[name=reason]').fill('Rozšíření (syntetické)');
    await version.getByTestId('agreement-version-save').click();
    const history = page.getByTestId('agreement-history');
    await expect(history.locator('li')).toHaveCount(2);
    await expect(history.locator('li').first()).toContainText('9 pokojů');
    await expect(history.locator('li').first()).toContainText('GBP');
    await page.reload();
    await expect(version.locator('[name=currency]')).toHaveValue('GBP');

    // A default price in that currency, then its later version.
    for (const [amount, shown, reason] of [
      ['55,00', '55,00 GBP', 'Ceník GBP (syntetický)'],
      ['1 060,50', '1 060,50 GBP', 'Změna ceníku GBP (syntetická)'],
    ] as const) {
      await page.goto('/finance/settings/prices');
      await page.getByText('Nová cena').click();
      const price = page.getByTestId('price-new');
      await price.locator('[name=currency]').fill('GBP');
      await price.locator('[name=price]').fill(amount);
      await price.locator('[name=reason]').fill(reason);
      await price.getByTestId('price-save').click();
      await expect(page.getByTestId('billing-prices')).toContainText(shown);
    }
  });
});
