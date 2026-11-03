import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
const ADMIN_STATE = 'e2e/.auth/admin.json';
const INITIAL_SITE_ID = '01990000-0000-7000-8000-000000000001';

/**
 * Fakturační podmínky on a hotel's card (owner 2026-11-03): the record is the hotel's billing
 * terms, not a legal contract. "Upravit fakturační podmínky" only with finance:billing_manage, opening
 * the existing new-version form with the way back to the card; a price from the default price list
 * links to it; prices are labelled without VAT. Desktop and phone. Synthetic data only; standalone.
 */
const screenshots = resolve(import.meta.dirname, '../../../docs/screenshots/finance');

type Res = Awaited<ReturnType<APIRequestContext['get']>>;
async function json<T>(res: Res): Promise<T> {
  expect(res.ok(), `${res.url()} -> ${res.status()} ${await res.text()}`).toBe(true);
  return (await res.json()) as T;
}
async function shot(page: Page, name: string, widths: number[] = [1440, 390]) {
  await mkdir(screenshots, { recursive: true });
  for (const width of widths) {
    await page.setViewportSize({ width, height: width < 600 ? 844 : 900 });
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
      ),
      `${name} at ${width}`,
    ).toBeLessThanOrEqual(0);
    await page.screenshot({ path: resolve(screenshots, `${name}-${width}.png`), fullPage: true });
  }
  await page.setViewportSize({ width: 1440, height: 900 });
}

