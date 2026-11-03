import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { expect, test, type APIRequestContext, type Page } from '@playwright/test';

const ADMIN_STATE = 'e2e/.auth/admin.json';
const LABEL = 'SMOKE DEV 2026-11-03';

/**
 * The owner's smoke of 2026-11-03, in the isolated e2e environment (fake identity, its own
 * database, simulated mail and bank): the scenario "SMOKE DEV 2026-11-03" from the beginning to the
 * end with its variants. Three payers (cs / en / de) and four hotels, two sharing one payer; own
 * prices and the default price list; the run settings → the plan → the monthly run → PDF in the
 * payer's language → simulated sending → simulated payments of every kind → the overview against the
 * lists. Amounts are checked with exact integer arithmetic (hundredths), never floats. Synthetic data
 * only; this is the laboratory walk-through, not the DEV one (docs/smoke/2026-11-03-finance.md).
 */
const screenshots = resolve(import.meta.dirname, '../../../docs/screenshots/finance/smoke');

type Json = Record<string, unknown>;
const json = async <T>(res: Awaited<ReturnType<APIRequestContext['get']>>): Promise<T> => {
  expect(res.ok(), `${res.url()} ${res.status()} ${await res.text()}`).toBe(true);
  return (await res.json()) as T;
};
const cents = (v: string) => {
  const [whole, frac = ''] = v.split('.');
  return BigInt(whole!) * 100n + BigInt(frac.padEnd(2, '0'));
};
const money = (c: bigint) => `${c / 100n}.${String(c % 100n).padStart(2, '0')}`;
const plusDays = (date: string, days: number) => {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
};

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
    expect(overflow, `${name} at ${width}: no horizontal page scroll`).toBeLessThanOrEqual(0);
    await page.screenshot({ path: resolve(screenshots, `${name}-${width}.png`), fullPage: true });
  }
  await page.setViewportSize({ width: 1440, height: 900 });
}

type Invoice = {
  number: string;
  variableSymbol: string;
  total: string;
  issuedOn: string;
  dueOn: string;
  period: string;
  currency: string;
  documentLanguage: string;
  pdfSha256: string;
  status: 'VALID' | 'CANCELLED';
  customer: { code: string; legalName: string; version: number };
  lines: { agreementCode: string; billedRooms: number; unitPrice: string; amount: string }[];
  paymentState: { state: string; paid: string; remaining: string; overdue: boolean };
  payment: { iban: string; amount: string; variableSymbol: string; dueOn: string };
};
type Payment = {
  code: string;
  matchResult: string;
  state: string;
  allocated: string;
  unallocated: string;
  toReview?: boolean;
};
type PreviewItem = {
  agreementCode: string;
  state: string;
  blockers: string[];
  invoiceNumber: string | null;
  customer: { code: string; version: number } | null;
  agreementRevision: number | null;
  billedRooms: number | null;
  price: { source: string; perRoomMonth: string | null; priceListVersionId: string | null };
  amount: string | null;
  paymentTermsDays: number | null;
};

