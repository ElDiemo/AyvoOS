import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import { startFinance, withFinanceDown } from './finance-control';

const ADMIN_STATE = 'e2e/.auth/admin.json';
const INITIAL_SITE_ID = '01990000-0000-7000-8000-000000000001';

/**
 * The integration snapshot's whole path, synthetic data, simulated mail and bank only: hotel → payer
 * and contract → TEST invoice and its PDF in Czech, English and German → simulated sending → payment
 * and back, then the issued PDF after a payer's change and an outage of Finance. Links are followed
 * by the keyboard where the path leads through them.
 */
const screenshots = resolve(import.meta.dirname, '../../../docs/screenshots/finance');
const financeReady = async (request: APIRequestContext) =>
  (await request.get('/api/admin/finance/health/ready').catch(() => null))?.status() ?? 0;

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
/** The last column of the lines is reached on a phone: scrolled by a gesture, and from the keyboard. */
async function lastColumnReached(page: Page, width: number, height: number) {
  await page.setViewportSize({ width, height });
  const table = page.getByTestId('invoice-lines');
  const scroller = table.locator('xpath=..');
  const amount = table.locator('tbody tr').first().locator('td').last();
  const fits = async () => {
    // Inside what the scroller shows, which is narrower than the window, and inside the window.
    const box = (await amount.boundingBox())!;
    const shown = (await scroller.boundingBox())!;
    const right = box.x + box.width;
    return box.x >= shown.x - 1 && right <= shown.x + shown.width + 1 && right <= width + 1;
  };
  const left = () => scroller.evaluate((e) => e.scrollLeft);
  const overflowing = await scroller.evaluate((e) => e.scrollWidth > e.clientWidth);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  if (overflowing) {
    expect(await fits(), `the amount starts cut off at ${width}`).toBe(false);
    await table.scrollIntoViewIfNeeded();
    await table.hover();
    await page.mouse.wheel(2000, 0);
    await expect.poll(fits, `a gesture at ${width}`).toBe(true);
    await scroller.evaluate((e) => (e.scrollLeft = 0));
    await table.locator('a').first().focus();
    for (let i = 0; i < 20; i++) await page.keyboard.press('ArrowRight');
    await expect.poll(left, `arrow keys at ${width}`).toBeGreaterThan(0);
    await expect.poll(fits, `arrow keys reach the end at ${width}`).toBe(true);
  } else expect(await fits()).toBe(true);
  await page.setViewportSize({ width: 1440, height: 900 });
}
const follow = async (page: Page, link: ReturnType<Page['getByTestId']>) => {
  await link.focus();
  await page.keyboard.press('Enter');
};

const LANGUAGES = [
  { code: 'cs', month: '2026-03', pdf: 'faktura', shown: 'čeština' },
  { code: 'en', month: '2026-04', pdf: 'invoice', shown: 'angličtina' },
  { code: 'de', month: '2026-05', pdf: 'rechnung', shown: 'němčina' },
] as const;

