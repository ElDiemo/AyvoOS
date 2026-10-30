import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { expect, test } from '@playwright/test';
const ADMIN_STATE = 'e2e/.auth/admin.json';
const OPERATOR_STATE = 'e2e/.auth/operator.json';

/**
 * Finance → Faktury hotelům → Smlouvy a ceny (doc 040, N3A-1 in the UI; doc 042): a customer (the billed company), the
 * agreement of a hotel with its rooms and own price, a new version of the terms with a reason, and
 * a default price — all in the browser; refused without the permission. Synthetic data only.
 */
const screenshots = resolve(import.meta.dirname, '../../../docs/screenshots/finance');

test.describe('Smlouvy a ceny', () => {
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
    await expect(page.getByRole('heading', { level: 1, name: 'Smlouvy a ceny' })).toBeVisible();
    await page.getByTestId('customer-new-open').click();
    const customer = page.getByTestId('customer-new');
    await customer.locator('[name=legalName]').fill('Hotelová skupina Morava s.r.o. (E2E)');
    await customer.locator('[name=companyId]').fill('12345678');
    await customer.locator('[name=addressLine1]').fill('Smluvní 3');
    await customer.locator('[name=postalCode]').fill('779 00');
    await customer.locator('[name=city]').fill('Olomouc');
    await customer.locator('[name=billingEmail]').fill('fakturace@morava.test');
    await customer.locator('[name=documentLanguage]').selectOption('cs');
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
    // The form starts empty again (the hotel cannot be chosen twice by mistake) — or, with no
    // hotel left without an agreement, it is replaced by that notice.
    if ((await agreement.count()) > 0) {
      await expect(agreement.locator('[name=billedRooms]')).toHaveValue('');
      await expect(agreement.locator('[name=hotelId]')).toHaveValue('');
    } else {
      await expect(page.getByTestId('billing-agreements')).toContainText(
        'Všechny hotely už smlouvu mají',
      );
    }

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

  test('review BILL88-R1: a form loaded from an older version never saves over a newer one', async ({
    page,
  }) => {
    const request = page.request;
    const B = '/api/admin/finance/billing';
    const json = async (r: Promise<import('@playwright/test').APIResponse>, status = 201) => {
      const res = await r;
      expect(res.status(), await res.text()).toBe(status);
      return res.json();
    };
    const me = (await (await request.get('/api/auth/me')).json()) as {
      sites: { id: string; code: string }[];
    };
    const hotel = await json(
      request.post('/api/admin/hotels', {
        data: {
          requestId: crypto.randomUUID(),
          name: 'Hotel Souběh (E2E)',
          addressLine1: 'Souběžná 1',
          addressLine2: null,
          postalCode: '779 00',
          city: 'Olomouc',
          countryCode: 'CZ',
          contactName: 'Recepce',
          contactPhone: '+420 500 000 003',
          contactEmail: 'recepce@soubeh.test',
          fulfillmentSiteId: me.sites.find((s) => s.code === 'CZ-PREROV-01')!.id,
        },
      }),
    );
    const customerData = {
      legalName: 'Souběžná s.r.o. (E2E)',
      companyId: '12345678',
      vatId: null,
      addressLine1: 'Souběžná 1',
      addressLine2: null,
      postalCode: '779 00',
      city: 'Olomouc',
      countryCode: 'CZ',
      billingEmail: 'fakturace@soubeh.test',
      documentLanguage: 'cs',
    };
    const customer = await json(
      request.post(`${B}/customers`, {
        data: { requestId: crypto.randomUUID(), customer: customerData },
      }),
    );
    const terms = {
      effectiveFrom: '2026-01',
      customerId: customer.id,
      contractNumber: null,
      billedRooms: 12,
      ownPricePerRoomMonth: '350.00',
      currency: 'CZK',
      paymentTermsDays: 14,
      billingTiming: 'ARREARS',
      validFrom: '2026-01-01',
      validTo: null,
      reason: 'Smlouva (E2E souběh)',
    };
    const hotelId = (
      (await json(request.get(`${B}/hotels`), 200)) as { id: string; code: string }[]
    ).find((h) => h.code === hotel.code)!.id;
    const created = await json(
      request.post(`${B}/agreements`, {
        data: { requestId: crypto.randomUUID(), hotelId, terms },
      }),
    );
    const code = created.code as string;

    // Agreement: the first ADMIN has the form open (12 rooms, 350.00); a second one sets 777.00.
    await page.goto(`/finance/billing/agreements/${code}`);
    const form = page.getByTestId(`agreement-version-${code}`);
    await expect(form.locator('[name=ownPrice]')).toHaveValue('350.00');
    const d = await json(request.get(`${B}/agreements/${code}`), 200);
    await json(
      request.post(`${B}/agreements/${code}/versions`, {
        data: {
          requestId: crypto.randomUUID(),
          expectedRevision: d.versions[0].revision,
          terms: {
            ...terms,
            customerId: customer.id,
            ownPricePerRoomMonth: '777.00',
            reason: 'Souběžná cena',
          },
        },
      }),
    );
    await form.locator('[name=billedRooms]').fill('14');
    await form.locator('[name=reason]').fill('Zastaralá úprava pokojů');
    const conflict = page.waitForResponse(
      (r) => r.url().endsWith(`${code}/versions`) && r.request().method() === 'POST',
    );
    await form.getByTestId('agreement-version-save').click();
    expect((await conflict).status()).toBe(409);
    await expect(page.getByTestId('agreement-history').locator('li').first()).toContainText(
      '777,00',
    );
    // Saving again is impossible until the current version is loaded consciously.
    await expect(form.getByTestId('stale-version')).toBeVisible();
    await expect(form.getByTestId('agreement-version-save')).toBeDisabled();
    await form.getByTestId('stale-version-load').click();
    await expect(form.locator('[name=ownPrice]')).toHaveValue('777.00');
    await expect(form.locator('[name=billedRooms]')).toHaveValue('12');
    await form.locator('[name=billedRooms]').fill('14');
    await form.locator('[name=reason]').fill('Rozšíření o 2 pokoje nad aktuální cenou');
    await form.getByTestId('agreement-version-save').click();
    await expect(form.getByRole('status')).toHaveText('Uloženo.');
    const after = (await json(request.get(`${B}/agreements/${code}`), 200)).versions[0];
    expect([after.ownPricePerRoomMonth, after.billedRooms]).toEqual(['777.00', 14]);
    // Our own save is not mistaken for someone else's.
    await expect(form.getByTestId('stale-version')).toHaveCount(0);

    // Customer: the same, from the customer's page.
    await page.goto(`/finance/billing/customers/${customer.code}`);
    const cform = page.getByTestId(`customer-version-${customer.code}`);
    await expect(cform.locator('[name=city]')).toHaveValue('Olomouc');
    await json(
      request.post(`${B}/customers/${customer.code}/versions`, {
        data: {
          requestId: crypto.randomUUID(),
          expectedVersion: 1,
          customer: { ...customerData, billingEmail: 'nova-fakturace@soubeh.test' },
          reason: 'Souběžná změna e-mailu',
        },
      }),
    );
    await cform.locator('[name=city]').fill('Přerov');
    await cform.locator('[name=reason]').fill('Zastaralá změna města');
    await cform.getByTestId('customer-version-save').click();
    await expect(cform.getByTestId('stale-version')).toBeVisible();
    await expect(cform.getByTestId('customer-version-save')).toBeDisabled();
    await cform.getByTestId('stale-version-load').click();
    await expect(cform.locator('[name=billingEmail]')).toHaveValue('nova-fakturace@soubeh.test');
    const cAfter = await json(request.get(`${B}/customers/${customer.code}`), 200);
    expect([cAfter.current.version, cAfter.current.customer.billingEmail]).toEqual([
      2,
      'nova-fakturace@soubeh.test',
    ]);

    // Default price: a newer price of the same month saved meanwhile is shown before saving.
    const month = '2031-07'; // a month of its own (never touched by other specs)
    await json(
      request.post(`${B}/price-list`, {
        data: {
          requestId: crypto.randomUUID(),
          expectedRevision: null,
          currency: 'CZK',
          pricePerRoomMonth: '300.00',
          effectiveFrom: month,
          reason: 'Ceník (E2E souběh)',
        },
      }),
    );
    await page.goto('/finance/billing');
    await page.getByText('Nová cena').click();
    const price = page.getByTestId('price-new');
    await price.locator('[name=effectiveFrom]').fill(month);
    await price.locator('[name=price]').fill('310.00');
    const prices = await json(request.get(`${B}/price-list`), 200);
    const rev = Math.max(
      ...prices
        .filter((p: { effectiveFrom: string }) => p.effectiveFrom === month)
        .map((p: { revision: number }) => p.revision),
    );
    await json(
      request.post(`${B}/price-list`, {
        data: {
          requestId: crypto.randomUUID(),
          expectedRevision: rev,
          currency: 'CZK',
          pricePerRoomMonth: '333.00',
          effectiveFrom: month,
          reason: 'Souběžná oprava',
        },
      }),
    );
    await price.locator('[name=reason]').fill('Zastaralá oprava');
    await price.getByTestId('price-save').click();
    await expect(price.getByTestId('stale-version')).toContainText('333.00 CZK');
    await expect(price.getByTestId('price-save')).toBeDisabled();
    await price.getByTestId('stale-version-load').click();
    await price.getByTestId('price-save').click();
    await expect(price.getByRole('status')).toHaveText('Uloženo.');
    const finalPrices = await json(request.get(`${B}/price-list`), 200);
    expect(
      finalPrices
        .filter((p: { effectiveFrom: string }) => p.effectiveFrom === month)
        .map((p: { pricePerRoomMonth: string }) => p.pricePerRoomMonth)
        .sort(),
    ).toEqual(['300.00', '310.00', '333.00']);
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
