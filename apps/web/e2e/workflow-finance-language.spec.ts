import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
const ADMIN_STATE = 'e2e/.auth/admin.json';
const INITIAL_SITE_ID = '01990000-0000-7000-8000-000000000001';

/**
 * The language of a customer's documents (doc 040 §12), synthetic data: chosen in the form, never
 * preselected or derived from the country; the TEST invoice and its PDF follow that choice. Needs
 * the issuer and a CZK default account (workflow-finance-issuer.spec.ts runs before).
 */
const screenshots = resolve(import.meta.dirname, '../../../docs/screenshots/finance');

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

test.describe('Jazyk dokumentů', () => {
  test.use({ storageState: ADMIN_STATE });

  test('chosen on the customer, frozen on the TEST invoice and its PDF', async ({ page }) => {
    test.setTimeout(180_000);
    const r = page.request;
    const run = crypto.randomUUID().slice(0, 6).toUpperCase();
    const name = `Sprache ${run} GmbH (E2E)`;

    await page.goto('/finance/billing');
    await page.getByTestId('customer-new-open').click();
    const form = page.getByTestId('customer-new');
    await form.locator('[name=legalName]').fill(name);
    await form.locator('[name=addressLine1]').fill('Hauptstraße 1');
    await form.locator('[name=postalCode]').fill('10115');
    await form.locator('[name=city]').fill('Berlin');
    await form.locator('[name=countryCode]').fill('DE');
    await form.locator('[name=billingEmail]').fill('rechnung@sprache.test');
    // The country suggests nothing: no language until the user chooses, and the form says so.
    const language = form.locator('[name=documentLanguage]');
    await expect(language).toHaveValue('');
    await form.getByTestId('customer-save').click();
    expect(await language.evaluate((e: HTMLSelectElement) => e.validity.valueMissing)).toBe(true);
    await language.selectOption('de');
    await form.getByTestId('customer-save').click();
    await expect(form.getByRole('status')).toHaveText('Uloženo.');
    await expect(page.getByTestId('billing-customers')).toContainText(name);

    const customers = await json<
      {
        id: string;
        code: string;
        current: { customer: { legalName: string; documentLanguage: string } };
      }[]
    >(await r.get('/api/admin/finance/billing/customers'));
    const customer = customers.find((c) => c.current.customer.legalName === name)!;
    expect(customer.current.customer.documentLanguage).toBe('de');

    const hotel = await json<{ code: string }>(
      await r.post('/api/admin/hotels', {
        data: {
          requestId: crypto.randomUUID(),
          name: `Hotel Sprache ${run}`,
          addressLine1: 'Hauptstraße 1',
          addressLine2: null,
          postalCode: '10115',
          city: 'Berlin',
          countryCode: 'DE',
          contactName: 'Rezeption',
          contactPhone: '+49 30 000 043',
          contactEmail: 'rezeption@sprache.test',
          fulfillmentSiteId: INITIAL_SITE_ID,
        },
      }),
    );
    const hotels = await json<{ id: string; code: string }[]>(
      await r.get('/api/admin/finance/billing/hotels'),
    );
    const agreement = await json<{ code: string }>(
      await r.post('/api/admin/finance/billing/agreements', {
        data: {
          requestId: crypto.randomUUID(),
          hotelId: hotels.find((h) => h.code === hotel.code)!.id,
          terms: {
            effectiveFrom: '2026-01',
            customerId: customer.id,
            contractNumber: null,
            billedRooms: 10,
            ownPricePerRoomMonth: '400.00',
            currency: 'CZK',
            paymentTermsDays: 14,
            billingTiming: 'ARREARS',
            validFrom: '2026-01-01',
            validTo: null,
            reason: 'Vertrag (synthetisch)',
          },
        },
      }),
    );
    const terms = await json<{
      items: {
        agreement: { code: string };
        version: { revision: number; billedRooms: number };
        customer: { version: number };
        price: { perRoomMonth: string; priceListVersionId: string | null };
      }[];
    }>(await r.get('/api/admin/finance/billing/agreements/effective?month=2026-06'));
    const t = terms.items.find((i) => i.agreement.code === agreement.code)!;
    const invoice = await json<{ number: string; documentLanguage: string }>(
      await r.post('/api/admin/finance/invoices/test', {
        data: {
          requestId: crypto.randomUUID(),
          month: '2026-06',
          lines: [
            {
              agreementCode: agreement.code,
              agreementRevision: t.version.revision,
              customerVersion: t.customer.version,
              priceListVersionId: t.price.priceListVersionId,
              unitPrice: t.price.perRoomMonth,
              billedRooms: t.version.billedRooms,
            },
          ],
        },
      }),
    );
    expect(invoice.documentLanguage).toBe('de');
    const pdf = await r.get(`/api/admin/finance/invoices/${invoice.number}/pdf`);
    expect(pdf.ok()).toBe(true);
    expect(pdf.headers()['content-disposition']).toContain(`rechnung-${invoice.number}.pdf`);
    expect((await pdf.body()).subarray(0, 5).toString()).toBe('%PDF-');

    await page.goto(`/finance/invoices/${invoice.number}`);
    await expect(page.getByTestId('invoice-language')).toHaveText('němčina');
    await shots(page, 'finance-language-invoice');
    await page.goto(`/finance/billing/customers/${customer.code}`);
    await expect(page.locator('[name=documentLanguage]')).toHaveValue('de');
    await shots(page, 'finance-language-customer');
  });

  test('send by hand: the address first, the state after; an uncertain result is retried only by a person', async ({
    page,
  }) => {
    test.setTimeout(180_000);
    const r = page.request;
    const run = crypto.randomUUID().slice(0, 6).toUpperCase();
    const customerData = {
      legalName: `Delivery ${run} Ltd (E2E)`,
      companyId: null,
      vatId: null,
      addressLine1: 'High Street 1',
      addressLine2: null,
      postalCode: 'SW1',
      city: 'London',
      countryCode: 'GB',
      billingEmail: 'billing@nejiste.test',
      documentLanguage: 'en',
    };
    const customer = await json<{ id: string; code: string }>(
      await r.post('/api/admin/finance/billing/customers', {
        data: { requestId: crypto.randomUUID(), customer: customerData },
      }),
    );
    const hotel = await json<{ code: string }>(
      await r.post('/api/admin/hotels', {
        data: {
          requestId: crypto.randomUUID(),
          name: `Hotel Delivery ${run}`,
          addressLine1: 'High Street 1',
          addressLine2: null,
          postalCode: 'SW1',
          city: 'London',
          countryCode: 'GB',
          contactName: 'Reception',
          contactPhone: '+44 20 0000 043',
          contactEmail: 'reception@delivery.test',
          fulfillmentSiteId: INITIAL_SITE_ID,
        },
      }),
    );
    const hotels = await json<{ id: string; code: string }[]>(
      await r.get('/api/admin/finance/billing/hotels'),
    );
    const agreement = await json<{ code: string }>(
      await r.post('/api/admin/finance/billing/agreements', {
        data: {
          requestId: crypto.randomUUID(),
          hotelId: hotels.find((h) => h.code === hotel.code)!.id,
          terms: {
            effectiveFrom: '2026-01',
            customerId: customer.id,
            contractNumber: null,
            billedRooms: 10,
            ownPricePerRoomMonth: '400.00',
            currency: 'CZK',
            paymentTermsDays: 14,
            billingTiming: 'ARREARS',
            validFrom: '2026-01-01',
            validTo: null,
            reason: 'Contract (synthetic)',
          },
        },
      }),
    );
    const terms = await json<{
      items: {
        agreement: { code: string };
        version: { revision: number; billedRooms: number };
        customer: { version: number };
        price: { perRoomMonth: string; priceListVersionId: string | null };
      }[];
    }>(await r.get('/api/admin/finance/billing/agreements/effective?month=2026-05'));
    const t = terms.items.find((i) => i.agreement.code === agreement.code)!;
    const invoice = await json<{ number: string }>(
      await r.post('/api/admin/finance/invoices/test', {
        data: {
          requestId: crypto.randomUUID(),
          month: '2026-05',
          lines: [
            {
              agreementCode: agreement.code,
              agreementRevision: t.version.revision,
              customerVersion: t.customer.version,
              priceListVersionId: t.price.priceListVersionId,
              unitPrice: t.price.perRoomMonth,
              billedRooms: t.version.billedRooms,
            },
          ],
        },
      }),
    );

    await page.goto(`/finance/invoices/${invoice.number}`);
    const panel = page.getByTestId('invoice-delivery');
    // Nothing is sent by issuing; the address and the sender are shown before the action.
    await expect(panel).toContainText('Faktura zatím nebyla odeslána.');
    await expect(page.getByTestId('delivery-recipient')).toContainText('billing@nejiste.test');
    await expect(page.getByTestId('delivery-recipient')).toContainText(
      'AYVO Billing <invoice@ayvo.co>',
    );
    await shots(page, 'finance-delivery-before');
    await page.getByTestId('delivery-send').click();
    // The simulated relay lost the connection: uncertain, and it stays so by itself.
    await expect(panel.getByTestId('delivery-UNCERTAIN')).toBeVisible({ timeout: 20_000 });
    await expect(panel).toContainText('zpráva mohla odejít');
    await shots(page, 'finance-delivery-uncertain');

    // A retry needs a reason and the warning; the address is corrected through a customer version.
    await json(
      await r.post(`/api/admin/finance/billing/customers/${customer.code}/versions`, {
        data: {
          requestId: crypto.randomUUID(),
          expectedVersion: 1,
          customer: { ...customerData, billingEmail: 'billing@delivery.test' },
          reason: 'Corrected address',
        },
      }),
    );
    await page.reload();
    const retry = page.getByTestId('delivery-retry-form');
    await expect(retry).toContainText('billing@delivery.test');
    await page.getByTestId('delivery-retry').click();
    expect(
      await page
        .getByTestId('delivery-retry-reason')
        .evaluate((e: HTMLInputElement) => e.validity.valueMissing),
    ).toBe(true);
    await page.getByTestId('delivery-retry-reason').fill('Customer received nothing');
    await page.getByTestId('delivery-retry').click();
    expect(
      await page
        .getByTestId('delivery-retry-understood')
        .evaluate((e: HTMLInputElement) => e.validity.valueMissing),
    ).toBe(true);
    await page.getByTestId('delivery-retry-understood').check();
    await page.getByTestId('delivery-retry').click();
    // Here the transport is simulated, and the page says nothing left the system.
    await expect(panel.getByTestId('delivery-SENT')).toBeVisible({ timeout: 20_000 });
    await expect(panel.getByTestId('delivery-SENT')).toContainText('žádný e-mail neodešel');
    await expect(panel.getByTestId('delivery-mode-SIMULATION')).toContainText(
      'nic neopustí systém',
    );
    await expect(page.getByTestId('delivery-send')).toHaveCount(0);
    await expect(page.getByTestId('delivery-retry')).toHaveCount(0);
    await shots(page, 'finance-delivery-sent');

    await page.goto('/finance/invoices');
    await expect(page.getByTestId(`invoice-delivery-${invoice.number}`)).toBeVisible();
  });
});
