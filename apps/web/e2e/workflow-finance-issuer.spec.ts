import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { expect, test } from '@playwright/test';
const ADMIN_STATE = 'e2e/.auth/admin.json';
const OPERATOR_STATE = 'e2e/.auth/operator.json';

/**
 * Finance → Naše firma a bankovní účty (N3A-2a, doc 040 §8) in the browser: what blocks a live
 * invoice, the issuer's details with history, an invoice bank account checked against its IBAN,
 * the default account for CZK; refused without the permission. Synthetic company and accounts only.
 */
const screenshots = resolve(import.meta.dirname, '../../../docs/screenshots/finance');

test.describe('Naše firma a bankovní účty', () => {
  test.use({ storageState: ADMIN_STATE });

  test('fill the issuer, add a checked account, choose the CZK default; readiness follows', async ({
    page,
  }) => {
    await page.goto('/finance/settings/company');
    await expect(
      page.getByRole('heading', { level: 1, name: 'Naše firma a bankovní účty' }),
    ).toBeVisible();
    const readiness = page.getByTestId('issuer-readiness');
    await expect(readiness).toContainText('chybí údaje vystavitele');

    const form = page.getByTestId('issuer-form');
    await form.locator('[name=legalName]').fill('Testovací vystavitel s.r.o. (syntetický)');
    await form.locator('[name=addressLine1]').fill('Testovací 1');
    await form.locator('[name=postalCode]').fill('110 00');
    await form.locator('[name=city]').fill('Praha');
    await form.locator('[name=companyId]').fill('12345678');
    await form.locator('[name=vatStatus]').selectOption('VAT_PAYER');
    await form.locator('[name=vatId]').fill('CZ12345678');
    await form.locator('[name=email]').fill('fakturace@vystavitel.test');
    await form.locator('[name=reason]').fill('První vyplnění (test)');
    await form.getByRole('button', { name: 'Uložit novou verzi' }).click();
    await expect(readiness).not.toContainText('chybí údaje vystavitele');
    await expect(readiness).toContainText('není zvolen výchozí účet');
    await expect(page.getByTestId('issuer-history')).toContainText('verze 1');

    await page.getByText('Přidat účet').click();
    const account = page.getByTestId('account-form-new');
    await account.locator('[name=label]').fill('Hlavní účet CZK (test)');
    await account.locator('[name=accountPrefix]').fill('19');
    await account.locator('[name=accountNumber]').fill('2000145399');
    await account.locator('[name=bankCode]').fill('0800');
    // A wrong IBAN is refused with the reason, nothing stored.
    await account.locator('[name=iban]').fill('CZ65 0800 0000 1920 0014 5398');
    await account.locator('[name=reason]').fill('Zřízení (test)');
    await account.getByRole('button', { name: 'Uložit' }).click();
    await expect(account.getByRole('alert')).toBeVisible();
    await account.locator('[name=iban]').fill('CZ65 0800 0000 1920 0014 5399');
    await account.getByRole('button', { name: 'Uložit' }).click();
    const accounts = page.getByTestId('issuer-accounts');
    await expect(accounts).toContainText('CZ6508000000192000145399');
    await expect(accounts).toContainText('19-2000145399/0800');

    const choose = page.getByTestId('default-form-CZK');
    await choose.locator('[name=reason]').fill('Hlavní účet (test)');
    await choose.getByRole('button', { name: 'Zvolit výchozí' }).click();
    await expect(readiness).toContainText('CZK: z tohoto nastavení nic nechybí.');
    await expect(page.getByTestId('issuer-defaults')).toContainText('CZK: IB-');

    await mkdir(screenshots, { recursive: true });
    for (const width of [1440, 390]) {
      await page.setViewportSize({ width, height: 900 });
      await page.goto('/finance/settings/company');
      expect(
        await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
      ).toBe(true);
      await page.screenshot({
        path: resolve(screenshots, `finance-company-${width}.png`),
        fullPage: true,
      });
    }
  });
});

/**
 * Testovací faktury (N3A-2b, doc 040 §9) right after the issuer and its CZK default exist above:
 * one customer with two hotels (agreements set through the billing API), a summary TEST invoice
 * chosen in the browser, its detail and stored PDF, then a cancellation with a reason.
 */
