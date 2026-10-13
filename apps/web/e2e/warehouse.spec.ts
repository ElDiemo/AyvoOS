import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { expect, test, type APIRequestContext, type Page } from '@playwright/test';

/**
 * Milestone 2A flow in Czech (doc 018, doc 019): Sklad: supplier → goods receipt with a delivery
 * note (internal lot); Výroba: session series and lot → physical label application by scanning
 * (Enter), duplicate, wrong series, wrong environment, not an AYVO label, lot exhausted; Sklad:
 * invoice linked later → stock, ledger and the bottle's physical facts. Self-contained: creates
 * its own printed bottles.
 */
test.describe.configure({ mode: 'serial' });

const PDF = Buffer.from('%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n');
let urls: string[] = [];
let codes: string[] = [];
let receiptCode = '';
let lotCode = '';
let seriesCode = '';
let foreignUrl = '';

async function json<T>(res: Awaited<ReturnType<APIRequestContext['get']>>): Promise<T> {
  expect(res.ok(), `${res.url()} -> ${res.status()}`).toBe(true);
  return (await res.json()) as T;
}

async function noOverflow(page: Page, what: string) {
  await expect
    .poll(
      () =>
        page.evaluate(
          () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
        ),
      {
        message: `horizontal overflow on ${what}`,
      },
    )
    .toBeLessThanOrEqual(0);
}

test.beforeAll(async ({ request }) => {
  const artwork = await json<{ id: string }>(
    await request.post('/api/admin/label-artworks', {
      multipart: {
        file: {
          name: 'mydlo1.svg',
          mimeType: 'image/svg+xml',
          buffer: await readFile(resolve(import.meta.dirname, 'fixtures/mydlo1.svg')),
        },
      },
    }),
  );
  const version = await json<{ versionId: string }>(
    await request.post('/api/admin/label-templates', {
      data: {
        name: `sklad-${Date.now()}`,
        layout: {
          artworkId: artwork.id,
          widthMm: 70,
          heightMm: 110,
          elements: [
            { type: 'QR_CODE', xMm: 27.5, yMm: 70, widthMm: 15, heightMm: 15, rotationDeg: 0 },
          ],
        },
      },
    }),
  );
  const registration = await json<{
    batch: { code: string; firstBottleCode: string; lastBottleCode: string };
    printJob: { code: string };
  }>(
    await request.post('/api/admin/bottle-registrations', {
      data: {
        requestId: crypto.randomUUID(),
        labelTemplateVersionId: version.versionId,
        quantity: 3,
      },
    }),
  );
  await json(
    await request.post(`/api/admin/label-print-jobs/${registration.printJob.code}/generate`),
  );
  seriesCode = registration.batch.code;
  const first = Number(registration.batch.firstBottleCode.slice(6));
  codes = [0, 1, 2].map((i) => `AYV-B-${String(first + i).padStart(6, '0')}`);
  urls = [];
  for (const code of codes) {
    urls.push(
      (await json<{ publicUrl: string }>(await request.get(`/api/admin/bottles/${code}`)))
        .publicUrl,
    );
  }
  // A printed bottle of another series: the station must refuse it.
  const foreign = await json<{ batch: { firstBottleCode: string }; printJob: { code: string } }>(
    await request.post('/api/admin/bottle-registrations', {
      data: {
        requestId: crypto.randomUUID(),
        labelTemplateVersionId: version.versionId,
        quantity: 1,
      },
    }),
  );
  await json(await request.post(`/api/admin/label-print-jobs/${foreign.printJob.code}/generate`));
  foreignUrl = (
    await json<{ publicUrl: string }>(
      await request.get(`/api/admin/bottles/${foreign.batch.firstBottleCode}`),
    )
  ).publicUrl;
});

