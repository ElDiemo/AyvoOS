import { randomUUID } from 'node:crypto';
import { mkdir, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { crateUrl, labelingSetup, lotId, openStation, releaseOwnStation } from './labeling-setup';
import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import { signInWithForm } from './test-sign-in';

/**
 * Milestone 2A flow in Czech (doc 018, doc 019): Sklad: supplier → goods receipt with a delivery
 * note (internal lot); Výroba: session series and lot → physical label application by scanning
 * (Enter), duplicate, wrong series, wrong environment, not an AYVO label, lot exhausted; Sklad:
 * invoice linked later → stock, ledger and the bottle's physical facts. Self-contained: creates
 * its own printed bottles.
 */
test.describe.configure({ mode: 'serial' });

const SHOTS_ISSUE = resolve(import.meta.dirname, '../../../docs/screenshots/warehouse');
const SHOTS_RECEIPT = resolve(import.meta.dirname, '../../../docs/screenshots/catalog');
const PDF = Buffer.from('%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n');
let urls: string[] = [];
let codes: string[] = [];
let receiptCode = '';
let lotCode = '';
let seriesCode = '';
let foreignUrl = '';
let versionId = '';
let stationUrl = '';
let productName = '';
let productCode = '';

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
  versionId = version.versionId;
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
  // Other items may exist (e.g. catalogue components): choose the new bottles explicitly.
  await page
    .getByTestId('receipt-line-1')
    .getByLabel('Položka')
    .selectOption({ label: 'Nová prázdná lahev (NEW_BOTTLE)' });
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

test('a consumable (ribbon roll) is received and issued to consumption by hand, with a reason (doc 018 §5a)', async ({
  page,
  browser,
}) => {
  const code = `RIBBON-${Date.now().toString(36).toUpperCase()}`;
  const created = await page.request.post('/api/admin/catalog/components', {
    data: {
      requestId: randomUUID(),
      code,
      name: 'Ribbon zlatý 300 m',
      kind: 'CONSUMABLE',
      unitCode: 'pcs',
      lotTracked: false,
      categoryCode: null,
      packageCapacity: null,
      reason: 'spotřební materiál tisku',
    },
  });
  expect(created.status()).toBe(201);
  // Received like any item (2 rolls).
  await page.goto('/warehouse/receipts/new');
  await page
    .getByRole('combobox', { name: 'Dodavatel' })
    .selectOption({ label: 'Lahve Test s.r.o.' });
  await page.getByLabel('Dodací list / faktura č.').fill('DL-RIBBON-1');
  await page.getByLabel('Číslo dokladu').fill('DL-RIBBON-1');
  await page
    .getByLabel('Soubor')
    .setInputFiles({ name: 'ribbon.pdf', mimeType: 'application/pdf', buffer: PDF });
  await page.getByRole('button', { name: 'Nahrát doklad' }).click();
  await expect(page.getByTestId('receipt-documents')).toContainText('DL-RIBBON-1');
  const line = page.getByTestId('receipt-line-1');
  await line.getByLabel('Položka').selectOption({ label: `Ribbon zlatý 300 m (${code})` });
  await line.getByLabel(/Množství/).fill('2');
  await page.getByRole('button', { name: 'Zkontrolovat' }).click();
  await page.getByRole('button', { name: 'Potvrdit příjem' }).click();
  await expect(page).toHaveURL(/\/warehouse\/receipts\/GR-\d{6}\?created=1$/);

  // Issued by hand on the stock page: one roll, with a reason.
  // The warehouse supervisor (this spec's user) has no inventory:consume: no form, refused.
  await page.goto('/warehouse/stock');
  await expect(page.getByTestId(`stock-${code}`)).toContainText('Ribbon zlatý 300 m');
  await expect(page.getByTestId(`issue-${code}`)).toHaveCount(0);
  // ADMIN issues it.
  const ctx = await browser.newContext({ storageState: 'e2e/.auth/admin.json' });
  const adminPage = await ctx.newPage();
  await issueAsAdmin(adminPage, code);
  await ctx.close();
});

async function issueAsAdmin(page: Page, code: string) {
  await page.goto('/warehouse/stock');
  const form = page.getByTestId(`issue-${code}`);
  await expect(form.getByTestId(`issue-${code}-quantity`)).toHaveValue('1');
  await form.getByTestId(`issue-${code}-reason`).fill('nová role do tiskárny etiket');
  await mkdir(SHOTS_ISSUE, { recursive: true });
  for (const width of [1440, 390, 320]) {
    await page.setViewportSize({ width, height: 900 });
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    ).toBe(true);
    await form.scrollIntoViewIfNeeded();
    await page.screenshot({ path: resolve(SHOTS_ISSUE, `consumable-issue-${width}.png`) });
  }
  await page.setViewportSize({ width: 1280, height: 900 });
  await form.getByTestId(`issue-${code}-submit`).click();
  await expect(form.getByRole('status')).toHaveText('Vydáno 1 ks. Na skladě zůstává 1 ks.');
  await expect(page.getByTestId(`stock-${code}`)).toContainText('1');
  // The ledger names the issue and its reason.
  await page.goto(`/warehouse/movements?item=${code}`);
  await expect(page.locator('main')).toContainText('Výdej do spotřeby');
  await expect(page.locator('main')).toContainText('nová role do tiskárny etiket');
}