test.describe.serial('Fakturační podmínky na kartě hotelu', () => {
  test.use({ storageState: ADMIN_STATE });
  const run = crypto.randomUUID().slice(0, 6).toUpperCase();
  // A currency of its own: the default price below never meets another spec's price list.
  const currency = 'CHF';
  let own = { code: '', agreement: '' };
  let fromList = { code: '', agreement: '' };

  test('own price vs the default price list; edit from the card and back', async ({ page }) => {
    test.setTimeout(120_000);
    const r = page.request;
    const customer = await json<{ id: string }>(
      await r.post('/api/admin/finance/billing/customers', {
        data: {
          requestId: crypto.randomUUID(),
          customer: {
            legalName: `Podmínky ${run} s.r.o. (E2E)`,
            companyId: '55667799',
            vatId: null,
            addressLine1: 'Podmínková 1',
            addressLine2: null,
            postalCode: '602 00',
            city: 'Brno',
            countryCode: 'CZ',
            billingEmail: 'fakturace@podminky.test',
            documentLanguage: 'cs',
          },
        },
      }),
    );
    // A default price of this currency (the newest revision of the month seen first).
    const prices = await json<{ revision: number; currency: string; effectiveFrom: string }[]>(
      await r.get('/api/admin/finance/billing/price-list'),
    );
    const seen = prices
      .filter((p) => p.currency === currency && p.effectiveFrom === '2026-01')
      .sort((a, b) => b.revision - a.revision)[0];
    await json(
      await r.post('/api/admin/finance/billing/price-list', {
        data: {
          requestId: crypto.randomUUID(),
          expectedRevision: seen?.revision ?? null,
          currency,
          pricePerRoomMonth: '35.00',
          effectiveFrom: '2026-01',
          reason: 'Výchozí cena (syntetická)',
        },
      }),
    );
    const hotel = async (name: string, ownPrice: string | null, cur: string) => {
      const h = await json<{ code: string }>(
        await r.post('/api/admin/hotels', {
          data: {
            requestId: crypto.randomUUID(),
            name,
            addressLine1: 'Podmínková 1',
            addressLine2: null,
            postalCode: '602 00',
            city: 'Brno',
            countryCode: 'CZ',
            contactName: 'Recepce',
            contactPhone: '+420 500 000 045',
            contactEmail: 'recepce@podminky.test',
            fulfillmentSiteId: INITIAL_SITE_ID,
          },
        }),
      );
      const hotels = await json<{ id: string; code: string }[]>(
        await r.get('/api/admin/finance/billing/hotels'),
      );
      const a = await json<{ code: string }>(
        await r.post('/api/admin/finance/billing/agreements', {
          data: {
            requestId: crypto.randomUUID(),
            hotelId: hotels.find((x) => x.code === h.code)!.id,
            terms: {
              effectiveFrom: '2026-01',
              customerId: customer.id,
              contractNumber: null,
              billedRooms: 12,
              ownPricePerRoomMonth: ownPrice,
              currency: cur,
              paymentTermsDays: 14,
              billingTiming: 'ARREARS',
              validFrom: '2026-01-01',
              validTo: null,
              reason: 'Podmínky (syntetické)',
            },
          },
        }),
      );
      return { code: h.code, agreement: a.code };
    };
    own = await hotel(`Hotel Vlastní cena ${run}`, '400.00', 'CZK');
    fromList = await hotel(`Hotel Ceník ${run}`, null, currency);

    // Own price: named, no price-list link; the panel is "Fakturace", never "smlouva".
    await page.goto(`/hotels/${own.code}`);
    await expect(page.getByTestId('hotel-sections').getByRole('link')).toContainText(['Fakturace']);
    const panel = page.getByTestId('hotel-billing');
    await expect(panel.getByRole('heading', { name: 'Fakturace', exact: true })).toBeVisible();
    await expect(panel).not.toContainText(/smlouv/i);
    await expect(panel).toContainText('Cena za pokoj a měsíc bez DPH');
    await expect(panel.getByTestId('hotel-billing-price')).toContainText('vlastní cena');
    await expect(panel.getByTestId('hotel-billing-price-list')).toHaveCount(0);
    await expect(panel.getByTestId('hotel-billing-edit')).toHaveText('Upravit fakturační podmínky');
    await shot(page, 'terms-ux-hotel-own');

    // Edit: the existing new-version form of exactly this hotel's terms, filled from the current
    // version; the way back leads to the card.
    await panel.getByTestId('hotel-billing-edit').click();
    await expect(page).toHaveURL(
      new RegExp(`/finance/billing/agreements/${own.agreement}\\?from=hotel#nova-verze$`),
    );
    const form = page.getByTestId('agreement-new-version');
    await expect(form).toBeVisible();
    await expect(form.locator('[name=billedRooms]')).toHaveValue('12');
    await expect(form).toContainText('Vlastní cena za pokoj a měsíc bez DPH');
    await expect(page.getByRole('link', { name: 'Zpět na kartu hotelu' }).first()).toBeVisible();
    await shot(page, 'terms-ux-edit');
    await form.getByTestId('agreement-back-to-hotel').click();
    await expect(page).toHaveURL(new RegExp(`/hotels/${own.code}#fakturace$`));

    // A price from the default list: shown as such, with the way to that list.
    await page.goto(`/hotels/${fromList.code}`);
    const list = page.getByTestId('hotel-billing-price-list');
    await expect(list).toHaveText('výchozí ceník');
    await shot(page, 'terms-ux-hotel-default', [1440]);
    await list.click();
    await expect(page).toHaveURL(/\/finance\/settings\/prices$/);
    await expect(page.getByTestId('billing-prices')).toContainText('Cena za pokoj a měsíc bez DPH');
    // The agreement's history links to the list too.
    await page.goto(`/finance/billing/agreements/${fromList.agreement}`);
    await expect(page.getByTestId('agreement-price-list')).toHaveAttribute(
      'href',
      '/finance/settings/prices',
    );
    // Without ?from=hotel the way back stays the list of terms (the URL is unchanged).
    await expect(page.getByRole('heading', { level: 1 })).toContainText(`Hotel Ceník ${run}`);
    await expect(page.getByTestId('agreement-back-to-hotel')).toHaveCount(0);
  });

  test('reading without the right to change: no edit offered, the form absent, the API refuses', async ({
    page,
    browser,
    baseURL,
  }) => {
    const r = page.request;
    const role = `E2E_TERMS_${crypto.randomUUID().slice(0, 6).toUpperCase()}`;
    await json(
      await r.post('/api/admin/identity/roles', {
        data: {
          code: role,
          name: 'Fakturační podmínky jen čtení (E2E)',
          description: 'Hotels and billing terms, read only',
          permissions: ['hotels:read', 'finance:billing_read'],
          copiedFrom: null,
          reason: 'e2e: billing terms read only',
        },
      }),
    );
    const email = `e2e-terms-${crypto.randomUUID().slice(0, 6)}@ayvo.test`;
    await json(
      await r.post('/api/admin/identity/users', {
        data: {
          email,
          displayName: 'Podmínky jen čtení (E2E)',
          roles: [role],
          siteIds: [INITIAL_SITE_ID],
          warehouseCodes: [],
          reason: 'e2e: billing terms read only',
        },
      }),
    );
    const ctx = await browser.newContext({ baseURL });
    const reader = await ctx.newPage();
    await reader.goto(
      `/api/auth/login?next=/hotels/${own.code}&login_hint=${encodeURIComponent(email)}`,
    );
    await expect(reader).toHaveURL(new RegExp(`/hotels/${own.code}$`));
    const panel = reader.getByTestId('hotel-billing');
    await expect(panel.getByTestId('hotel-billing-rooms')).toHaveText('12');
    await expect(panel.getByTestId('hotel-billing-edit')).toHaveCount(0);
    await shot(reader, 'terms-ux-readonly', [1440]);
    // The URL of the edit link opened by hand: the terms, never the form.
    await reader.goto(`/finance/billing/agreements/${own.agreement}?from=hotel#nova-verze`);
    await expect(reader.getByTestId('agreement-history')).toBeVisible();
    await expect(reader.getByTestId('agreement-new-version')).toHaveCount(0);
    const refused = await reader.request.post(
      `/api/admin/finance/billing/agreements/${own.agreement}/versions`,
      { data: {} },
    );
    expect(refused.status()).toBe(403);
    await ctx.close();
  });
});