test('receive new bottles: supplier, delivery note, internal lot, invoice pending', async ({
  page,
}) => {
  // The warehouse opens on its own overview (no redirect to label application).
  await page.goto('/warehouse');
  await expect(page).toHaveURL(/\/warehouse$/);
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Přehled skladu');
  await expect(
    page.getByRole('navigation', { name: 'Hlavní navigace' }).getByRole('link', { name: 'Sklad' }),
  ).toHaveAttribute('aria-current', 'page');
  await expect(page.getByTestId('next-action')).toHaveText('Založit dodavatele');
  await expect(page.getByTestId('attention')).toContainText('není založen žádný dodavatel');

  await page
    .getByRole('navigation', { name: 'Sklad' })
    .getByRole('link', { name: 'Dodavatelé' })
    .click();
  await page.getByLabel('Název').fill('Lahve Test s.r.o.');
  await page.getByRole('button', { name: 'Založit dodavatele' }).click();
  await expect(page.getByTestId('suppliers')).toContainText('Lahve Test s.r.o.');

  await page
    .getByRole('navigation', { name: 'Sklad' })
    .getByRole('link', { name: 'Příjem zboží' })
    .click();
  // The document upload needs the supplier first, and says so (issue #11, UI-05).
  await expect(page.getByTestId('document-needs-supplier')).toHaveText(
    'Nejprve vyberte dodavatele (krok 1) – potom půjde nahrát jeho doklad.',
  );
  await expect(page.getByLabel('Soubor')).toHaveCount(0);
  await page
    .getByRole('combobox', { name: 'Dodavatel' })
    .selectOption({ label: 'Lahve Test s.r.o.' });
  await expect(page.getByTestId('document-needs-supplier')).toHaveCount(0);
  await page.getByLabel('Dodací list / faktura č.').fill('DL-2026-001');
  await page.getByLabel('Číslo dokladu').fill('DL-2026-001');
  await page
    .getByLabel('Soubor')
    .setInputFiles({ name: 'dodaci-list.pdf', mimeType: 'application/pdf', buffer: PDF });
  await page.getByRole('button', { name: 'Nahrát doklad' }).click();
  await expect(page.getByTestId('receipt-documents')).toContainText('Dodací list DL-2026-001');
  await page
    .getByTestId('receipt-line-1')
    .getByLabel(/Množství/)
    .fill('2');
  await page.getByRole('button', { name: 'Zkontrolovat' }).click();
  await expect(page.getByTestId('receipt-review')).toContainText('Čeká na fakturu');
  await page.getByRole('button', { name: 'Potvrdit příjem' }).click();

  await expect(page).toHaveURL(/\/warehouse\/receipts\/GR-\d{6}\?created=1$/);
  receiptCode = page.url().match(/GR-\d{6}/)![0];
  lotCode = `${receiptCode}/1`;
  await expect(page.getByRole('status')).toContainText(`Příjem ${receiptCode} byl potvrzen`);
  await expect(page.getByTestId('invoice-status')).toHaveText('Čeká na fakturu');
  await expect(page.getByTestId('line-1')).toContainText(lotCode);
});

test('apply labels by scanning: session series and lot, applied, duplicate, rejections, lot exhausted', async ({
  page,
}) => {
  // The old warehouse URL leads to the Production station.
  await page.goto('/warehouse/labels');
  await expect(page).toHaveURL(/\/production\/label-activation$/);
  await expect(
    page.getByRole('navigation', { name: 'Hlavní navigace' }).getByRole('link', { name: 'Výroba' }),
  ).toHaveAttribute('aria-current', 'page');
  await page
    .getByTestId('series-choices')
    .getByRole('button', { name: new RegExp(seriesCode) })
    .click();
  await page
    .getByTestId('lot-choices')
    .getByRole('button', { name: new RegExp(lotCode) })
    .click();
  await expect(page.getByTestId('active-series')).toContainText(seriesCode);
  await expect(page.getByTestId('active-lot')).toContainText(lotCode);
  await expect(page.getByTestId('active-lot-remaining')).toHaveText('zbývá 2 ks');

  // The session lot survives a refresh; the scan field has focus; Enter submits.
  await page.reload();
  await expect(page.getByTestId('active-lot')).toContainText(lotCode);
  const scan = page.getByTestId('scan-input');
  await expect(scan).toBeFocused();
  await scan.fill(urls[0]!);
  await scan.press('Enter');
  await expect(page.getByTestId('scan-outcome')).toContainText(`${codes[0]} – etiketa nalepena`);
  await expect(page.getByTestId('scan-outcome')).toContainText(`ze šarže ${lotCode}. Zbývá 1 ks.`);
  await expect(page.getByTestId('active-lot-remaining')).toHaveText('zbývá 1 ks');
  await expect(scan).toHaveValue('');
  await expect(scan).toBeFocused();

  // From here on, scan like a handheld scanner: keystrokes go to whatever has focus, followed by
  // Enter — no mouse, no fill(). Every result must leave the field empty and focused again.
  const scanByKeyboard = async (value: string) => {
    await page.keyboard.type(value);
    await page.keyboard.press('Enter');
  };
  await scanByKeyboard(urls[0]!);
  await expect(page.getByTestId('scan-outcome')).toContainText('etiketa už byla nalepena');
  await expect(page.getByTestId('active-lot-remaining')).toHaveText('zbývá 1 ks');
  await expect(scan).toHaveValue('');
  await expect(scan).toBeFocused();

  // A label of another series is refused by the server; nothing is consumed.
  await scanByKeyboard(foreignUrl);
  await expect(page.getByTestId('scan-outcome')).toContainText('Lahev nepatří do zvolené série');
  await expect(page.getByTestId('active-lot-remaining')).toHaveText('zbývá 1 ks');
  await expect(scan).toBeFocused();

  await scanByKeyboard(`https://qr.ayvo.co/${urls[1]!.split('/').pop()}`);
  await expect(page.getByTestId('scan-outcome')).toContainText('Etiketa patří do jiného prostředí');
  await expect(scan).toBeFocused();
  await scanByKeyboard('AYV-B-000001');
  await expect(page.getByTestId('scan-outcome')).toContainText('Toto není etiketa AYVO');
  await expect(scan).toHaveValue('');
  await expect(scan).toBeFocused();

  await scanByKeyboard(urls[1]!);
  await expect(page.getByTestId('scan-outcome')).toContainText(`${codes[1]} – etiketa nalepena`);
  await expect(page.getByTestId('active-lot-remaining')).toHaveText('zbývá 0 ks');
  await expect(page.getByText('Šarže je vyčerpaná', { exact: true })).toBeVisible();
  await expect(page.getByTestId('scan-input')).toHaveCount(0); // scanning stops; no silent switch
  await expect(page.getByTestId('session-results').locator('li')).toHaveCount(6);
  await expect(page.locator('body')).not.toContainText('qr.ayvo.co/'); // never echoed back

  await page.getByRole('button', { name: 'Změnit šarži' }).click();
  await expect(page.getByTestId('no-lots')).toBeVisible();
});