test('a label with pieces per roll: rolls only fill the quantity in pieces (doc 023 §4a)', async ({
  page,
}) => {
  const code = `LABEL-ROLL-${Date.now().toString(36).toUpperCase()}`;
  const created = await page.request.post('/api/admin/catalog/components', {
    data: {
      requestId: randomUUID(),
      code,
      name: 'Prázdná etiketa v roli',
      kind: 'LABEL_MEDIA',
      unitCode: 'pcs',
      lotTracked: false,
      categoryCode: null,
      packageCapacity: 300,
      reason: 'společný materiál etiket',
    },
  });
  expect(created.status()).toBe(201);
  await page.goto('/warehouse/receipts/new');
  await page
    .getByRole('combobox', { name: 'Dodavatel' })
    .selectOption({ label: 'Lahve Test s.r.o.' });
  const line = page.getByTestId('receipt-line-1');
  await line.getByLabel('Položka').selectOption({ label: `Prázdná etiketa v roli (${code})` });
  await line.getByLabel('Počet rolí (po 300 ks)').fill('2');
  await expect(line.getByTestId('receipt-line-1-quantity')).toHaveValue('600');
  await mkdir(SHOTS_RECEIPT, { recursive: true });
  for (const width of [1440, 390, 320]) {
    await page.setViewportSize({ width, height: 900 });
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    ).toBe(true);
    await line.scrollIntoViewIfNeeded();
    await page.screenshot({ path: resolve(SHOTS_RECEIPT, `label-rolls-receipt-${width}.png`) });
  }
  await page.setViewportSize({ width: 1280, height: 900 });
  // The pieces are the truth: typing them clears the rolls aid.
  await line.getByTestId('receipt-line-1-quantity').fill('599');
  await expect(line.getByLabel('Počet rolí (po 300 ks)')).toHaveValue('');
  // An item without pieces per roll has no aid.
  await line.getByLabel('Položka').selectOption({ label: 'Nová prázdná lahev (NEW_BOTTLE)' });
  await expect(line.getByText(/Počet rolí/)).toHaveCount(0);
});

test('labels are applied at a labelling station into a crate; the old URLs lead there', async ({
  page,
  request,
}) => {
  // The old warehouse and production URLs lead to the station (doc 025 A3).
  await page.goto('/warehouse/labels');
  await expect(page).toHaveURL(/\/production\/station$/);
  await expect(
    page.getByRole('navigation', { name: 'Hlavní navigace' }).getByRole('link', { name: 'Výroba' }),
  ).toHaveAttribute('aria-current', 'page');

  // Synthetic catalogue + approved design + labelling station; bottles of this file's design.
  const kit = await labelingSetup(request, { versionId });
  stationUrl = kit.stationUrl;
  productName = kit.productName;
  productCode = kit.productCode;
  const sessionId = await openStation(request, kit.stationUrl);
  const base = `/api/admin/station-sessions/${sessionId}`;
  expect(
    (
      await request.post(`${base}/labeling-context`, {
        data: {
          requestId: crypto.randomUUID(),
          productCode: kit.productCode,
          labelTemplateVersionId: versionId,
          sourceLotId: await lotId(request, lotCode),
        },
      })
    ).status(),
  ).toBe(200);
  const crate = await crateUrl(request, kit.crateTypeCode);
  const loaded = await request.post(`${base}/crate`, {
    data: { requestId: crypto.randomUUID(), scannedValue: crate },
  });
  expect(loaded.status()).toBe(200);
  const contextRevision = ((await loaded.json()) as { contextRevision: number }).contextRevision;
  const scan = (url: string) =>
    request.post(`${base}/label-scans`, {
      data: { requestId: crypto.randomUUID(), scannedValue: url, contextRevision },
    });
  expect(((await (await scan(urls[0]!)).json()) as { outcome: string }).outcome).toBe('APPLIED');
  expect(((await (await scan(urls[0]!)).json()) as { outcome: string }).outcome).toBe(
    'ALREADY_APPLIED',
  );
  expect(((await (await scan(urls[1]!)).json()) as { outcome: string }).outcome).toBe('APPLIED');
  const exhausted = await scan(urls[2]!);
  expect([exhausted.status(), ((await exhausted.json()) as { code: string }).code]).toEqual([
    409,
    'LOT_EXHAUSTED',
  ]);
  void foreignUrl;
  void seriesCode;
  await releaseOwnStation(request);
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
      '/production/station',
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

test('long supplier and lot names wrap; the labelling station stays within the screen', async ({
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

  await openStation(request, stationUrl);
  for (const width of [320, 390, 820, 1280]) {
    await page.setViewportSize({ width, height: 900 });
    for (const path of ['/', '/warehouse', '/warehouse/stock', '/warehouse/receipts']) {
      await page.goto(path);
      await noOverflow(page, `${path} at ${width}px`);
    }
    // The labelling station lists the long lot (its supplier lot code) without overflowing.
    await page.goto('/production/station');
    const ctx = page.getByTestId('labeling-context-form');
    await ctx.getByLabel('Produkt').selectOption({ label: `${productName} (${productCode})` });
    await expect(ctx.getByLabel('Šarže nových lahví')).toContainText(supplierLot);
    await noOverflow(page, `labelling station at ${width}px`);
  }
  await releaseOwnStation(request);
  await expect(page.locator('body')).not.toContainText('qr.ayvo.co');
});

/** A context without the operator session of this file (new users sign in themselves). */
const SIGNED_OUT = { cookies: [], origins: [] };

/** Sign-in of a newly created user through the fake identity provider (APP_ENV=test). */
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
