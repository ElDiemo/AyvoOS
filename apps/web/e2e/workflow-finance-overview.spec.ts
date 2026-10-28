import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
const ADMIN_STATE = 'e2e/.auth/admin.json';
const INITIAL_SITE_ID = '01990000-0000-7000-8000-000000000001';

/**
 * Přehled Financí and the links between records (doc 042): the overview shows exactly what the
 * server computed — compared with the API whatever the data are; a synthetic invoice and payments
 * change it; invoice ↔ payments and agreement ↔ invoices are linked only by their ids; a user with
 * one Finance permission sees only that block and page. Synthetic data only (TEST invoice, a
 * simulated statement); nothing reaches a bank, a carrier or a mailbox.
 */
const screenshots = resolve(import.meta.dirname, '../../../docs/screenshots/finance');

type Res = Awaited<ReturnType<APIRequestContext['get']>>;
async function json<T>(res: Res): Promise<T> {
  expect(res.ok(), `${res.url()} -> ${res.status()} ${await res.text()}`).toBe(true);
  return (await res.json()) as T;
}
interface Sums {
  invoices: {
    currency: string;
    open: { count: number; remaining: string };
    overdue: { count: number; remaining: string };
  }[];
  paymentsToReview: number;
}
const sums = async (r: APIRequestContext) =>
  json<Sums>(await r.get('/api/admin/finance/invoices/overview'));
const count = (n: number) =>
  `${n} ${n === 1 ? 'faktura' : n >= 2 && n <= 4 ? 'faktury' : 'faktur'}`;
const noOverflow = async (page: Page) =>
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );

/** The overview's blocks equal the API's answers (no number of its own). */
async function expectOverviewMatches(page: Page) {
  const r = page.request;
  const [s, docs, issuer, customers, agreements] = await Promise.all([
    sums(r),
    json<{ total: number }>(await r.get('/api/admin/finance/documents?incomplete=true')),
    json<{ current: unknown; defaults: unknown[] }>(await r.get('/api/admin/finance/issuer')),
    json<unknown[]>(await r.get('/api/admin/finance/billing/customers')),
    json<unknown[]>(await r.get('/api/admin/finance/billing/agreements')),
  ]);
  await page.goto('/finance');
  await expect(page.getByRole('heading', { level: 1, name: 'Přehled Financí' })).toBeVisible();
  if (s.invoices.length === 0) {
    await expect(page.getByTestId('overview-open-none')).toHaveText('0');
  }
  for (const c of s.invoices) {
    await expect(page.getByTestId(`overview-open-${c.currency}`)).toContainText(
      count(c.open.count),
    );
    await expect(page.getByTestId(`overview-overdue-${c.currency}`)).toContainText(
      count(c.overdue.count),
    );
  }
  await expect(page.getByTestId('overview-to-review')).toHaveText(String(s.paymentsToReview));
  await expect(page.getByTestId('overview-incomplete')).toHaveText(String(docs.total));
  const done = {
    issuer: issuer.current !== null && issuer.defaults.length > 0,
    customer: customers.length > 0,
    agreement: agreements.length > 0,
  };
  if (Object.values(done).every(Boolean)) {
    // Set up: no onboarding shown again.
    await expect(page.getByTestId('finance-next-steps')).toHaveCount(0);
  } else {
    for (const [id, d] of Object.entries(done))
      await expect(page.getByTestId(`step-${id}`)).toHaveAttribute('data-done', String(d));
  }
  return s;
}