test('invoice linked later, stock and ledger, bottle physical facts, phone width', async ({
  page,
}) => {
  await page.goto(`/warehouse/receipts/${receiptCode}`);
  await page.getByRole('combobox', { name: 'Druh dokladu' }).selectOption('INVOICE');
  await page.getByLabel('Číslo dokladu').fill('FV-2026-001');
  await page
    .getByLabel('Soubor')
    .setInputFiles({ name: 'faktura.pdf', mimeType: 'application/pdf', buffer: PDF });
  await page.getByRole('button', { name: 'Přiložit' }).click();
  await expect(page.getByTestId('invoice-status')).toHaveText('Faktura doložena');
  await expect(page.getByTestId('documents')).toContainText('Faktura');

  await page.goto('/warehouse/movements');
  const ledger = page.getByTestId('movements');
  await expect(ledger).toContainText('Nalepení etikety');
  await expect(ledger).toContainText(codes[1]!);
  await expect(ledger).toContainText(receiptCode);

  await page.goto('/warehouse/stock');
  await expect(page.getByTestId('stock-NEW_BOTTLE')).toContainText('Nová prázdná lahev');

  await page.goto(`/bottles/${codes[0]}`);
  await expect(page.getByText('Etiketa nalepena – prázdná lahev')).toBeVisible();
  await expect(page.getByTestId('physical')).toContainText(lotCode);
  await expect(page.getByTestId('physical')).toContainText(receiptCode);
  await expect(page.getByTestId('components')).toContainText('Etiketa');
  await page.goto(`/bottles/${codes[2]}`);
  await expect(page.getByTestId('physical')).toContainText('zatím nebyla nalepena');

  // The warehouse overview now reflects the receipt and the movements.
  await page.goto('/warehouse');
  await expect(page.getByTestId('overview-receipts')).toContainText(receiptCode);
  await expect(page.getByTestId('overview-movements')).toContainText('Nalepení etikety');
  await expect(page.getByTestId('overview-stock-NEW_BOTTLE')).toContainText('Nová prázdná lahev');

  for (const width of [320, 390]) {
    await page.setViewportSize({ width, height: 900 });
    for (const path of [
      '/warehouse',
      '/production/label-activation',
      '/warehouse/receipts/new',
      '/warehouse/receipts',
      `/warehouse/receipts/${receiptCode}`,
      '/warehouse/stock',
      '/warehouse/suppliers',
    ]) {
      await page.goto(path);
      await noOverflow(page, `${path} at ${width}px`);
    }
  }
});