test.describe(LABEL, () => {
  test.use({ storageState: ADMIN_STATE });

  test('hotel → payer → agreement → settings → run → PDF → sending → payments → overview, with variants', async ({
    page,
  }) => {
    test.setTimeout(300_000);
    page.setDefaultTimeout(20_000);
    const r = page.request;
    const run = crypto.randomUUID().slice(0, 4).toUpperCase();
    const tag = `${LABEL} ${run}`;

    // --- the issuer: the e2e issuer fixture (workflow-finance-issuer) is a VAT payer; TEST invoices
    // print no VAT and a TEST note — the real VAT document stays blocked (doc 040 §5, §13).
    const issuer = await json<{ current: { issuer: { vatStatus: string } } | null }>(
      await r.get('/api/admin/finance/issuer'),
    );
    expect(
      issuer.current?.issuer.vatStatus,
      'the issuer fixture must exist (run after the issuer spec)',
    ).toBe('VAT_PAYER');

    // --- four hotels in the core
    const me = await json<{ sites: { id: string; code: string }[] }>(await r.get('/api/auth/me'));
    const siteId = me.sites.find((s) => s.code === 'CZ-PREROV-01')!.id;
    const hotels: { key: string; code: string; name: string }[] = [];
    for (const key of ['H1', 'H2', 'H3', 'H4']) {
      const name = `${tag} Hotel ${key}`;
      const h = await json<{ code: string }>(
        await r.post('/api/admin/hotels', {
          data: {
            requestId: crypto.randomUUID(),
            name,
            addressLine1: 'Syntetická 1',
            addressLine2: null,
            postalCode: '602 00',
            city: 'Brno',
            countryCode: 'CZ',
            contactName: 'Recepce (syntetická)',
            contactPhone: '+420 500 000 000',
            contactEmail: `recepce-${key.toLowerCase()}@smoke.test`,
            fulfillmentSiteId: siteId,
          },
        }),
      );
      hotels.push({ key, code: h.code, name });
    }
    const financeHotels = await json<{ id: string; code: string }[]>(
      await r.get('/api/admin/finance/billing/hotels'),
    );
    const hotelId = (code: string) => financeHotels.find((h) => h.code === code)!.id;

    // --- payer cs through the form: without a language nothing is saved (no silent guess)
    await page.goto(`/hotels/${hotels[0]!.code}`);
    await page.getByTestId('hotel-billing').getByTestId('hotel-billing-create').click();
    await expect(page).toHaveURL(/\/finance\/billing\?hotel=/);
    const customer = page.getByTestId('customer-new');
    const payerCs = `${tag} Plátce CZ s.r.o.`;
    await customer.locator('[name=legalName]').fill(payerCs);
    await customer.locator('[name=addressLine1]').fill('Syntetická 1');
    await customer.locator('[name=postalCode]').fill('602 00');
    await customer.locator('[name=city]').fill('Brno');
    await customer.locator('[name=countryCode]').selectOption('CZ');
    await customer.locator('[name=billingEmail]').fill(`platce-cz-${run.toLowerCase()}@smoke.test`);
    await expect(customer.locator('[name=documentLanguage]')).toHaveValue('');
    await customer.getByTestId('customer-save').click();
    expect(
      await customer
        .locator('[name=documentLanguage]')
        .evaluate((e: HTMLSelectElement) => e.validity.valueMissing),
      'a missing language blocks saving',
    ).toBe(true);
    await expect(customer.getByRole('status')).toHaveCount(0);
    await customer.locator('[name=documentLanguage]').selectOption('cs');
    await customer.getByTestId('customer-save').click();
    await expect(customer.getByRole('status')).toHaveText('Uloženo.');

    // --- agreement H1 through the form: own price in Czech notation
    const form = page.getByTestId('agreement-new');
    await expect(form.locator('[name=hotelId] option:checked')).toContainText(hotels[0]!.name);
    const cOption = await form
      .locator('[name=customerId] option', { hasText: payerCs })
      .first()
      .getAttribute('value');
    await form.locator('[name=customerId]').selectOption(cOption!);
    await form.locator('[name=billedRooms]').fill('12');
    await form.locator('[name=ownPrice]').fill('1 000,50');
    // SMOKE-2: the form preselects "zpětně" (ARREARS) and 14 days; recorded, then chosen explicitly.
    const preselected = {
      timing: await form.locator('[name=billingTiming]').inputValue(),
      days: await form.locator('[name=paymentTermsDays]').inputValue(),
    };
    test.info().annotations.push({ type: 'SMOKE-2', description: JSON.stringify(preselected) });
    await form.locator('[name=billingTiming]').selectOption('ADVANCE');
    await form.locator('[name=paymentTermsDays]').fill('14');
    await form.locator('[name=effectiveFrom]').fill('2026-01');
    await form.locator('[name=validFrom]').fill('2026-01-01');
    await form.locator('[name=reason]').fill(`${LABEL}: smlouva (syntetická)`);
    await form.getByTestId('agreement-save').click();
    await expect(form.getByRole('status')).toHaveText('Uloženo.');
    await expect(page.getByRole('heading', { level: 1 })).toContainText(hotels[0]!.name);
    await expect(page.getByTestId('agreement-history')).toContainText('1 000,50');
    await shots(page, 'smoke-agreement');

    // --- payers en and de through the API (the same contract the form uses)
    const customers = await json<
      { id: string; code: string; current: { customer: { legalName: string } } }[]
    >(await r.get('/api/admin/finance/billing/customers'));
    const cs = customers.find((c) => c.current.customer.legalName === payerCs)!;
    const payer = async (legalName: string, countryCode: string, documentLanguage: string) =>
      json<{ id: string; code: string }>(
        await r.post('/api/admin/finance/billing/customers', {
          data: {
            requestId: crypto.randomUUID(),
            customer: {
              legalName,
              companyId: null,
              vatId: null,
              addressLine1: 'Synthetic Street 1',
              addressLine2: null,
              postalCode: '10115',
              city: countryCode === 'DE' ? 'Berlin' : 'London',
              countryCode,
              billingEmail: `payer-${documentLanguage}-${run.toLowerCase()}@smoke.test`,
              documentLanguage,
            },
          },
        }),
      );
    const en = await payer(`${tag} Payer Ltd`, 'GB', 'en');
    const de = await payer(`${tag} Zahler GmbH`, 'DE', 'de');

    // --- the default CZK price list for H3 (a new version from 2026-10, the revision seen)
    const prices = await json<{ revision: number; currency: string; effectiveFrom: string }[]>(
      await r.get('/api/admin/finance/billing/price-list'),
    );
    const seen = prices.filter((p) => p.currency === 'CZK' && p.effectiveFrom === '2026-10');
    await json(
      await r.post('/api/admin/finance/billing/price-list', {
        data: {
          requestId: crypto.randomUUID(),
          expectedRevision: seen.length ? Math.max(...seen.map((p) => p.revision)) : null,
          currency: 'CZK',
          pricePerRoomMonth: '777.77',
          effectiveFrom: '2026-10',
          reason: `${LABEL}: výchozí ceník (syntetický)`,
        },
      }),
    );

    const agreement = async (
      hotelCode: string,
      customerId: string,
      rooms: number,
      price: string | null,
      days: number,
    ) =>
      (
        await json<{ code: string }>(
          await r.post('/api/admin/finance/billing/agreements', {
            data: {
              requestId: crypto.randomUUID(),
              hotelId: hotelId(hotelCode),
              terms: {
                effectiveFrom: '2026-01',
                customerId,
                contractNumber: null,
                billedRooms: rooms,
                ownPricePerRoomMonth: price,
                currency: 'CZK',
                paymentTermsDays: days,
                billingTiming: 'ADVANCE',
                validFrom: '2026-01-01',
                validTo: null,
                reason: `${LABEL}: smlouva (syntetická)`,
              },
            },
          }),
        )
      ).code;
    const listed = await json<{ code: string; hotel: { code: string } }[]>(
      await r.get('/api/admin/finance/billing/agreements'),
    );
    const a1 = listed.find((a) => a.hotel.code === hotels[0]!.code)!.code;
    expect(a1).toMatch(/^BA-\d+$/);
    // H2 and H3 share the en payer; H3 has no own price (default list); H4 the de payer.
    const a2 = await agreement(hotels[1]!.code, en.id, 7, '333.33', 30);
    const a3 = await agreement(hotels[2]!.code, en.id, 9, null, 21);
    const a4 = await agreement(hotels[3]!.code, de.id, 5, '2199.99', 10);
    const mine = [a1, a2, a3, a4];
    const expected: Record<string, { rooms: number; price: string; days: number; payer: string }> =
      {
        [a1]: { rooms: 12, price: '1000.50', days: 14, payer: cs.code },
        [a2]: { rooms: 7, price: '333.33', days: 30, payer: en.code },
        [a3]: { rooms: 9, price: '777.77', days: 21, payer: en.code },
        [a4]: { rooms: 5, price: '2199.99', days: 10, payer: de.code },
      };
    // The first agreement's payment terms: the form's default must be what was saved.
    const detail1 = await json<{ versions: { paymentTermsDays: number }[] }>(
      await r.get(`/api/admin/finance/billing/agreements/${a1}`),
    );
    const days1 = detail1.versions[0]!.paymentTermsDays;
    expected[a1]!.days = days1;

    // --- run settings through the form, then the plan of 2026-10 leads to the run
    await page.goto('/finance/invoices/run');
    const settings = page.getByTestId('run-settings-form');
    await settings.getByTestId('run-settings-day').fill('1');
    await settings.getByTestId('run-settings-advance').selectOption('ISSUE_MONTH');
    await settings.getByTestId('run-settings-arrears').selectOption('PREVIOUS_MONTH');
    await settings.getByTestId('run-settings-reason').fill(`${LABEL}: jako UOL (syntetické)`);
    const before = await page
      .getByTestId('run-settings-current')
      .innerText()
      .catch(() => '');
    await settings.getByTestId('run-settings-save').click();
    await expect.poll(() => page.getByTestId('run-settings-current').innerText()).not.toBe(before);
    await page.getByTestId('run-plan-month').fill('2026-10');
    await page.getByTestId('run-plan-load').click();
    await expect(page.getByTestId('run-plan-ADVANCE')).toContainText('2026-10-01');
    await page.getByTestId('run-plan-ADVANCE').click();
    await expect(page.getByTestId('run-month')).toHaveValue('2026-10');
    await page.getByTestId('run-load').click();
    await expect(page.getByTestId('run-issued-on')).toHaveValue('2026-10-01');
    for (const code of mine) {
      await expect(page.getByTestId(`run-item-${code}`)).toBeVisible();
      await page.getByTestId(`run-choose-${code}`).check();
    }
    await shots(page, 'smoke-run');
    await page.getByTestId('run-submit').click();
    const done = page.getByTestId('run-done');
    await expect(done).toBeVisible({ timeout: 30_000 });
    await expect(done.getByRole('link')).toHaveCount(4);

    // --- each invoice: exact arithmetic, due date from the agreement, payer, language, PDF, QR data
    const all = await json<(Invoice & { hotels: { code: string }[] })[]>(
      await r.get('/api/admin/finance/invoices'),
    );
    const october: Record<string, Invoice> = {};
    const languageOf: Record<string, string> = {
      [cs.code]: 'cs',
      [en.code]: 'en',
      [de.code]: 'de',
    };
    const pdfName: Record<string, string> = { cs: 'faktura', en: 'invoice', de: 'rechnung' };
    for (const code of mine) {
      const s = all.find(
        (i) =>
          i.period === '2026-10' &&
          i.status === 'VALID' &&
          i.hotels.some((h) => h.code === hotels[mine.indexOf(code)]!.code),
      )!;
      const inv = await json<Invoice>(await r.get(`/api/admin/finance/invoices/${s.number}`));
      const e = expected[code]!;
      expect(inv.lines).toHaveLength(1);
      expect(inv.lines[0]!.agreementCode).toBe(code);
      expect(inv.lines[0]!.billedRooms).toBe(e.rooms);
      expect(inv.lines[0]!.unitPrice).toBe(e.price);
      const total = cents(e.price) * BigInt(e.rooms);
      expect(inv.lines[0]!.amount).toBe(money(total));
      expect(inv.total).toBe(money(total));
      expect(inv.issuedOn).toBe('2026-10-01');
      expect(inv.dueOn).toBe(plusDays('2026-10-01', e.days));
      expect(inv.customer.code).toBe(e.payer);
      expect(inv.documentLanguage).toBe(languageOf[e.payer]);
      expect(inv.payment.amount).toBe(inv.total);
      expect(inv.payment.variableSymbol).toBe(inv.variableSymbol);
      expect(inv.payment.dueOn).toBe(inv.dueOn);
      expect(inv.payment.iban).toMatch(/^CZ\d{22}$/);
      const pdf = await r.get(`/api/admin/finance/invoices/${inv.number}/pdf`);
      expect(pdf.headers()['content-disposition']).toContain(
        `${pdfName[inv.documentLanguage]}-${inv.number}.pdf`,
      );
      const bytes = await pdf.body();
      expect(bytes.subarray(0, 5).toString()).toBe('%PDF-');
      const digest = Buffer.from(await crypto.subtle.digest('SHA-256', new Uint8Array(bytes)));
      expect(digest.toString('hex')).toBe(inv.pdfSha256);
      october[code] = inv;
    }

    // --- repeating the run: the same request replays, a new one is refused; the preview says so
    const preview = await json<{ items: PreviewItem[] }>(
      await r.get('/api/admin/finance/invoices/test-run/preview?month=2026-10'),
    );
    for (const code of mine)
      expect(preview.items.find((i) => i.agreementCode === code)).toMatchObject({
        state: 'ALREADY_INVOICED',
        invoiceNumber: october[code]!.number,
      });
    const lines = (items: PreviewItem[], codes: string[]) =>
      codes.map((code) => {
        const i = items.find((x) => x.agreementCode === code)!;
        return {
          agreementCode: code,
          agreementRevision: i.agreementRevision!,
          customerVersion: i.customer!.version,
          priceListVersionId: i.price.priceListVersionId,
          unitPrice: i.price.perRoomMonth!,
          billedRooms: i.billedRooms!,
        };
      });
    const again = await r.post('/api/admin/finance/invoices/test-run', {
      data: {
        requestId: crypto.randomUUID(),
        month: '2026-10',
        issuedOn: '2026-10-01',
        lines: lines(preview.items, [a1]),
      },
    });
    expect(again.status()).toBe(409);
    expect(((await again.json()) as Json).code).toBe('ALREADY_INVOICED');

    // November for H1 and H2 (API), replayed with the same request id: the same invoices.
    const nov = await json<{ items: PreviewItem[] }>(
      await r.get('/api/admin/finance/invoices/test-run/preview?month=2026-11'),
    );
    const novBody = {
      requestId: crypto.randomUUID(),
      month: '2026-11',
      issuedOn: '2026-11-01',
      lines: lines(nov.items, [a1, a2]),
    };
    const novRun = await json<{ invoices: { agreementCode: string; number: string }[] }>(
      await r.post('/api/admin/finance/invoices/test-run', { data: novBody }),
    );
    const replay = await json<{ invoices: { agreementCode: string; number: string }[] }>(
      await r.post('/api/admin/finance/invoices/test-run', { data: novBody }),
    );
    expect(replay.invoices).toEqual(novRun.invoices);
    const novH1 = novRun.invoices.find((i) => i.agreementCode === a1)!.number;
    const novH2 = novRun.invoices.find((i) => i.agreementCode === a2)!.number;

    // A cancelled invoice frees its month: one valid invoice per agreement and month, still.
    await json(
      await r.post(`/api/admin/finance/invoices/${novH2}/cancel`, {
        data: { requestId: crypto.randomUUID(), reason: `${LABEL}: zrušení (syntetické)` },
      }),
    );
    const nov2 = await json<{ items: PreviewItem[] }>(
      await r.get('/api/admin/finance/invoices/test-run/preview?month=2026-11'),
    );
    expect(nov2.items.find((i) => i.agreementCode === a2)!.state).toBe('READY');
    const reissued = await json<{ invoices: { number: string }[] }>(
      await r.post('/api/admin/finance/invoices/test-run', {
        data: {
          requestId: crypto.randomUUID(),
          month: '2026-11',
          issuedOn: '2026-11-01',
          lines: lines(nov2.items, [a2]),
        },
      }),
    );
    expect(reissued.invoices[0]!.number).not.toBe(novH2);

    // --- simulated sending (UI) and a replayed request (API): one delivery
    const first = october[a1]!;
    await page.goto(`/finance/invoices/${first.number}`);
    const delivery = page.getByTestId('invoice-delivery');
    await expect(delivery.getByTestId('delivery-mode-SIMULATION')).toBeVisible();
    await page.getByTestId('delivery-send').click();
    await expect(delivery.getByTestId('delivery-SENT')).toBeVisible({ timeout: 30_000 });
    await expect(delivery.getByTestId('delivery-SENT')).toContainText('žádný e-mail neodešel');
    const sendBody = {
      requestId: crypto.randomUUID(),
      recipient: `payer-de-${run.toLowerCase()}@smoke.test`,
      mode: 'SIMULATION',
    };
    const deInvoice = october[a4]!;
    await json(
      await r.post(`/api/admin/finance/invoices/${deInvoice.number}/deliveries`, {
        data: sendBody,
      }),
    );
    const sentTwice = await r.post(`/api/admin/finance/invoices/${deInvoice.number}/deliveries`, {
      data: sendBody,
    });
    expect(sentTwice.ok()).toBe(true);
    const deliveries = await json<{ deliveries: unknown[] }>(
      await r.get(`/api/admin/finance/invoices/${deInvoice.number}/deliveries`),
    );
    expect(deliveries.deliveries).toHaveLength(1);
    const other = await r.post(`/api/admin/finance/invoices/${deInvoice.number}/deliveries`, {
      data: { ...sendBody, requestId: crypto.randomUUID() },
    });
    expect(other.status(), 'a second first sending is refused').toBe(409);

    // --- payments
    const overviewBefore = await json<{ paymentsToReview: number }>(
      await r.get('/api/admin/finance/invoices/overview'),
    );
    // Full payment of H1 October through the form; the Czech decimal comma is the finding SMOKE-1.
    await page.goto('/finance/payments');
    await page.getByTestId('payments-simulation').locator('summary').click();
    const sim = page.getByTestId('simulate-statement');
    await sim.getByTestId('simulate-row-1').locator('input').first().fill(`SMK-${run}-FULL`);
    await sim.getByTestId('simulate-amount-1').fill(first.total);
    await sim.getByTestId('simulate-vs-1').fill(first.variableSymbol);
    await sim.getByTestId('simulate-submit').click();
    await expect(sim.getByTestId('simulate-result')).toBeVisible({ timeout: 20_000 });

    const simulate = async (
      entries: {
        ref: string;
        amount: string;
        vs: string | null;
        bookedOn: string;
        currency?: string;
      }[],
      requestId: string = crypto.randomUUID(),
    ) =>
      json<{
        created: string[];
        alreadyLoaded: number;
        matched: number;
        toReview: number;
        otherIncome?: number;
      }>(
        await r.post('/api/admin/finance/payments/simulate', {
          data: {
            requestId,
            entries: entries.map((e) => ({
              reference: `SMK-${run}-${e.ref}`,
              amount: e.amount,
              currency: e.currency ?? 'CZK',
              variableSymbol: e.vs,
              bookedOn: e.bookedOn,
              counterpartyName: `${tag} (syntetický plátce)`,
              message: null,
            })),
          },
        }),
      );
    const h2 = october[a2]!;
    const h3 = october[a3]!;
    const h4 = october[a4]!;
    const half = cents(h2.total) / 2n;
    const novH1Invoice = await json<Invoice>(await r.get(`/api/admin/finance/invoices/${novH1}`));
    const cancelled = await json<Invoice>(await r.get(`/api/admin/finance/invoices/${novH2}`));
    const statementId = crypto.randomUUID();
    const statement: {
      ref: string;
      amount: string;
      vs: string | null;
      bookedOn: string;
      currency?: string;
    }[] = [
      { ref: 'PART', amount: money(half), vs: h2.variableSymbol, bookedOn: '2026-10-05' },
      {
        ref: 'OVER',
        amount: money(cents(h3.total) + 10000n),
        vs: h3.variableSymbol,
        bookedOn: '2026-10-06',
      },
      { ref: 'NOVS', amount: h4.total, vs: null, bookedOn: '2026-10-07' },
      { ref: 'BADVS', amount: '150.00', vs: '9999999999', bookedOn: '2026-10-07' },
      { ref: 'OTHER', amount: '42.00', vs: null, bookedOn: '2026-10-08' },
      // Booked before the November invoice of H1 was issued (2026-11-01).
      {
        ref: 'EARLY',
        amount: novH1Invoice.total,
        vs: novH1Invoice.variableSymbol,
        bookedOn: '2026-10-20',
      },
      {
        ref: 'EUR',
        amount: '10.00',
        vs: h2.variableSymbol,
        bookedOn: '2026-10-09',
        currency: 'EUR',
      },
      {
        ref: 'CANC',
        amount: cancelled.total,
        vs: cancelled.variableSymbol,
        bookedOn: '2026-11-02',
      },
    ];
    const loaded = await simulate(statement, statementId);
    expect(loaded.created).toHaveLength(statement.length);
    // The same request replays; the same entries in a new request are never counted again.
    expect((await simulate(statement, statementId)).created).toEqual(loaded.created);
    const reloaded = await simulate(statement);
    expect(reloaded.created).toHaveLength(0);
    expect(reloaded.alreadyLoaded).toBe(statement.length);

    const payments = await json<{ payments: (Payment & { reference: string })[] }>(
      await r.get(`/api/admin/finance/payments?q=${encodeURIComponent(tag)}&pageSize=100`),
    );
    const pay = (ref: string) =>
      payments.payments.find((p) => p.reference === `SMK-${run}-${ref}`)!;
    expect(pay('PART')).toMatchObject({
      matchResult: 'MATCHED',
      state: 'ALLOCATED',
      toReview: false,
    });
    expect(pay('OVER')).toMatchObject({
      matchResult: 'PARTIAL_OVERPAYMENT',
      unallocated: '100.00',
      toReview: true,
    });
    expect(pay('NOVS')).toMatchObject({
      matchResult: 'NO_VARIABLE_SYMBOL',
      state: 'UNALLOCATED',
      toReview: false,
    });
    expect(pay('BADVS')).toMatchObject({ matchResult: 'UNKNOWN_VARIABLE_SYMBOL', toReview: false });
    expect(pay('OTHER')).toMatchObject({ matchResult: 'NO_VARIABLE_SYMBOL', toReview: false });
    expect(pay('EARLY')).toMatchObject({
      matchResult: 'PAID_BEFORE_ISSUE',
      state: 'UNALLOCATED',
      toReview: true,
    });
    expect(pay('EUR')).toMatchObject({
      matchResult: 'CURRENCY_MISMATCH',
      state: 'UNALLOCATED',
      toReview: true,
    });
    expect(pay('CANC')).toMatchObject({
      matchResult: 'INVOICE_CANCELLED',
      state: 'UNALLOCATED',
      toReview: true,
    });

    const stateOf = async (number: string) =>
      (await json<Invoice>(await r.get(`/api/admin/finance/invoices/${number}`))).paymentState;
    expect(await stateOf(first.number)).toMatchObject({ state: 'PAID', remaining: '0.00' });
    expect(await stateOf(h2.number)).toMatchObject({
      state: 'PARTIALLY_PAID',
      paid: money(half),
      remaining: money(cents(h2.total) - half),
    });
    expect(await stateOf(h3.number)).toMatchObject({ state: 'PAID', remaining: '0.00' });
    expect(await stateOf(novH1)).toMatchObject({ state: 'UNPAID', paid: '0.00' });

    // The rest of H2 (doplatek) settles it exactly.
    const rest = await simulate([
      {
        ref: 'REST',
        amount: money(cents(h2.total) - half),
        vs: h2.variableSymbol,
        bookedOn: '2026-10-25',
      },
    ]);
    expect(rest.matched).toBe(1);
    expect(await stateOf(h2.number)).toMatchObject({ state: 'PAID', remaining: '0.00' });

    // The payment without a VS, allocated by hand with a reason (UI). Czech comma: SMOKE-1.
    await page.goto(`/finance/payments/${pay('NOVS').code}`);
    const alloc = page.getByTestId(`allocate-${pay('NOVS').code}`);
    await alloc.locator('select').selectOption(h4.number);
    const amountInput = alloc.locator('input[inputmode=decimal]');
    await amountInput.fill(h4.total.replace('.', ','));
    await alloc.getByTestId(`allocate-${pay('NOVS').code}-reason`).fill(`${LABEL}: platba bez VS`);
    await alloc.getByTestId(`allocate-${pay('NOVS').code}-submit`).click();
    const commaRefused = await alloc
      .getByRole('alert')
      .waitFor({ timeout: 10_000 })
      .then(() => true)
      .catch(() => false);
    test.info().annotations.push({
      type: 'SMOKE-1',
      description: commaRefused
        ? 'manual allocation refuses the Czech decimal comma (the agreement form accepts it)'
        : 'manual allocation accepted the Czech decimal comma',
    });
    if (commaRefused) {
      await expect(alloc.getByRole('alert')).toContainText('tečka');
      await amountInput.fill(h4.total);
      await alloc.getByTestId(`allocate-${pay('NOVS').code}-submit`).click();
    }
    await expect
      .poll(async () => (await stateOf(h4.number)).state, { timeout: 15_000 })
      .toBe('PAID');
    await shots(page, 'smoke-payment');

    // An allocation that would exceed the invoice is refused, nothing written.
    const tooMuch = await r.post(`/api/admin/finance/payments/${pay('BADVS').code}/allocations`, {
      data: {
        requestId: crypto.randomUUID(),
        invoiceNumber: h4.number,
        amount: '150.00',
        reason: 'příliš',
      },
    });
    expect(tooMuch.ok(), 'H4 is paid: no more may be allocated').toBe(false);

    // Unrelated income created no task: the overview counts only hotel invoices' payments.
    const overview = await json<{
      invoices: {
        currency: string;
        open: { count: number; remaining: string };
        overdue: { count: number; remaining: string };
      }[];
      paymentsToReview: number;
    }>(await r.get('/api/admin/finance/invoices/overview'));
    // OVER, EARLY, EUR, CANC are to review; FULL, PART, REST, NOVS (allocated), BADVS, OTHER are not.
    expect(overview.paymentsToReview - overviewBefore.paymentsToReview).toBe(4);
    const review = await json<{ total: number }>(
      await r.get('/api/admin/finance/payments?filter=REVIEW&pageSize=1'),
    );
    expect(review.total, 'overview = the REVIEW list').toBe(overview.paymentsToReview);
    const invoicesNow = await json<Invoice[]>(await r.get('/api/admin/finance/invoices'));
    const open = invoicesNow.filter(
      (i) => i.status === 'VALID' && i.currency === 'CZK' && cents(i.paymentState.remaining) > 0n,
    );
    const czk = overview.invoices.find((x) => x.currency === 'CZK')!;
    expect(czk.open.count, 'overview = the list of invoices').toBe(open.length);
    expect(czk.open.remaining).toBe(
      money(open.reduce((s, i) => s + cents(i.paymentState.remaining), 0n)),
    );
    const overdue = open.filter((i) => i.paymentState.overdue);
    expect(czk.overdue.count).toBe(overdue.length);
    await page.goto('/finance');
    await shots(page, 'smoke-overview');

    // --- the payer's later language change never changes the issued PDF
    const deDetail = await json<{ current: { version: number; customer: Json } }>(
      await r.get(`/api/admin/finance/billing/customers/${de.code}`),
    );
    const pdfBefore = await (await r.get(`/api/admin/finance/invoices/${h4.number}/pdf`)).body();
    await json(
      await r.post(`/api/admin/finance/billing/customers/${de.code}/versions`, {
        data: {
          requestId: crypto.randomUUID(),
          expectedVersion: deDetail.current.version,
          customer: { ...deDetail.current.customer, documentLanguage: 'en' },
          reason: `${LABEL}: změna jazyka (syntetická)`,
        },
      }),
    );
    const pdfAfter = await (await r.get(`/api/admin/finance/invoices/${h4.number}/pdf`)).body();
    expect(pdfAfter.equals(pdfBefore)).toBe(true);
    expect(
      (await json<Invoice>(await r.get(`/api/admin/finance/invoices/${h4.number}`)))
        .documentLanguage,
    ).toBe('de');

    // --- back links: the invoice → the agreement → the hotel card with its invoices
    await page.goto(`/finance/invoices/${h2.number}`);
    await expect(page.getByTestId('invoice-payment-state')).toContainText('Uhrazeno');
    await shots(page, 'smoke-invoice');
    await page.getByRole('link', { name: a2 }).first().click();
    await page.getByTestId('agreement-hotel').click();
    await expect(page).toHaveURL(new RegExp(`/hotels/${hotels[1]!.code}#fakturace$`));
    const panel = page.getByTestId('hotel-billing');
    await expect(panel).toContainText(h2.number);
    await shots(page, 'smoke-hotel');

    // --- a missing issue date blocks the run visibly
    await page.goto('/finance/invoices/run');
    await page.getByTestId('run-month').fill('2026-12');
    await page.getByTestId('run-load').click();
    await page.getByTestId(`run-choose-${a3}`).check();
    await expect(page.getByTestId('run-need-date')).toBeVisible();
    await expect(page.getByTestId('run-submit')).toBeDisabled();

    test.info().annotations.push({
      type: 'codes',
      description: JSON.stringify({
        hotels: hotels.map((h) => h.code),
        payers: [cs.code, en.code, de.code],
        agreements: mine,
        october: mine.map((c) => october[c]!.number),
        november: { h1: novH1, h2Cancelled: novH2, h2: reissued.invoices[0]!.number },
      }),
    });
  });
});
