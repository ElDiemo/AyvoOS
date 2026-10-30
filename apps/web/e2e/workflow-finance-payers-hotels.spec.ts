import { readFileSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
const ADMIN_STATE = 'e2e/.auth/admin.json';
const OPERATOR_STATE = 'e2e/.auth/operator.json';
const INITIAL_SITE_ID = '01990000-0000-7000-8000-000000000001';

/**
 * A hotel's card and Finance (doc 044 U2), synthetic data: hotel → payer and agreement → invoice →
 * payment and back, two hotels of one payer, a user without Finance, and a real outage of the Finance
 * process, in which the hotel's page keeps working and says only that billing is unavailable. Needs
 * the issuer and a CZK default account (workflow-finance-issuer.spec.ts runs before).
 */
const screenshots = resolve(import.meta.dirname, '../../../docs/screenshots/finance');
const serverPid = () =>
  Number(readFileSync(join(tmpdir(), 'ayvo-e2e-server-4100.pid'), 'utf8').trim());
const financeReady = async (request: APIRequestContext) =>
  (await request.get('/api/admin/finance/health/ready').catch(() => null))?.status() ?? 0;

type Res = Awaited<ReturnType<APIRequestContext['get']>>;
async function json<T>(res: Res): Promise<T> {
  expect(res.ok(), `${res.url()} -> ${res.status()} ${await res.text()}`).toBe(true);
  return (await res.json()) as T;
}
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
const hotelBody = (name: string) => ({
  requestId: crypto.randomUUID(),
  name,
  addressLine1: 'Ukázková 1',
  addressLine2: null,
  postalCode: '602 00',
  city: 'Brno',
  countryCode: 'CZ',
  contactName: 'Recepce',
  contactPhone: '+420 500 000 044',
  contactEmail: 'recepce@ukazka.test',
  fulfillmentSiteId: INITIAL_SITE_ID,
});
const terms = (customerId: string, rooms: number) => ({
  effectiveFrom: '2026-01',
  customerId,
  contractNumber: null,
  billedRooms: rooms,
  ownPricePerRoomMonth: '400.00',
  currency: 'CZK',
  paymentTermsDays: 14,
  billingTiming: 'ARREARS',
  validFrom: '2026-01-01',
  validTo: null,
  reason: 'Smlouva (syntetická)',
});

test.describe.serial('Karta hotelu a Finance', () => {
  test.use({ storageState: ADMIN_STATE });
  const run = crypto.randomUUID().slice(0, 6).toUpperCase();
  let hotelA = '';
  let hotelB = '';
  let number = '';

  test('hotel → payer and agreement → invoice → payment and back, by the keyboard too', async ({
    page,
  }) => {
    test.setTimeout(180_000);
    const r = page.request;
    hotelA = (
      await json<{ code: string }>(
        await r.post('/api/admin/hotels', { data: hotelBody(`Hotel Plátce A ${run}`) }),
      )
    ).code;
    hotelB = (
      await json<{ code: string }>(
        await r.post('/api/admin/hotels', { data: hotelBody(`Hotel Plátce B ${run}`) }),
      )
    ).code;

    await page.goto(`/hotels/${hotelA}`);
    const panel = page.getByTestId('hotel-billing');
    await expect(panel.getByTestId('hotel-billing-none')).toContainText('Hotel zatím nemá smlouvu');
    await shots(page, 'ux2-hotel-no-agreement');

    // By the keyboard from the card to the form, with this hotel already chosen.
    await panel.getByTestId('hotel-billing-create').focus();
    await page.keyboard.press('Enter');
    await expect(page).toHaveURL(/\/finance\/billing\?hotel=/);
    const form = page.getByTestId('agreement-new');
    const chosen = form.locator('[name=hotelId] option:checked');
    await expect(chosen).toContainText(`Hotel Plátce A ${run}`);

    // No payer of this name yet: one is created here, the form keeps what is in it.
    const payer = `Společný plátce ${run} s.r.o.`;
    const customerForm = page.getByTestId('customer-new');
    await customerForm.locator('[name=legalName]').fill(payer);
    await customerForm.locator('[name=addressLine1]').fill('Ukázková 1');
    await customerForm.locator('[name=postalCode]').fill('602 00');
    await customerForm.locator('[name=city]').fill('Brno');
    await customerForm.locator('[name=billingEmail]').fill('fakturace@ukazka.test');
    await customerForm.getByTestId('customer-save').click();
    await expect(customerForm.getByRole('status')).toHaveText('Uloženo.');
    await expect(chosen).toContainText(`Hotel Plátce A ${run}`);

    const customers = await json<
      { id: string; code: string; current: { customer: { legalName: string } } }[]
    >(await r.get('/api/admin/finance/billing/customers'));
    const customer = customers.find((c) => c.current.customer.legalName === payer)!;
    await form.locator('[name=customerId]').selectOption(customer.id);
    await form.locator('[name=billedRooms]').fill('12');
    await form.locator('[name=ownPrice]').fill('400.00');
    await form.locator('[name=effectiveFrom]').fill('2026-01');
    await form.locator('[name=validFrom]').fill('2026-01-01');
    await form.locator('[name=reason]').fill('Smlouva (syntetická)');
    await form.getByRole('button').first().click();
    await expect(form.getByRole('status')).toHaveText('Uloženo.');

    // Back on the card: everything comes from Finance, with its time context.
    await page.goto(`/hotels/${hotelA}`);
    await expect(panel.getByTestId('hotel-billing-payer')).toHaveText(payer);
    await expect(panel.getByTestId('hotel-billing-month')).toContainText('Platí pro');
    await expect(panel.getByTestId('hotel-billing-rooms')).toHaveText('12');
    await expect(panel.getByTestId('hotel-billing-price')).toContainText('vlastní cena');
    await expect(panel.getByTestId('hotel-billing-price')).toContainText('CZK');
    await expect(panel.getByTestId('hotel-billing-invoices')).toContainText(
      'Hotel zatím nemá žádnou fakturu',
    );

    // The second hotel of the same payer, with its own rooms; a summary invoice of both.
    const hotels = await json<{ id: string; code: string }[]>(
      await r.get('/api/admin/finance/billing/hotels'),
    );
    await json(
      await r.post('/api/admin/finance/billing/agreements', {
        data: {
          requestId: crypto.randomUUID(),
          hotelId: hotels.find((h) => h.code === hotelB)!.id,
          terms: terms(customer.id, 5),
        },
      }),
    );
    const effective = await json<{
      items: {
        agreement: { code: string; hotel: { code: string } };
        version: { revision: number; billedRooms: number };
        customer: { version: number };
        price: { perRoomMonth: string; priceListVersionId: string | null };
      }[];
    }>(await r.get('/api/admin/finance/billing/agreements/effective?month=2026-06'));
    const invoice = await json<{ number: string; pdfSha256: string }>(
      await r.post('/api/admin/finance/invoices/test', {
        data: {
          requestId: crypto.randomUUID(),
          month: '2026-06',
          lines: [hotelA, hotelB].map((code) => {
            const t = effective.items.find((i) => i.agreement.hotel.code === code)!;
            return {
              agreementCode: t.agreement.code,
              agreementRevision: t.version.revision,
              customerVersion: t.customer.version,
              priceListVersionId: t.price.priceListVersionId,
              unitPrice: t.price.perRoomMonth,
              billedRooms: t.version.billedRooms,
            };
          }),
        },
      }),
    );
    number = invoice.number;
    for (const code of [hotelA, hotelB]) {
      await page.goto(`/hotels/${code}`);
      await expect(panel.getByTestId('hotel-billing-payer')).toHaveText(payer);
      await expect(panel.getByTestId(`hotel-invoice-summary-${number}`)).toContainText(
        'souhrnná faktura firmy',
      );
    }
    await expect(panel.getByTestId('hotel-billing-rooms')).toHaveText('5');
    await shots(page, 'ux2-hotel-billing');

    // Invoice → payment → back to the invoice and the hotel.
    await panel.getByRole('link', { name: number }).click();
    await expect(page).toHaveURL(new RegExp(`/finance/invoices/${number}$`));
    const vs = (await page.locator('[data-testid="invoice-detail"]').innerText()).match(
      /99\d{8}/,
    )![0];
    await json(
      await r.post('/api/admin/finance/payments/simulate', {
        data: {
          requestId: crypto.randomUUID(),
          entries: [
            {
              reference: `UX2-${run}`,
              amount: '1000.00',
              currency: 'CZK',
              variableSymbol: vs,
              bookedOn: '2026-06-20',
              counterpartyName: 'Společný plátce (syntetický)',
              message: null,
            },
          ],
        },
      }),
    );
    await page.reload();
    await expect(page.getByTestId('invoice-payment-state')).toContainText('Částečně');
    await page.getByTestId('invoice-allocations').getByRole('link').first().click();
    await expect(page).toHaveURL(/\/finance\/payments/);
    await page.goBack();
    await page
      .getByRole('link', { name: /BA-\d+/ })
      .first()
      .click();
    await page.getByTestId('agreement-hotel').click();
    await expect(page).toHaveURL(new RegExp(`/hotels/(${hotelA}|${hotelB})#fakturace$`));
    await expect(page.getByTestId('hotel-billing')).toContainText(number);
    await expect(page.getByTestId('hotel-billing')).toContainText('Částečně');
  });

  test('a payer rename leaves the issued PDF and invoice as they were', async ({ page }) => {
    const r = page.request;
    const before = await r.get(`/api/admin/finance/invoices/${number}/pdf`);
    const bytes = await before.body();
    const inv = await json<{ customer: { code: string; legalName: string } }>(
      await r.get(`/api/admin/finance/invoices/${number}`),
    );
    const c = await json<{ current: { version: number; customer: Record<string, unknown> } }>(
      await r.get(`/api/admin/finance/billing/customers/${inv.customer.code}`),
    );
    await json(
      await r.post(`/api/admin/finance/billing/customers/${inv.customer.code}/versions`, {
        data: {
          requestId: crypto.randomUUID(),
          expectedVersion: c.current.version,
          customer: { ...c.current.customer, legalName: `Přejmenovaný plátce ${run}` },
          reason: 'Změna názvu (test)',
        },
      }),
    );
    const after = await r.get(`/api/admin/finance/invoices/${number}/pdf`);
    expect((await after.body()).equals(bytes)).toBe(true);
    const again = await json<{ customer: { legalName: string } }>(
      await r.get(`/api/admin/finance/invoices/${number}`),
    );
    expect(again.customer.legalName).toBe(inv.customer.legalName);
    await page.goto(`/hotels/${hotelA}`);
    await expect(page.getByTestId('hotel-billing-payer')).toHaveText(`Přejmenovaný plátce ${run}`);
  });

  test('Finance down: the hotel works, the panel says only that billing is unavailable', async ({
    page,
    request,
  }) => {
    await expect.poll(() => financeReady(request), { timeout: 30_000 }).toBe(200);
    process.kill(serverPid(), 'SIGUSR2');
    try {
      await expect.poll(() => financeReady(request), { timeout: 15_000 }).not.toBe(200);
      await page.goto(`/hotels/${hotelA}`);
      await expect(page.getByRole('heading', { level: 1 })).toContainText('Hotel Plátce A');
      await expect(page.getByTestId('hotel-address')).toBeVisible();
      const panel = page.getByTestId('hotel-billing');
      await expect(panel).toContainText('Fakturace dočasně nedostupná');
      await expect(panel).not.toContainText('nemá smlouvu');
      await expect(panel).not.toContainText('žádnou fakturu');
      await expect(panel.getByTestId('hotel-billing-rooms')).toHaveCount(0);
      await shots(page, 'ux2-hotel-finance-down');
    } finally {
      process.kill(serverPid(), 'SIGUSR1');
      await expect.poll(() => financeReady(request), { timeout: 30_000 }).toBe(200);
    }
    await page.goto(`/hotels/${hotelA}`);
    await expect(page.getByTestId('hotel-billing-rooms')).toHaveText('12');
  });

  test.describe('without Finance', () => {
    test.use({ storageState: OPERATOR_STATE });
    test('no panel, no link; the routes and API refuse', async ({ page }) => {
      await page.goto(`/hotels/${hotelA}`);
      if (await page.getByRole('heading', { level: 1 }).count())
        await expect(page.getByTestId('hotel-billing')).toHaveCount(0);
      await expect(page.locator('a[href*="/finance/"]')).toHaveCount(0);
      expect((await page.request.get('/api/admin/finance/billing/agreements')).status()).toBe(403);
      expect((await page.request.get('/api/admin/finance/invoices')).status()).toBe(403);
    });
  });
});