test('long supplier and lot names wrap; the scan button stays on one line', async ({
  page,
  request,
}) => {
  // Longest allowed values without a natural break opportunity.
  const supplierName = `Dodavatel_${'x'.repeat(110)}`;
  const supplierLot = `LOT-${'9'.repeat(60)}`;
  const supplier = await json<{ id: string }>(
    await request.post('/api/admin/suppliers', {
      data: { requestId: crypto.randomUUID(), name: supplierName, companyId: null, vatId: null },
    }),
  );
  const deliveryNote = await json<{ id: string }>(
    await request.post('/api/admin/supplier-documents', {
      multipart: {
        requestId: crypto.randomUUID(),
        supplierId: supplier.id,
        kind: 'DELIVERY_NOTE',
        documentNumber: 'DL-LONG-1',
        issuedOn: '2026-10-11',
        file: { name: 'dl.pdf', mimeType: 'application/pdf', buffer: PDF },
      },
    }),
  );
  const item = (
    await json<{ id: string; code: string }[]>(await request.get('/api/admin/inventory/items'))
  ).find((i) => i.code === 'NEW_BOTTLE')!;
  await json(
    await request.post('/api/admin/goods-receipts', {
      data: {
        requestId: crypto.randomUUID(),
        supplierId: supplier.id,
        supplierReference: 'DL-LONG-1',
        receivedAt: new Date().toISOString(),
        note: null,
        documentIds: [deliveryNote.id],
        lines: [
          {
            itemId: item.id,
            quantity: '1',
            supplierLotCode: supplierLot,
            unitPrice: null,
            currency: null,
            vatRate: null,
          },
        ],
      },
    }),
  );

  for (const width of [320, 390, 820, 1280]) {
    await page.setViewportSize({ width, height: 900 });
    for (const path of ['/', '/warehouse', '/warehouse/stock', '/warehouse/receipts']) {
      await page.goto(path);
      await noOverflow(page, `${path} at ${width}px`);
    }
    // Station setup lists the long lot and supplier; the active session shows them too.
    await page.goto('/production/label-activation');
    await page.evaluate(() => sessionStorage.clear());
    await page.reload();
    await expect(page.getByTestId('lot-choices')).toContainText(supplierLot);
    await noOverflow(page, `label activation setup at ${width}px`);
    await page
      .getByTestId('series-choices')
      .getByRole('button', { name: new RegExp(seriesCode) })
      .click();
    await page
      .getByTestId('lot-choices')
      .getByRole('button', { name: new RegExp(supplierLot) })
      .click();
    await expect(page.getByTestId('active-lot')).toContainText(supplierLot);
    await noOverflow(page, `label activation session at ${width}px`);

    // "Aktivovat" is rendered on exactly one line at every width.
    await page.getByTestId('scan-input').fill('x');
    const lines = await page.getByTestId('scan-submit').evaluate((el) => {
      const range = document.createRange();
      range.selectNodeContents(el);
      return new Set([...range.getClientRects()].map((r) => Math.round(r.top))).size;
    });
    expect(lines, `Aktivovat lines at ${width}px`).toBe(1);
  }
  await expect(page.locator('body')).not.toContainText('qr.ayvo.co');
});

/** A context without the operator session of this file (new users sign in themselves). */
const SIGNED_OUT = { cookies: [], origins: [] };

/** Sign-in of a newly created user through the fake identity provider (APP_ENV=test). */
async function signInWithForm(page: Page, email: string) {
  await page.goto('/login');
  await page.getByTestId('sign-in').click();
  await page.getByLabel('E-mail').fill(email);
  await page.getByRole('button', { name: 'Continue' }).click();
}