test.describe('Celý průchod', () => {
  test.use({ storageState: ADMIN_STATE });
  // Each language starts with a running Finance, whatever happened in the one before.
  test.beforeEach(startFinance);

  for (const language of LANGUAGES) {
    test(`hotel → payer and contract → ${language.code} TEST PDF → simulated sending → payment and back; PDF unchanged; Finance down`, async ({
      page,
      request,
    }) => {
      test.setTimeout(240_000);
      const r = page.request;
      const run = crypto.randomUUID().slice(0, 6).toUpperCase();
      const hotelName = `Hotel Průchod ${language.code} ${run}`;
      const payer = `Plátce ${language.code} ${run} s.r.o.`;
      const hotelRes = await r.post('/api/admin/hotels', {
        data: {
          requestId: crypto.randomUUID(),
          name: hotelName,
          addressLine1: 'Ukázková 1',
          addressLine2: null,
          postalCode: '602 00',
          city: 'Brno',
          countryCode: 'CZ',
          contactName: 'Recepce',
          contactPhone: '+420 500 000 044',
          contactEmail: 'recepce@pruchod.test',
          fulfillmentSiteId: INITIAL_SITE_ID,
        },
      });
      expect(hotelRes.ok(), await hotelRes.text()).toBe(true);
      const hotel = (await hotelRes.json()) as { code: string };

      // Hotel → the contract form, by the keyboard, with this hotel chosen.
      await page.goto(`/hotels/${hotel.code}`);
      const panel = page.getByTestId('hotel-billing');
      await expect(panel.getByTestId('hotel-billing-none')).toBeVisible();
      await follow(page, panel.getByTestId('hotel-billing-create'));
      await expect(page).toHaveURL(/\/finance\/billing\?hotel=/);
      const form = page.getByTestId('agreement-new');
      await expect(form.locator('[name=hotelId] option:checked')).toContainText(hotelName);

      // The payer, created here, with an explicit language; the country is no hint.
      const customer = page.getByTestId('customer-new');
      await customer.locator('[name=legalName]').fill(payer);
      await customer.locator('[name=addressLine1]').fill('Ukázková 1');
      await customer.locator('[name=postalCode]').fill('602 00');
      await customer.locator('[name=city]').fill('Brno');
      await customer.locator('[name=countryCode]').selectOption('CZ');
      await customer.locator('[name=billingEmail]').fill(`fakturace-${run}@pruchod.test`);
      await expect(customer.locator('[name=documentLanguage]')).toHaveValue('');
      await customer.locator('[name=documentLanguage]').selectOption(language.code);
      await customer.getByTestId('customer-save').click();
      await expect(customer.getByRole('status')).toHaveText('Uloženo.');
      await expect(form.locator('[name=hotelId] option:checked')).toContainText(hotelName);

      const option = await form
        .locator('[name=customerId] option', { hasText: payer })
        .first()
        .getAttribute('value');
      await form.locator('[name=customerId]').selectOption(option!);
      await form.locator('[name=billedRooms]').fill('12');
      await form.locator('[name=ownPrice]').fill('1 000,50');
      await form.locator('[name=effectiveFrom]').fill('2026-01');
      await form.locator('[name=validFrom]').fill('2026-01-01');
      await form.locator('[name=reason]').fill('Smlouva (syntetická)');
      await form.getByTestId('agreement-save').click();
      await expect(form.getByRole('status')).toHaveText('Uloženo.');

      // The card now says what Finance says.
      await page.goto(`/hotels/${hotel.code}`);
      await expect(panel.getByTestId('hotel-billing-payer')).toHaveText(payer);
      await expect(panel.getByTestId('hotel-billing-rooms')).toHaveText('12');
      const agreementCode = await panel.getByTestId('hotel-billing-agreement').innerText();

      // A TEST invoice from the monthly run.
      await page.goto('/finance/invoices/run');
      await page.getByTestId('run-month').fill(language.month);
      await page.getByTestId('run-load').click();
      await page.getByTestId(`run-choose-${agreementCode}`).check();
      await page.getByTestId('run-issued-on').fill(`${language.month}-28`);
      await page.getByTestId('run-submit').click();
      const done = page.getByTestId('run-done');
      await expect(done).toBeVisible({ timeout: 20_000 });
      const number = await done.getByRole('link').first().innerText();
      await done.getByRole('link').first().focus();
      await page.keyboard.press('Enter');
      await expect(page).toHaveURL(new RegExp(`/finance/invoices/${number}$`));
      await lastColumnReached(page, 390, 844);
      await lastColumnReached(page, 320, 700);
      await expect(page.getByTestId('invoice-language')).toHaveText(language.shown);

      // The PDF in its language, exactly the stored bytes.
      const invoice = (await (await r.get(`/api/admin/finance/invoices/${number}`)).json()) as {
        pdfSha256: string;
        total: string;
        variableSymbol: string;
        customer: { code: string; legalName: string };
        documentLanguage: string;
      };
      expect(invoice.documentLanguage).toBe(language.code);
      const pdf = await r.get(`/api/admin/finance/invoices/${number}/pdf`);
      expect(pdf.ok()).toBe(true);
      expect(pdf.headers()['content-disposition']).toContain(`${language.pdf}-${number}.pdf`);
      const bytes = await pdf.body();
      expect(bytes.subarray(0, 5).toString()).toBe('%PDF-');
      const digest = await crypto.subtle.digest('SHA-256', new Uint8Array(bytes));
      expect(Buffer.from(digest).toString('hex')).toBe(invoice.pdfSha256);

      // Simulated sending: the attempt says so, here and in the list.
      const delivery = page.getByTestId('invoice-delivery');
      await expect(delivery.getByTestId('delivery-mode-SIMULATION')).toBeVisible();
      await page.getByTestId('delivery-send').focus();
      await page.keyboard.press('Enter');
      await expect(delivery.getByTestId('delivery-SENT')).toBeVisible({ timeout: 20_000 });
      await expect(delivery.getByTestId('delivery-SENT')).toContainText('žádný e-mail neodešel');
      await expect(delivery.getByTestId('delivery-attempt-mode-SIMULATION')).toBeVisible();
      if (language.code === 'cs') await shots(page, 'integration-invoice');
      await page.goto('/finance/invoices');
      await expect(page.getByTestId(`invoice-delivery-${number}`)).toContainText(
        'Přijato simulací',
      );

      // A payment from the simulated statement: found, opened, leads to the invoice.
      const reference = `WALK-${run}`;
      const simulated = await r.post('/api/admin/finance/payments/simulate', {
        data: {
          requestId: crypto.randomUUID(),
          entries: [
            {
              reference,
              amount: invoice.total,
              currency: 'CZK',
              variableSymbol: invoice.variableSymbol,
              bookedOn: `${language.month}-28`,
              counterpartyName: payer,
              message: null,
            },
          ],
        },
      });
      expect(simulated.ok(), await simulated.text()).toBe(true);
      await page.goto('/finance/payments');
      await page.getByTestId('payments-q').fill(payer);
      await page.keyboard.press('Enter');
      await expect(page).toHaveURL(/q=/);
      const row = page.getByTestId('payments').locator('li[data-testid^="payment-PP-"]');
      await expect(row).toHaveCount(1);
      await row.getByRole('link').first().focus();
      await page.keyboard.press('Enter');
      await expect(page).toHaveURL(/\/finance\/payments\/PP-\d+$/);
      await page.getByRole('link', { name: number }).first().click();
      await expect(page).toHaveURL(new RegExp(`/finance/invoices/${number}$`));
      await expect(page.getByTestId('invoice-payment-state')).toContainText('Uhrazeno');

      // Back to the hotel: the same invoice, paid.
      await page
        .getByRole('link', { name: /BA-\d+/ })
        .first()
        .click();
      await page.getByTestId('agreement-hotel').click();
      await expect(page).toHaveURL(new RegExp(`/hotels/${hotel.code}#fakturace$`));
      await expect(panel).toContainText(number);
      await expect(panel).toContainText('Uhrazeno');
      if (language.code === 'cs') await shots(page, 'integration-hotel');

      // The issued PDF does not follow a later change of the payer or their language.
      const c = (await (
        await r.get(`/api/admin/finance/billing/customers/${invoice.customer.code}`)
      ).json()) as { current: { version: number; customer: Record<string, unknown> } };
      const changed = await r.post(
        `/api/admin/finance/billing/customers/${invoice.customer.code}/versions`,
        {
          data: {
            requestId: crypto.randomUUID(),
            expectedVersion: c.current.version,
            customer: {
              ...c.current.customer,
              legalName: `${payer} (nový)`,
              documentLanguage: language.code === 'de' ? 'cs' : 'de',
            },
            reason: 'Změna údajů (test)',
          },
        },
      );
      expect(changed.ok(), await changed.text()).toBe(true);
      const later = await r.get(`/api/admin/finance/invoices/${number}/pdf`);
      expect((await later.body()).equals(bytes)).toBe(true);
      await page.goto(`/finance/invoices/${number}`);
      await expect(page.getByTestId('invoice-language')).toHaveText(language.shown);

      // Finance down: the hotel works and says only that billing is unavailable.
      expect(await financeReady(request)).toBe(200);
      await withFinanceDown(async () => {
        expect(await financeReady(request)).not.toBe(200);
        await page.goto(`/hotels/${hotel.code}`);
        await expect(page.getByRole('heading', { level: 1 })).toContainText(hotelName);
        await expect(panel).toContainText('Fakturace dočasně nedostupná');
        await expect(panel).not.toContainText('nemá fakturační podmínky');
      });
      expect(await financeReady(request)).toBe(200);
      await page.goto(`/hotels/${hotel.code}`);
      await expect(panel.getByTestId('hotel-billing-rooms')).toHaveText('12');
    });
  }
});