test.describe('Testovací faktury', () => {
  test.use({ storageState: ADMIN_STATE });

  test('a summary TEST invoice of one customer: chosen, issued with its PDF, then cancelled', async ({
    page,
  }) => {
    const request = page.request;
    const json = async <T>(r: Awaited<ReturnType<typeof request.get>>) => {
      expect(r.ok(), await r.text()).toBe(true);
      return (await r.json()) as T;
    };
    const me = await json<{ sites: { id: string; code: string }[] }>(
      await request.get('/api/auth/me'),
    );
    const siteId = me.sites.find((x) => x.code === 'CZ-PREROV-01')!.id;
    const customer = await json<{ id: string; code: string }>(
      await request.post('/api/admin/finance/billing/customers', {
        data: {
          requestId: crypto.randomUUID(),
          customer: {
            legalName: 'Testovací hotely s.r.o. (E2E)',
            companyId: '87654321',
            vatId: null,
            addressLine1: 'Hotelová 7',
            addressLine2: null,
            postalCode: '602 00',
            city: 'Brno',
            countryCode: 'CZ',
            billingEmail: 'fakturace@hotely.test',
          },
        },
      }),
    );
    const agreements: string[] = [];
    for (const [name, rooms, price] of [
      ['Hotel Faktura Sever (E2E)', 10, '300.00'],
      ['Hotel Faktura Jih (E2E)', 5, '1234.56'],
    ] as const) {
      const hotel = await json<{ code: string }>(
        await request.post('/api/admin/hotels', {
          data: {
            requestId: crypto.randomUUID(),
            name,
            addressLine1: 'Hotelová 7',
            addressLine2: null,
            postalCode: '602 00',
            city: 'Brno',
            countryCode: 'CZ',
            contactName: 'Recepce',
            contactPhone: '+420 500 000 000',
            contactEmail: 'recepce@hotely.test',
            fulfillmentSiteId: siteId,
          },
        }),
      );
      const hotels = await json<{ id: string; code: string }[]>(
        await request.get('/api/admin/finance/billing/hotels'),
      );
      const created = await json<{ code: string }>(
        await request.post('/api/admin/finance/billing/agreements', {
          data: {
            requestId: crypto.randomUUID(),
            hotelId: hotels.find((h) => h.code === hotel.code)!.id,
            terms: {
              effectiveFrom: '2026-01',
              customerId: customer.id,
              contractNumber: null,
              billedRooms: rooms,
              ownPricePerRoomMonth: price,
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
      agreements.push(created.code);
    }

    await page.goto('/finance/invoices');
    await expect(page.getByRole('heading', { level: 1, name: 'Faktury' })).toBeVisible();
    await page.getByTestId('invoice-new').click();
    const form = page.getByTestId('test-invoice-form');
    await form.getByTestId('invoice-month').fill('2026-09');
    await form.getByRole('button', { name: 'Načíst smlouvy' }).click();
    for (const code of agreements) await form.getByTestId(`invoice-agreement-${code}`).check();
    await expect(form.getByTestId('invoice-selection')).toHaveText(
      'Vybráno 2 – celkem 9 172,80 CZK',
    );
    await mkdir(screenshots, { recursive: true });
    for (const width of [1440, 390, 320]) {
      await page.setViewportSize({ width, height: 900 });
      expect(
        await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
      ).toBe(true);
      await page.screenshot({
        path: resolve(screenshots, `finance-invoice-new-${width}.png`),
        fullPage: true,
      });
    }
    await page.setViewportSize({ width: 1280, height: 900 });
    await form.getByTestId('invoice-issue').click();
    await expect(page).toHaveURL(/\/finance\/invoices\/T\d{4}-\d{5}$/);
    const detail = page.getByTestId('invoice-detail');
    await expect(detail.getByTestId('invoice-total')).toHaveText('9 172,80 CZK');
    await expect(detail.getByTestId('invoice-lines')).toContainText('Hotel Faktura Sever (E2E)');
    await expect(detail.getByTestId('invoice-lines')).toContainText('Hotel Faktura Jih (E2E)');
    const number = page.url().split('/').at(-1)!;
    const pdf = await request.get(`/api/admin/finance/invoices/${number}/pdf`);
    expect(pdf.headers()['content-type']).toContain('application/pdf');
    expect((await pdf.body()).subarray(0, 5).toString()).toBe('%PDF-');
    for (const width of [1440, 390, 320]) {
      await page.setViewportSize({ width, height: 900 });
      expect(
        await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
      ).toBe(true);
      await page.screenshot({
        path: resolve(screenshots, `finance-invoice-detail-${width}.png`),
        fullPage: true,
      });
    }
    await page.setViewportSize({ width: 1280, height: 900 });
    await detail.getByTestId('cancel-invoice-reason').fill('Ukázka zrušení (test)');
    await detail.getByTestId('cancel-invoice-submit').click();
    await expect(detail).toContainText('Zrušena: Ukázka zrušení (test)');
    await page.goto('/finance/invoices');
    await expect(page.getByTestId('invoices')).toContainText(number);
    await expect(page.getByTestId('invoices')).toContainText('Zrušená');
  });

  test('payments: a partial payment by VS, one without VS allocated by hand, the same statement loaded twice', async ({
    page,
  }) => {
    const request = page.request;
    const json = async <T>(r: Awaited<ReturnType<typeof request.get>>) => {
      expect(r.ok(), await r.text()).toBe(true);
      return (await r.json()) as T;
    };
    const me = await json<{ sites: { id: string; code: string }[] }>(
      await request.get('/api/auth/me'),
    );
    const siteId = me.sites.find((x) => x.code === 'CZ-PREROV-01')!.id;
    const customer = await json<{ id: string }>(
      await request.post('/api/admin/finance/billing/customers', {
        data: {
          requestId: crypto.randomUUID(),
          customer: {
            legalName: 'Platby s.r.o. (E2E)',
            companyId: '11223344',
            vatId: null,
            addressLine1: 'Platební 1',
            addressLine2: null,
            postalCode: '702 00',
            city: 'Ostrava',
            countryCode: 'CZ',
            billingEmail: 'fakturace@platby.test',
          },
        },
      }),
    );
    const hotel = await json<{ code: string }>(
      await request.post('/api/admin/hotels', {
        data: {
          requestId: crypto.randomUUID(),
          name: 'Hotel Platba (E2E)',
          addressLine1: 'Platební 1',
          addressLine2: null,
          postalCode: '702 00',
          city: 'Ostrava',
          countryCode: 'CZ',
          contactName: 'Recepce',
          contactPhone: '+420 500 000 001',
          contactEmail: 'recepce@platby.test',
          fulfillmentSiteId: siteId,
        },
      }),
    );
    const hotels = await json<{ id: string; code: string }[]>(
      await request.get('/api/admin/finance/billing/hotels'),
    );
    const agreement = await json<{ code: string }>(
      await request.post('/api/admin/finance/billing/agreements', {
        data: {
          requestId: crypto.randomUUID(),
          hotelId: hotels.find((h) => h.code === hotel.code)!.id,
          terms: {
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
            reason: 'Smlouva (syntetická)',
          },
        },
      }),
    );
    // Issued from the terms as loaded (what the form sends, review BILL86-R1).
    const shown = (
      await json<{
        items: {
          agreement: { code: string };
          version: { revision: number; billedRooms: number };
          customer: { version: number };
          price: { perRoomMonth: string; priceListVersionId: string | null };
        }[];
      }>(await request.get('/api/admin/finance/billing/agreements/effective?month=2026-09'))
    ).items.find((i) => i.agreement.code === agreement.code)!;
    const invoice = await json<{ number: string; variableSymbol: string }>(
      await request.post('/api/admin/finance/invoices/test', {
        data: {
          requestId: crypto.randomUUID(),
          month: '2026-09',
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
    );

    await page.goto('/finance/payments');
    const form = page.getByTestId('simulate-statement');
    await form.getByTestId('simulate-amount-1').fill('1000.00');
    await form.getByTestId('simulate-vs-1').fill(invoice.variableSymbol);
    await form.getByTestId('simulate-add').click();
    await form.getByTestId('simulate-amount-2').fill('3200.00');
    await form.getByTestId('simulate-submit').click();
    await expect(form.getByTestId('simulate-result')).toHaveText(
      'Nově zaznamenáno 2, už dříve načteno 0 (nezapočteno znovu). Spárováno 1, k posouzení 1.',
    );
    // The same statement again: nothing new, nothing counted twice.
    await form.getByTestId('simulate-submit').click();
    await expect(form.getByTestId('simulate-result')).toHaveText(
      'Nově zaznamenáno 0, už dříve načteno 2 (nezapočteno znovu). Spárováno 0, k posouzení 0.',
    );
    await page.goto(`/finance/invoices/${invoice.number}`);
    await expect(page.getByTestId('invoice-payment-state')).toHaveText('Částečně uhrazeno');

    await page.goto('/finance/payments');
    const unclear = page
      .getByTestId('payments')
      .locator('li[data-testid^="payment-PP-"]')
      .filter({ hasText: 'chybí variabilní symbol' })
      .first();
    const code = (await unclear.getAttribute('data-testid'))!.replace('payment-', '');
    await expect(page.getByTestId(`payment-${code}-suggestions`)).toContainText(invoice.number);
    await mkdir(screenshots, { recursive: true });
    for (const width of [1440, 390, 320]) {
      await page.setViewportSize({ width, height: 900 });
      expect(
        await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
      ).toBe(true);
      await page.screenshot({
        path: resolve(screenshots, `finance-payments-${width}.png`),
        fullPage: true,
      });
    }
    await page.setViewportSize({ width: 1280, height: 900 });
    const allocate = page.getByTestId(`allocate-${code}`);
    await allocate.getByTestId(`allocate-${code}-reason`).fill('Bez VS – ověřeno s hotelem (test)');
    await allocate.getByTestId(`allocate-${code}-submit`).click();
    await expect(page.getByTestId(`payment-${code}-state`)).toHaveText('přiřazeno');
    await page.goto(`/finance/invoices/${invoice.number}`);
    await expect(page.getByTestId('invoice-payment-state')).toHaveText('Uhrazeno');
    await expect(page.getByTestId('invoice-allocations')).toContainText('ručně');
    await expect(page.getByTestId('invoice-allocations')).toContainText('automaticky');
  });
});

/**
 * The whole billing chain as the owner will see it on DEV — only by clicking, from the main
 * navigation: two hotels of one company with different prices and a third hotel of another
 * company → their agreements → a separate and a summary TEST invoice → PDF with QR → a partial
 * simulated payment → an unclear payment allocated by hand → paid → the same statement again
 * changes nothing. Desktop and 390 px; screenshots for the review (demo-*.png).
 */
test.describe('Ukázka: řetězec fakturace', () => {
  test.use({ storageState: ADMIN_STATE });

  test('settings → separate and summary TEST invoices → partial and unclear payments → paid; a repeated import changes nothing', async ({
    page,
  }) => {
    test.setTimeout(240_000);
    const run = crypto.randomUUID().slice(0, 4).toUpperCase();
    const shot = async (name: string) => {
      await mkdir(screenshots, { recursive: true });
      for (const width of [1440, 390]) {
        await page.setViewportSize({ width, height: 900 });
        expect(
          await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
          `${name} ${width}`,
        ).toBe(true);
        await page.screenshot({
          path: resolve(screenshots, `demo-${name}-${width}.png`),
          fullPage: true,
        });
      }
      await page.setViewportSize({ width: 1280, height: 900 });
    };
    // Three synthetic hotels (hotels themselves are not part of billing).
    const me = (await (await page.request.get('/api/auth/me')).json()) as {
      sites: { id: string; code: string }[];
    };
    const siteId = me.sites.find((x) => x.code === 'CZ-PREROV-01')!.id;
    const hotel = async (name: string) =>
      (
        (await (
          await page.request.post('/api/admin/hotels', {
            data: {
              requestId: crypto.randomUUID(),
              name,
              addressLine1: 'Ukázková 1',
              addressLine2: null,
              postalCode: '110 00',
              city: 'Praha',
              countryCode: 'CZ',
              contactName: 'Recepce',
              contactPhone: '+420 500 000 010',
              contactEmail: 'recepce@ukazka.test',
              fulfillmentSiteId: siteId,
            },
          })
        ).json()) as { code: string }
      ).code;
    const [sever, jih, beta] = [`Hotel Sever ${run}`, `Hotel Jih ${run}`, `Beta Resort ${run}`];
    const codes = [await hotel(sever), await hotel(jih), await hotel(beta)];

    // --- Settings, by clicking from the main navigation.
    await page.goto('/');
    await page
      .getByRole('navigation', { name: 'Hlavní navigace' })
      .getByRole('link', { name: 'Finance' })
      .click();
    const finance = page.getByRole('navigation', { name: 'Finance' });
    await finance.getByRole('link', { name: 'Smlouvy hotelů', exact: true }).click();
    await expect(page.getByRole('heading', { level: 1, name: 'Smlouvy hotelů' })).toBeVisible();
    /** Opens a collapsible section unless it is open already (it stays open after a save). */
    const ensureOpen = async (summaryTestId: string) => {
      const details = page.locator('details', { has: page.getByTestId(summaryTestId) });
      if (!(await details.evaluate((d) => (d as HTMLDetailsElement).open)))
        await page.getByTestId(summaryTestId).click();
    };
    const newCustomer = async (name: string, ico: string) => {
      await ensureOpen('customer-new-open');
      const form = page.getByTestId('customer-new');
      await form.locator('[name=legalName]').fill(name);
      await form.locator('[name=companyId]').fill(ico);
      await form.locator('[name=addressLine1]').fill('Ukázková 1');
      await form.locator('[name=postalCode]').fill('110 00');
      await form.locator('[name=city]').fill('Praha');
      await form.locator('[name=billingEmail]').fill('fakturace@ukazka.test');
      await form.getByTestId('customer-save').click();
      await expect(form.getByRole('status')).toHaveText('Uloženo.');
      await expect(page.getByTestId('billing-customers')).toContainText(name);
    };
    await newCustomer(`Alfa Hotely ${run} s.r.o.`, '11111111');
    await newCustomer(`Beta Resort ${run} a.s.`, '22222222');
    const newAgreement = async (
      hotelName: string,
      hotelCode: string,
      payer: string,
      rooms: string,
      price: string,
    ) => {
      await ensureOpen('agreement-new-open');
      const form = page.getByTestId('agreement-new');
      await form.locator('[name=hotelId]').selectOption({ label: `${hotelName} (${hotelCode})` });
      const value = await form
        .locator('[name=customerId] option', { hasText: payer })
        .first()
        .getAttribute('value');
      await form.locator('[name=customerId]').selectOption(value!);
      await form.locator('[name=effectiveFrom]').fill('2026-09');
      await form.locator('[name=validFrom]').fill('2026-09-01');
      await form.locator('[name=billedRooms]').fill(rooms);
      await form.locator('[name=ownPrice]').fill(price);
      await form.locator('[name=reason]').fill('Smlouva podepsána (ukázka)');
      await form.getByTestId('agreement-save').click();
      return form;
    };
    // A validation error is shown in Czech and nothing is saved.
    const invalid = await newAgreement(sever, codes[0]!, `Alfa Hotely ${run}`, '0', '300.00');
    await expect(invalid.getByRole('alert')).toBeVisible();
    await invalid.locator('[name=billedRooms]').fill('10');
    await invalid.getByTestId('agreement-save').click();
    await expect(
      page.getByTestId('billing-agreements').locator('ul li', { hasText: sever }),
    ).toHaveCount(1);
    await newAgreement(jih, codes[1]!, `Alfa Hotely ${run}`, '5', '1234.56');
    await expect(
      page.getByTestId('billing-agreements').locator('ul li', { hasText: jih }),
    ).toHaveCount(1);
    await newAgreement(beta, codes[2]!, `Beta Resort ${run}`, '8', '500.00');
    await expect(
      page.getByTestId('billing-agreements').locator('ul li', { hasText: beta }),
    ).toHaveCount(1);
    await shot('1-smlouvy');

    // --- A separate invoice (the other company's hotel) and a summary (two hotels of Alfa).
    await finance.getByRole('link', { name: 'Faktury', exact: true }).click();
    const issue = async (hotels: string[]) => {
      await page.getByTestId('invoice-new').click();
      const form = page.getByTestId('test-invoice-form');
      await form.getByTestId('invoice-month').fill('2026-09');
      await form.getByRole('button', { name: 'Načíst smlouvy' }).click();
      for (const h of hotels)
        await form.locator('li', { hasText: h }).getByRole('checkbox').check();
      return form;
    };
    const separate = await issue([beta]);
    await expect(separate.getByTestId('invoice-selection')).toHaveText(
      'Vybráno 1 – celkem 4 000,00 CZK',
    );
    await separate.getByTestId('invoice-issue').click();
    await expect(page.getByTestId('invoice-total')).toHaveText('4 000,00 CZK');
    await finance.getByRole('link', { name: 'Faktury', exact: true }).click();
    const summary = await issue([sever, jih]);
    // Choosing another company's hotel starts a new choice: never two companies on one invoice.
    await summary.locator('li', { hasText: beta }).getByRole('checkbox').check({ force: true });
    await expect(summary.getByTestId('invoice-selection')).toHaveText(
      'Vybráno 1 – celkem 4 000,00 CZK',
    );
    await summary.locator('li', { hasText: sever }).getByRole('checkbox').check();
    await summary.locator('li', { hasText: jih }).getByRole('checkbox').check();
    await expect(summary.getByTestId('invoice-selection')).toHaveText(
      'Vybráno 2 – celkem 9 172,80 CZK',
    );
    await shot('2-vystaveni');
    await summary.getByTestId('invoice-issue').click();
    await expect(page.getByTestId('invoice-total')).toHaveText('9 172,80 CZK');
    await expect(page.getByTestId('invoice-payment-state')).toHaveText('Neuhrazeno');
    const number = page.url().split('/').at(-1)!;
    const vs = (await page
      .getByText(/^99\d{8}$/)
      .first()
      .textContent())!.trim();
    const pdf = await page.request.get(`/api/admin/finance/invoices/${number}/pdf`);
    expect((await pdf.body()).subarray(0, 5).toString()).toBe('%PDF-');
    await shot('3-faktura');
    // Issuing the same month again is refused with a Czech explanation.
    await finance.getByRole('link', { name: 'Faktury', exact: true }).click();
    const again = await issue([beta]);
    await again.getByTestId('invoice-issue').click();
    await expect(again.getByRole('alert')).toContainText('už má na tento měsíc platnou');

    // --- Payments: partial by VS, unclear without VS, allocated by hand, then the same again.
    await finance.getByRole('link', { name: 'Platby', exact: true }).click();
    const statement = page.getByTestId('simulate-statement');
    await statement.getByTestId('simulate-amount-1').fill('1000.00');
    await statement.getByTestId('simulate-vs-1').fill(vs);
    await statement.getByTestId('simulate-add').click();
    await statement.getByTestId('simulate-amount-2').fill('8172.80');
    await statement.getByTestId('simulate-submit').click();
    await expect(statement.getByTestId('simulate-result')).toHaveText(
      'Nově zaznamenáno 2, už dříve načteno 0 (nezapočteno znovu). Spárováno 1, k posouzení 1.',
    );
    const unclear = page
      .locator('li[data-testid^="payment-PP-"]')
      .filter({ hasText: '8 172,80 CZK' })
      .first();
    const code = (await unclear.getAttribute('data-testid'))!.replace('payment-', '');
    await expect(page.getByTestId(`payment-${code}-result`)).toHaveText(
      'k posouzení: chybí variabilní symbol',
    );
    await expect(page.getByTestId(`payment-${code}-suggestions`)).toContainText(number);
    await shot('4-platby');
    const allocate = page.getByTestId(`allocate-${code}`);
    await allocate.locator('select').selectOption(number);
    await allocate
      .getByTestId(`allocate-${code}-reason`)
      .fill('Doplatek bez VS – ověřeno s hotelem (ukázka)');
    await allocate.getByTestId(`allocate-${code}-submit`).click();
    await expect(page.getByTestId(`payment-${code}-state`)).toHaveText('přiřazeno');
    await expect(page.getByTestId(`payment-${code}-result`)).toHaveText(
      'vyřešeno ručně (původně: chybí variabilní symbol)',
    );
    // The same statement loaded again: nothing new, nothing counted twice.
    await statement.getByTestId('simulate-submit').click();
    await expect(statement.getByTestId('simulate-result')).toHaveText(
      'Nově zaznamenáno 0, už dříve načteno 2 (nezapočteno znovu). Spárováno 0, k posouzení 0.',
    );
    await finance.getByRole('link', { name: 'Faktury', exact: true }).click();
    const list = page.getByTestId('invoices');
    await expect(list.locator('li', { hasText: number })).toContainText('Uhrazeno');
    await expect(list.locator('li', { hasText: beta })).toContainText('Neuhrazeno');
    await list.getByRole('link', { name: number }).click();
    await expect(page.getByTestId('invoice-payment-state')).toHaveText('Uhrazeno');
    await expect(page.getByTestId('invoice-allocations')).toContainText('automaticky');
    await expect(page.getByTestId('invoice-allocations')).toContainText('ručně');
    await shot('5-uhrazeno');
  });
});

test.describe('without the issuer permission', () => {
  test.use({ storageState: OPERATOR_STATE });

  test('the page and its API are refused', async ({ page }) => {
    await page.goto('/finance/settings/company');
    await expect(page).toHaveURL(/\/forbidden$/);
    expect((await page.request.get('/api/admin/finance/issuer')).status()).toBe(403);
  });
});