// Last in this file: it adds a supplier and stock that the flows above do not expect.
test('purchase prices and supplier documents never reach roles without the permission', async ({
  browser,
}) => {
  const admin = await browser.newContext({ storageState: 'e2e/.auth/admin.json' });
  const api = admin.request;
  const ok = async <T>(res: Awaited<ReturnType<typeof api.get>>): Promise<T> => {
    expect(res.ok(), `${res.url()} -> ${res.status()}`).toBe(true);
    return (await res.json()) as T;
  };
  const supplier = await ok<{ id: string }>(
    await api.post('/api/admin/suppliers', {
      data: {
        requestId: crypto.randomUUID(),
        name: 'Cenový dodavatel',
        companyId: null,
        vatId: null,
      },
    }),
  );
  const invoice = await ok<{ id: string; contentUrl: string }>(
    await api.post('/api/admin/supplier-documents', {
      multipart: {
        requestId: crypto.randomUUID(),
        supplierId: supplier.id,
        kind: 'INVOICE',
        documentNumber: 'FV-PRICE-1',
        issuedOn: '2026-10-11',
        file: { name: 'fv.pdf', mimeType: 'application/pdf', buffer: PDF },
      },
    }),
  );
  const item = (
    await ok<{ id: string; code: string }[]>(await api.get('/api/admin/inventory/items'))
  ).find((i) => i.code === 'NEW_BOTTLE')!;
  const receipt = await ok<{ code: string }>(
    await api.post('/api/admin/goods-receipts', {
      data: {
        requestId: crypto.randomUUID(),
        supplierId: supplier.id,
        supplierReference: 'FV-PRICE-1',
        receivedAt: new Date().toISOString(),
        note: null,
        documentIds: [invoice.id],
        lines: [
          {
            itemId: item.id,
            quantity: '2',
            supplierLotCode: null,
            unitPrice: '4321.5',
            currency: 'CZK',
            vatRate: '21',
          },
        ],
      },
    }),
  );
  // FINANCE is a planned system role (not assignable yet, doc 021 §4c): purchase prices are
  // recorded today through a custom role holding the same permissions.
  await ok(
    await api.post('/api/admin/identity/roles', {
      data: {
        code: 'E2E_PRICES',
        name: 'Nákupní ceny',
        description: 'Records purchase prices and reads supplier documents',
        permissions: [
          'inventory:read',
          'procurement:cost_read',
          'procurement:cost_write',
          'procurement:documents_read',
        ],
        copiedFrom: 'FINANCE',
        reason: 'price test',
      },
    }),
  );
  for (const [email, role] of [
    ['e2e-store@ayvo.test', 'WAREHOUSE_OPERATOR'],
    ['e2e-finance@ayvo.test', 'E2E_PRICES'],
  ] as const) {
    await ok(
      await api.post('/api/admin/identity/users', {
        data: {
          email,
          displayName: role,
          roles: [role],
          siteIds: ['01990000-0000-7000-8000-000000000001'],
          warehouseCodes: [],
          reason: 'price test',
        },
      }),
    );
  }

  // A warehouse operator: neither prices nor documents — not on the page, not from the API.
  const store = await browser.newContext({ storageState: SIGNED_OUT });
  const storePage = await store.newPage();
  await signInWithForm(storePage, 'e2e-store@ayvo.test');
  await storePage.goto(`/warehouse/receipts/${receipt.code}`);
  await expect(storePage.getByTestId('line-1')).toBeVisible();
  await expect(storePage.getByTestId('documents-restricted')).toBeVisible();
  await expect(storePage.getByRole('button', { name: 'Doplnit / opravit cenu' })).toHaveCount(0);
  await expect(storePage.locator('body')).not.toContainText('4321');
  await expect(storePage.locator('body')).not.toContainText('FV-PRICE-1.pdf');
  const direct = await storePage.request.get(`/api/admin/goods-receipts/${receipt.code}`);
  expect(direct.status()).toBe(200);
  const text = await direct.text();
  expect(text).not.toContain('4321');
  expect(text).not.toContain('unitPrice');
  expect(text).not.toContain(invoice.id);
  expect((await storePage.request.get(invoice.contentUrl)).status()).toBe(403);
  expect(
    (await storePage.request.get(`/api/admin/suppliers/${supplier.id}/documents`)).status(),
  ).toBe(403);

  // Finance sees both.
  const finance = await browser.newContext({ storageState: SIGNED_OUT });
  const financePage = await finance.newPage();
  await signInWithForm(financePage, 'e2e-finance@ayvo.test');
  await financePage.goto(`/warehouse/receipts/${receipt.code}`);
  await expect(financePage.getByTestId('line-1')).toContainText('4321.5 CZK');
  // The price role corrects the price later: reason required, recorded append-only.
  await financePage.getByRole('button', { name: 'Doplnit / opravit cenu' }).click();
  const costForm = financePage.getByTestId('cost-form-1');
  await costForm.getByLabel('Cena za jednotku (nepovinné)').fill('4300');
  await costForm.getByLabel('Důvod (povinný, např. číslo faktury)').fill('dobropis D-1');
  await costForm.getByRole('button', { name: 'Uložit cenu' }).click();
  await expect(financePage.getByTestId('price-1')).toContainText('4300 CZK');
  await expect(financePage.getByTestId('price-1')).toContainText('cena upravena');
  await expect(financePage.getByTestId('documents')).toContainText('FV-PRICE-1');
  expect((await financePage.request.get(invoice.contentUrl)).status()).toBe(200);

  await store.close();
  await finance.close();
  await admin.close();
});
