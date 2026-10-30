import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { expect, test, type APIRequestContext } from '@playwright/test';
const ADMIN_STATE = 'e2e/.auth/admin.json';
const OPERATOR_STATE = 'e2e/.auth/operator.json';
const INITIAL_SITE_ID = '01990000-0000-7000-8000-000000000001';

/**
 * Měsíční běh testovacích faktur (doc 040 §11) with synthetic agreements: nothing is filled in, the
 * action stays disabled without a period, a choice and an issue date; a blocked agreement says why;
 * the result links to the invoices and a second run finds them invoiced. Nothing is sent anywhere.
 * Needs the issuer and a CZK default account (workflow-finance-issuer.spec.ts runs before).
 */
const screenshots = resolve(import.meta.dirname, '../../../docs/screenshots/finance');

type Res = Awaited<ReturnType<APIRequestContext['get']>>;
async function json<T>(res: Res): Promise<T> {
  expect(res.ok(), `${res.url()} -> ${res.status()} ${await res.text()}`).toBe(true);
  return (await res.json()) as T;
}

test.describe('Měsíční běh', () => {
  test.use({ storageState: ADMIN_STATE });

  test('period and date are stated by the user; only ready agreements are issued, once', async ({
    page,
  }) => {
    test.setTimeout(180_000);
    const r = page.request;
    const run = crypto.randomUUID().slice(0, 6).toUpperCase();
    const customer = await json<{ id: string }>(
      await r.post('/api/admin/finance/billing/customers', {
        data: {
          requestId: crypto.randomUUID(),
          customer: {
            legalName: `Běh ${run} s.r.o. (E2E)`,
            companyId: '44556677',
            vatId: null,
            addressLine1: 'Běhová 1',
            addressLine2: null,
            postalCode: '602 00',
            city: 'Brno',
            countryCode: 'CZ',
            billingEmail: 'fakturace@beh.test',
            documentLanguage: 'cs',
          },
        },
      }),
    );
    const agreement = async (name: string, over: Record<string, unknown>) => {
      const hotel = await json<{ code: string }>(
        await r.post('/api/admin/hotels', {
          data: {
            requestId: crypto.randomUUID(),
            name,
            addressLine1: 'Běhová 1',
            addressLine2: null,
            postalCode: '602 00',
            city: 'Brno',
            countryCode: 'CZ',
            contactName: 'Recepce',
            contactPhone: '+420 500 000 043',
            contactEmail: 'recepce@beh.test',
            fulfillmentSiteId: INITIAL_SITE_ID,
          },
        }),
      );
      const hotels = await json<{ id: string; code: string }[]>(
        await r.get('/api/admin/finance/billing/hotels'),
      );
      return json<{ code: string }>(
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
              reason: 'Smlouva (syntetická)',
              ...over,
            },
          },
        }),
      );
    };
    const ready = await agreement(`Hotel Běh A ${run}`, {});
    const second = await agreement(`Hotel Běh B ${run}`, {
      billedRooms: 5,
      ownPricePerRoomMonth: '100.50',
    });
    const partial = await agreement(`Hotel Běh C ${run}`, { validFrom: '2026-04-10' });

    await page.goto('/finance/invoices');
    await page.getByTestId('invoice-run').click();
    await expect(page).toHaveURL(/\/finance\/invoices\/run$/);
    await expect(page.getByRole('heading', { level: 1 })).toHaveText(
      'Měsíční běh testovacích faktur',
    );
    // Nothing is filled in; without a period nothing loads.
    await expect(page.getByTestId('run-month')).toHaveValue('');
    await expect(page.getByTestId('run-load')).toBeDisabled();
    await page.getByTestId('run-month').fill('2026-04');
    await page.getByTestId('run-load').click();

    const item = (code: string) => page.getByTestId(`run-item-${code}`);
    await expect(item(ready.code)).toHaveAttribute('data-state', 'READY');
    await expect(item(ready.code)).toContainText(`Běh ${run} s.r.o. (E2E)`);
    await expect(item(ready.code)).toContainText(
      '10 pokojů × 400,00 CZK (vlastní cena) = 4 000,00 CZK',
    );
    await expect(item(ready.code)).toContainText('zpětně · splatnost 14 dní');
    await expect(item(partial.code)).toHaveAttribute('data-state', 'BLOCKED');
    await expect(item(partial.code)).toContainText('pravidlo není schválené');
    await expect(page.getByTestId(`run-choose-${partial.code}`)).toBeDisabled();

    // Disabled without a choice and without a date.
    await expect(page.getByTestId('run-issued-on')).toHaveValue('');
    await expect(page.getByTestId('run-submit')).toBeDisabled();
    await page.getByTestId(`run-choose-${ready.code}`).check();
    await page.getByTestId(`run-choose-${second.code}`).check();
    await expect(page.getByTestId('run-need-date')).toBeVisible();
    await expect(page.getByTestId('run-submit')).toBeDisabled();
    await expect(page.getByTestId('run-total-CZK')).toHaveText('Celkem 4 502,50 CZK');

    await mkdir(screenshots, { recursive: true });
    for (const width of [1440, 390, 320]) {
      await page.setViewportSize({ width, height: 900 });
      expect(
        await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
        `no overflow at ${width}`,
      ).toBe(true);
      await page.screenshot({
        path: resolve(screenshots, `finance-run-${width}.png`),
        fullPage: true,
      });
    }
    await page.setViewportSize({ width: 1280, height: 900 });

    await page.getByTestId('run-issued-on').fill('2026-05-04');
    await page.getByTestId('run-submit').click();
    await expect(page.getByTestId('run-done')).toContainText('Vystaveno testovacích faktur: 2');
    // The preview now says they are invoiced; nothing left to choose for them.
    await expect(item(ready.code)).toHaveAttribute('data-state', 'ALREADY_INVOICED');
    await expect(page.getByTestId(`run-choose-${ready.code}`)).toBeDisabled();

    await page.getByTestId('run-done').getByRole('link').first().click();
    await expect(page).toHaveURL(/\/finance\/invoices\/T\d{4}-\d{5}$/);
    await expect(page.getByTestId('invoice-total')).toHaveText('4 000,00 CZK');
    await expect(page.locator('main')).toContainText('4. 5. 2026');
    await expect(page.locator('main')).toContainText('18. 5. 2026');
  });
});

test.describe('without the permissions of the run', () => {
  test.use({ storageState: OPERATOR_STATE });

  test('the page and its API are refused', async ({ page }) => {
    await page.goto('/finance/invoices/run');
    await expect(page).toHaveURL(/\/forbidden$/);
    expect(
      (
        await page.request.get('/api/admin/finance/invoices/test-run/preview?month=2026-04')
      ).status(),
    ).toBe(403);
  });
});
