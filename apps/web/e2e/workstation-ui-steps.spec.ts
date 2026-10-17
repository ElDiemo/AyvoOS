import { mkdirSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { expect, test, type APIRequestContext, type Browser, type Page } from '@playwright/test';
import { labelingSetup, labelledCrate, receiveStock, type LabelingSetup } from './labeling-setup';

/**
 * "Připravit výrobu" → the concrete next step, clicked through to the target form (issue #11
 * UI-21, PR #30 review UI30-R1/R2). Two products with their own designs and materials, a crate
 * waiting with an OLDER pinned recipe: the step keeps the product, its approved design, the item
 * of the judged recipe and the station mode/category; nothing (quantity, supplier, lot) is filled
 * in; the way back leads to the same product. A limited custom role never gets a step it cannot
 * finish on the target page. Synthetic data only.
 */
test.use({ storageState: 'e2e/.auth/admin.json' });
test.describe.configure({ mode: 'serial' });

type Res = Awaited<ReturnType<APIRequestContext['get']>>;
async function json<T>(res: Res): Promise<T> {
  expect(res.ok(), `${res.url()} -> ${res.status()}`).toBe(true);
  return (await res.json()) as T;
}
const SHOTS = process.env.AYVO_SCREENSHOT_DIR;
async function shot(page: Page, name: string) {
  if (!SHOTS) return;
  mkdirSync(SHOTS, { recursive: true });
  await page.screenshot({ path: join(SHOTS, `${name}.png`), fullPage: true });
}
const sfx = () => Math.random().toString(36).slice(2, 8).toUpperCase();

async function printed(request: APIRequestContext, name: string, n: number) {
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
  const version = await json<{ versionId: string; label: string }>(
    await request.post('/api/admin/label-templates', {
      data: {
        name,
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
  const reg = await json<{ batch: { firstBottleCode: string }; printJob: { code: string } }>(
    await request.post('/api/admin/bottle-registrations', {
      data: {
        requestId: crypto.randomUUID(),
        labelTemplateVersionId: version.versionId,
        quantity: n,
      },
    }),
  );
  await json(await request.post(`/api/admin/label-print-jobs/${reg.printJob.code}/generate`));
  const first = Number(reg.batch.firstBottleCode.slice(6));
  const urls: string[] = [];
  for (let i = 0; i < n; i++) {
    const code = `AYV-B-${String(first + i).padStart(6, '0')}`;
    urls.push(
      (await json<{ publicUrl: string }>(await request.get(`/api/admin/bottles/${code}`)))
        .publicUrl,
    );
  }
  return { versionId: version.versionId, label: version.label, urls };
}

let soap: LabelingSetup;
let soapDesign = '';
let gel: LabelingSetup;
let unapproved: LabelingSetup;
let liquidV2 = '';

test.beforeAll(async ({ browser }) => {
  const context = await browser.newContext({ storageState: 'e2e/.auth/admin.json' });
  const request = context.request;
  // The gel and its design first: its template and items come first in the lists.
  const gelPrinted = await printed(request, `ui30-gel-${Date.now()}`, 1);
  gel = await labelingSetup(request, {
    versionId: gelPrinted.versionId,
    category: 'SHOWER_GEL',
    productName: 'Sprchový gel (E2E UI30)',
  });
  const soapPrinted = await printed(request, `ui30-soap-${Date.now()}`, 1);
  soapDesign = soapPrinted.label;
  soap = await labelingSetup(request, {
    versionId: soapPrinted.versionId,
    capacity: 1,
    productName: 'Tekuté mýdlo (E2E UI30)',
  });
  // Its only printed bottle labelled into a crate (capacity 1): no PDF-ready label left, and a
  // crate waits for filling with recipe V1 pinned.
  const bottleLot = (await receiveStock(request, 'NEW_BOTTLE', '5'))!;
  await labelledCrate(request, soap, {
    versionId: soapPrinted.versionId,
    bottleLotCode: bottleLot,
    urls: soapPrinted.urls,
  });
  // V2 becomes active with another liquid.
  const api = '/api/admin/catalog';
  liquidV2 = (
    await json<{ code: string }>(
      await request.post(`${api}/components`, {
        data: {
          requestId: crypto.randomUUID(),
          reason: 'E2E kapalina V2',
          packageCapacity: null,
          kind: 'BULK_LIQUID',
          code: `E2E-LIQ2-${sfx()}`,
          name: 'Kapalina V2 (E2E)',
          unitCode: 'ml',
          lotTracked: true,
          categoryCode: 'HAND_SOAP',
        },
      }),
    )
  ).code;
  await json(
    await request.post(`${api}/products/${soap.productCode}/recipes`, {
      data: {
        requestId: crypto.randomUUID(),
        reason: 'E2E receptura V2',
        crateTypeCode: soap.crateTypeCode,
        components: [
          { itemCode: 'NEW_BOTTLE', quantity: '1', unitCode: 'pcs' },
          { itemCode: soap.labelCode, quantity: '1', unitCode: 'pcs' },
          { itemCode: liquidV2, quantity: '330', unitCode: 'ml' },
          { itemCode: soap.pumpCode, quantity: '1', unitCode: 'pcs' },
        ],
      },
    }),
  );
  await json(
    await request.post(`${api}/products/${soap.productCode}/recipes/2/activate`, {
      data: { requestId: crypto.randomUUID(), reason: 'E2E V2', expectedActiveVersion: 1 },
    }),
  );
  unapproved = await labelingSetup(request, { versionId: '', approve: false });
  await context.close();
});

const step = (page: Page, key: string) => page.getByTestId(`step-${key}`);

test('QR labels open for THIS product and its approved design only, and lead back', async ({
  page,
}) => {
  await page.goto(`/production/setup?product=${soap.productCode}`);
  const labels = step(page, 'labeling.labels');
  await expect(labels.getByRole('link')).toHaveCount(1);
  await labels.getByRole('link', { name: new RegExp(`design ${soapDesign}`) }).click();
  await expect(page).toHaveURL(/\/bottles\/new\?/);
  await expect(page.getByTestId('bottles-for-product')).toContainText(soap.productCode);
  const template = page.locator('select#template');
  await expect(template.locator('option')).toHaveCount(1); // never the gel's (first) template
  await expect(template.locator('option:checked')).toContainText(soapDesign.split(' ')[0]!);
  await shot(page, 'ui30-01-qr-for-product');
  await page.getByRole('link', { name: 'Zpět na přípravu výroby' }).click();
  await expect(page).toHaveURL(new RegExp(`/production/setup\\?product=${soap.productCode}$`));
  await expect(page.getByTestId('readiness-products').locator('[aria-current="page"]')).toHaveText(
    'Tekuté mýdlo (E2E UI30)',
  );
});

test('a crate pinned to the older recipe: receive ITS liquid, not the active one', async ({
  page,
}) => {
  await page.goto(`/production/setup?product=${soap.productCode}`);
  const liquid = page.getByTestId('readiness-filling.liquid');
  await expect(liquid).toHaveAttribute('data-recipe', '1'); // the waiting crate's V1
  await liquid.getByRole('link', { name: /Přijmout na sklad: Kapalina \(E2E\)/ }).click();
  await expect(page).toHaveURL(/\/warehouse\/receipts\/new\?/);
  await expect(page.getByTestId('receipt-context')).toContainText(soap.liquidCode);
  const line = page.getByTestId('receipt-line-1');
  await expect(line.locator('select option:checked')).toContainText(soap.liquidCode);
  await expect(line.locator('select option:checked')).not.toContainText(liquidV2);
  // Nothing filled in for the user: quantity, supplier, lot.
  await expect(line.getByLabel(/Množství/)).toHaveValue('');
  await expect(page.getByRole('combobox', { name: 'Dodavatel' })).toHaveValue('');
  await shot(page, 'ui30-02-receipt-pinned-liquid');
  await page.getByRole('link', { name: 'Zpět na přípravu výroby' }).click();
  await expect(page).toHaveURL(new RegExp(`/production/setup\\?product=${soap.productCode}$`));
});

test('a filling station for the gel opens with its mode and category', async ({ page }) => {
  await page.goto(`/production/setup?product=${gel.productCode}`);
  const station = step(page, 'filling.station');
  test.skip(
    (await station.count()) === 0,
    'a SHOWER_GEL filling station already exists in this database',
  );
  await station.getByRole('link').click();
  await expect(page).toHaveURL(/\/production\/workstations\?/);
  const form = page.getByTestId('workstation-form');
  await expect(form.getByLabel('Režim')).toHaveValue('FILLING');
  await expect(form.getByLabel('Kategorie plnění')).toHaveValue('SHOWER_GEL');
  await expect(form.getByLabel('Název')).toHaveValue('');
  await expect(form.getByLabel('Kód')).toHaveValue('');
  await shot(page, 'ui30-03-filling-station-gel');
});

async function limitedUser(
  browser: Browser,
  admin: Page,
  permissions: string[] = ['catalog:read', 'catalog:product_manage'],
) {
  const code = `E2E_CAT_MGR_${sfx()}`;
  const role = await admin.request.post('/api/admin/identity/roles', {
    data: {
      code,
      name: code,
      description: 'katalog bez výroby',
      permissions,
      copiedFrom: null,
      reason: 'UI30 limited role',
    },
  });
  expect(role.status(), await role.text()).toBe(201);
  const me = (await (await admin.request.get('/api/auth/me')).json()) as {
    sites: { id: string; code: string }[];
  };
  const email = `e2e-cat-mgr-${Date.now()}@ayvo.test`;
  const res = await admin.request.post('/api/admin/identity/users', {
    data: {
      email,
      displayName: 'Správce katalogu',
      roles: [code],
      siteIds: [me.sites.find((s) => s.code === 'CZ-PREROV-01')!.id],
      warehouseCodes: [],
      reason: 'UI30 limited role',
    },
  });
  expect(res.status(), await res.text()).toBe(201);
  const context = await browser.newContext({ storageState: { cookies: [], origins: [] } });
  const page = await context.newPage();
  await page.goto(`/api/auth/login?next=/&login_hint=${email}`);
  await expect(page.getByTestId('current-user')).toBeVisible();
  return { context, page };
}

test('a limited role is never offered a step it cannot finish (catalog without production:read)', async ({
  browser,
  page,
}) => {
  const { context, page: user } = await limitedUser(browser, page);
  await user.goto(`/production/setup?product=${unapproved.productCode}`);
  const design = step(user, 'setup.design');
  await expect(design.getByTestId('ask-supervisor')).toHaveText('Požádejte vedoucího');
  await expect(design.getByRole('link', { name: /Schválit design/ })).toHaveCount(0);
  await shot(user, 'ui30-04-limited-role-ask');
  await design.getByRole('link', { name: 'Otevřít produkt (jen pro čtení)' }).click();
  await expect(user).toHaveURL(
    new RegExp(`/production/catalog/products/${unapproved.productCode}$`),
  );
  // Indeed: no approval form for this role on the product page.
  await expect(user.getByRole('button', { name: /Schválit/ })).toHaveCount(0);
  // Steps that need production or stock rights are not offered either.
  await user.goto(`/production/setup?product=${unapproved.productCode}`);
  await expect(user.getByRole('link', { name: /Připravit QR etikety/ })).toHaveCount(0);
  await expect(user.getByRole('link', { name: /Přijmout na sklad/ })).toHaveCount(0);
  await context.close();
});

test('the QR + PDF step needs production:labels_print as well (identities alone are not enough)', async ({
  browser,
  page,
}) => {
  const identities = [
    'catalog:read',
    'catalog:product_manage',
    'production:read',
    'production:bottles_create',
  ];
  const without = await limitedUser(browser, page, identities);
  await without.page.goto(`/production/setup?product=${soap.productCode}`);
  const labels = step(without.page, 'labeling.labels');
  await expect(labels.getByTestId('ask-supervisor')).toHaveText('Požádejte vedoucího');
  await expect(labels.getByRole('link', { name: /Připravit QR etikety/ })).toHaveCount(0);
  await without.context.close();

  const withPrint = await limitedUser(browser, page, [...identities, 'production:labels_print']);
  await withPrint.page.goto(`/production/setup?product=${soap.productCode}`);
  const offered = step(withPrint.page, 'labeling.labels');
  await expect(offered.getByRole('link', { name: /Připravit QR etikety/ })).toHaveCount(1);
  await expect(offered.getByTestId('ask-supervisor')).toHaveCount(0);
  await withPrint.context.close();
});