test.describe('Přehled Financí', () => {
  test.use({ storageState: ADMIN_STATE });

  test('the overview shows only what the server computed', async ({ page }) => {
    await expectOverviewMatches(page);
    await expect(page.getByTestId('overview-bank')).toContainText('1234567890/CZK');
  });

  test('a synthetic invoice and payments change it; invoice ↔ payments and agreement ↔ invoices are linked', async ({
    page,
  }) => {
    test.setTimeout(180_000);
    const r = page.request;
    const run = crypto.randomUUID().slice(0, 6).toUpperCase();
    const issuer = await json<{ current: unknown; defaults: { currency: string }[] }>(
      await r.get('/api/admin/finance/issuer'),
    );
    expect(
      issuer.current !== null && issuer.defaults.some((d) => d.currency === 'CZK'),
      'the issuer and a CZK default account (set up by workflow-finance-issuer.spec.ts)',
    ).toBe(true);
    const before = await sums(r);

    const customer = await json<{ id: string }>(
      await r.post('/api/admin/finance/billing/customers', {
        data: {
          requestId: crypto.randomUUID(),
          customer: {
            legalName: `Přehled ${run} s.r.o. (E2E)`,
            companyId: '55667788',
            vatId: null,
            addressLine1: 'Přehledová 1',
            addressLine2: null,
            postalCode: '602 00',
            city: 'Brno',
            countryCode: 'CZ',
            billingEmail: 'fakturace@prehled.test',
          },
        },
      }),
    );
    const hotel = await json<{ code: string }>(
      await r.post('/api/admin/hotels', {
        data: {
          requestId: crypto.randomUUID(),
          name: `Hotel Přehled ${run} (E2E)`,
          addressLine1: 'Přehledová 1',
          addressLine2: null,
          postalCode: '602 00',
          city: 'Brno',
          countryCode: 'CZ',
          contactName: 'Recepce',
          contactPhone: '+420 500 000 042',
          contactEmail: 'recepce@prehled.test',
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
            ownPricePerRoomMonth: '420.00',
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
    const shown = (
      await json<{
        items: {
          agreement: { code: string };
          version: { revision: number; billedRooms: number };
          customer: { version: number };
          price: { perRoomMonth: string; priceListVersionId: string | null };
        }[];
      }>(await r.get('/api/admin/finance/billing/agreements/effective?month=2026-05'))
    ).items.find((i) => i.agreement.code === agreement.code)!;
    const invoice = await json<{ number: string; variableSymbol: string }>(
      await r.post('/api/admin/finance/invoices/test', {
        data: {
          requestId: crypto.randomUUID(),
          month: '2026-05',
          lines: [
            {
              agreementCode: agreement.code,
              agreementRevision: shown.version.revision,
              customerVersion: shown.customer.version,
              priceListVersionId: shown.price.priceListVersionId,
              unitPrice: shown.price.perRoomMonth,
              billedRooms: shown.version.billedRooms,
            },
          ],
        },
      }),
    ); // 10 × 420.00 = 4200.00
    // A simulated statement: 1000.00 by the invoice's VS, and one payment without a VS.
    const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Prague' }).format(
      new Date(),
    );
    const entry = (reference: string, amount: string, variableSymbol: string | null) => ({
      reference,
      amount,
      currency: 'CZK',
      bookedOn: today,
      variableSymbol,
      counterpartyName: `Přehled ${run} s.r.o.`,
      message: null,
    });
    await json(
      await r.post('/api/admin/finance/payments/simulate', {
        data: {
          requestId: crypto.randomUUID(),
          entries: [
            entry(`OV-${run}-A`, '1000.00', invoice.variableSymbol),
            entry(`OV-${run}-B`, '77.00', null),
          ],
        },
      }),
    );

    // The overview: one more open invoice in CZK, one more payment to review — as the API says.
    const after = await expectOverviewMatches(page);
    const czk = (s: Sums) => s.invoices.find((c) => c.currency === 'CZK')?.open.count ?? 0;
    expect(czk(after)).toBe(czk(before) + 1);
    expect(after.paymentsToReview).toBe(before.paymentsToReview + 1);
    await mkdir(screenshots, { recursive: true });
    for (const width of [1440, 390, 320]) {
      await page.setViewportSize({ width, height: 900 });
      await noOverflow(page);
      await page.screenshot({
        path: resolve(screenshots, `finance-042-overview-populated-${width}.png`),
        fullPage: true,
      });
    }
    await page.setViewportSize({ width: 1280, height: 900 });

    // Invoice → its payment (by the allocation's payment code) → back to the invoice.
    await page.getByTestId('overview-open-CZK').click();
    await expect(page).toHaveURL(/\/finance\/invoices$/);
    await page.getByTestId(`invoice-row-${invoice.number}`).getByRole('link').click();
    await expect(page.getByTestId('invoice-payment-state')).toHaveText('Částečně uhrazeno');
    const paymentLink = page.getByTestId('invoice-allocations').getByRole('link');
    await expect(paymentLink).toHaveCount(1);
    const paymentCode = (await paymentLink.textContent())!.trim();
    await paymentLink.click();
    await expect(page).toHaveURL(new RegExp(`/finance/payments#${paymentCode}$`));
    const payment = page.getByTestId(`payment-${paymentCode}`);
    await expect(payment).toBeInViewport();
    await payment.getByRole('link', { name: new RegExp(invoice.number) }).click();
    await expect(page).toHaveURL(new RegExp(`/finance/invoices/${invoice.number}$`));

    // Invoice → its agreement → the agreement's invoices (by invoice_lines.agreement_id).
    await page.getByTestId(`invoice-agreement-${agreement.code}`).click();
    await expect(page).toHaveURL(new RegExp(`/finance/billing/agreements/${agreement.code}$`));
    const related = page.getByTestId('agreement-invoices');
    await expect(related.locator('li')).toHaveCount(1);
    await expect(related).toContainText(invoice.number);
    await related.getByRole('link', { name: invoice.number }).click();
    await expect(page).toHaveURL(new RegExp(`/finance/invoices/${invoice.number}$`));
  });

  test('one Finance permission: only its block and page; the rest is refused', async ({
    page,
    browser,
    baseURL,
  }) => {
    const r = page.request;
    const role = `E2E_BANK_${crypto.randomUUID().slice(0, 6).toUpperCase()}`;
    await json(
      await r.post('/api/admin/identity/roles', {
        data: {
          code: role,
          name: 'Jen banka (E2E)',
          description: 'Finance: only bank transactions',
          permissions: ['finance:bank_read'],
          copiedFrom: null,
          reason: 'e2e: one Finance permission',
        },
      }),
    );
    const email = `e2e-bank-${crypto.randomUUID().slice(0, 6)}@ayvo.test`;
    await json(
      await r.post('/api/admin/identity/users', {
        data: {
          email,
          displayName: 'Jen banka (E2E)',
          roles: [role],
          siteIds: [INITIAL_SITE_ID],
          warehouseCodes: [],
          reason: 'e2e: one Finance permission',
        },
      }),
    );
    const ctx = await browser.newContext({ baseURL });
    const bank = await ctx.newPage();
    await bank.goto(`/api/auth/login?next=/finance&login_hint=${encodeURIComponent(email)}`);
    await expect(bank).toHaveURL(/\/finance$/);
    const finance = bank.getByRole('navigation', { name: 'Finance' });
    await expect(finance.getByRole('link')).toHaveText(['Přehled', 'Banka a platby']);
    await expect(bank.getByTestId('overview-bank')).toBeVisible();
    for (const id of ['overview-invoices', 'overview-payments', 'overview-documents'])
      await expect(bank.getByTestId(id)).toHaveCount(0);
    await expect(bank.getByTestId('finance-next-steps')).toHaveCount(0);
    // Banka a platby: one view only, so no tabs.
    await finance.getByRole('link', { name: 'Banka a platby' }).click();
    await expect(bank).toHaveURL(/\/finance\/bank$/);
    await expect(bank.getByRole('navigation', { name: 'Zobrazení' })).toHaveCount(0);
    await expect(bank.getByTestId('bank-to-payments')).toHaveCount(0);
    for (const path of ['/finance/billing', '/finance/payments', '/finance/invoices']) {
      await bank.goto(path);
      await expect(bank, path).toHaveURL(/\/forbidden$/);
    }
    expect((await bank.request.get('/api/admin/finance/invoices/overview')).status()).toBe(403);
    await ctx.close();
  });
});
