import { mkdirSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import { crateUrl, labelingSetup, releaseOwnStation, type LabelingSetup } from './labeling-setup';

/**
 * Labelling into crates (doc 025 A3) on the real built app with synthetic data: a supervisor
 * approves the label design on the product; at a labelling station the operator chooses product,
 * design and bottle lot once, loads a crate and scans each bottle after its label is applied —
 * the bottle goes into the crate (content n/capacity), a duplicate writes nothing, a label of
 * another design is refused, the last bottle makes the crate wait for filling. Screenshots go to
 * AYVO_SCREENSHOT_DIR when it is set.
 */
test.use({ storageState: 'e2e/.auth/admin.json' });
test.describe.configure({ mode: 'serial' });

const SHOTS = process.env.AYVO_SCREENSHOT_DIR;
const PDF = Buffer.from('%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n');
let kit: LabelingSetup;
let designLabel = '';
let urls: string[] = [];
let codes: string[] = [];
let otherUrl = '';
let lotCode = '';
let crate = '';

type Res = Awaited<ReturnType<APIRequestContext['get']>>;
async function json<T>(res: Res): Promise<T> {
  expect(res.ok(), `${res.url()} -> ${res.status()}`).toBe(true);
  return (await res.json()) as T;
}

async function shot(page: Page, name: string) {
  if (!SHOTS) return;
  mkdirSync(SHOTS, { recursive: true });
  const size = page.viewportSize()!;
  const height = await page.evaluate(() => document.documentElement.scrollHeight);
  await page.setViewportSize({ width: size.width, height: Math.min(height, 4000) });
  await page.screenshot({ path: join(SHOTS, `${name}.png`) });
  await page.setViewportSize(size);
}

async function noOverflow(page: Page) {
  await expect
    .poll(() =>
      page.evaluate(
        () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
      ),
    )
    .toBeLessThanOrEqual(0);
}

/** A label template with n printed bottles; returns the version and the bottles' URLs and codes. */
async function printedBottles(request: APIRequestContext, name: string, n: number) {
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
  const bottleCodes = Array.from(
    { length: n },
    (_, i) => `AYV-B-${String(first + i).padStart(6, '0')}`,
  );
  const bottleUrls: string[] = [];
  for (const code of bottleCodes) {
    bottleUrls.push(
      (await json<{ publicUrl: string }>(await request.get(`/api/admin/bottles/${code}`)))
        .publicUrl,
    );
  }
  return { version, codes: bottleCodes, urls: bottleUrls };
}

test.beforeAll(async ({ browser }) => {
  const context = await browser.newContext({ storageState: 'e2e/.auth/admin.json' });
  const request = context.request;
  const main = await printedBottles(request, `lepeni-${Date.now()}`, 8);
  const other = await printedBottles(request, `jiny-${Date.now()}`, 1);
  designLabel = main.version.label;
  urls = main.urls;
  codes = main.codes;
  otherUrl = other.urls[0]!;
  kit = await labelingSetup(request, {
    versionId: main.version.versionId,
    capacity: 3,
    approve: false,
  });
  // New bottles for this run: one lot of 10.
  const items = await json<{ id: string; code: string }[]>(
    await request.get('/api/admin/inventory/items'),
  );
  const supplier = await json<{ id: string }>(
    await request.post('/api/admin/suppliers', {
      data: {
        requestId: crypto.randomUUID(),
        name: `Lahve E2E ${Date.now()}`,
        companyId: null,
        vatId: null,
      },
    }),
  );
  const note = await json<{ id: string }>(
    await request.post('/api/admin/supplier-documents', {
      multipart: {
        requestId: crypto.randomUUID(),
        supplierId: supplier.id,
        kind: 'DELIVERY_NOTE',
        documentNumber: 'DL-LEP-1',
        issuedOn: '2026-10-14',
        file: { name: 'dl.pdf', mimeType: 'application/pdf', buffer: PDF },
      },
    }),
  );
  const receipt = await json<{ lines: { lot: { code: string } }[] }>(
    await request.post('/api/admin/goods-receipts', {
      data: {
        requestId: crypto.randomUUID(),
        supplierId: supplier.id,
        supplierReference: 'DL-LEP-1',
        receivedAt: new Date().toISOString(),
        note: null,
        documentIds: [note.id],
        lines: [
          {
            itemId: items.find((i) => i.code === 'NEW_BOTTLE')!.id,
            quantity: '10',
            supplierLotCode: null,
            unitPrice: null,
            currency: null,
            vatRate: null,
          },
        ],
      },
    }),
  );
  lotCode = receipt.lines[0]!.lot.code;
  crate = await crateUrl(request, kit.crateTypeCode);
  await releaseOwnStation(request);
  await context.close();
});

test.afterAll(async ({ browser }) => {
  const context = await browser.newContext({ storageState: 'e2e/.auth/admin.json' });
  await releaseOwnStation(context.request);
  await context.close();
});

test('a supervisor approves the label design for the product', async ({ page }) => {
  await page.goto(`/production/catalog/products/${kit.productCode}`);
  const card = page.getByTestId('label-approvals');
  await expect(card).toContainText('Produkt zatím nemá schválený design etikety.');
  const form = card.getByTestId('approve-design');
  await form.getByLabel('Design (šablona a verze)').selectOption({ label: designLabel });
  await form.getByLabel('Důvod (povinný)').fill('design pro E2E produkt');
  await form.getByRole('button', { name: 'Schválit design' }).click();
  await expect(card).toContainText('Design je schválený.');
  await expect(card.locator('li')).toContainText(designLabel);
  await shot(page, 'product-label-approvals');
});

test('labels bottles into a crate at the station: content, duplicate, wrong design, full crate', async ({
  page,
}) => {
  await page.goto('/production/station');
  const station = page.getByLabel('Naskenujte QR pracoviště');
  await expect(station).toBeFocused();
  await station.fill(kit.stationUrl);
  await station.press('Enter');
  await expect(page.getByTestId('station-mode')).toHaveText('Lepení etiket');

  const ctx = page.getByTestId('labeling-context-form');
  await ctx
    .getByLabel('Produkt')
    .selectOption({ label: `${kit.productName} (${kit.productCode})` });
  await ctx.getByLabel('Schválený design etikety').selectOption({ label: designLabel });
  await ctx.getByLabel('Šarže nových lahví').selectOption({ label: `${lotCode} (zbývá 10 ks)` });
  await shot(page, 'labeling-context');
  await ctx.getByRole('button', { name: 'Použít' }).click();
  await expect(page.getByTestId('labeling-context')).toContainText(designLabel);

  const scan = async (value: string) => {
    const field = page.getByTestId('labeling').locator('input').last();
    await expect(field).toBeFocused();
    await page.keyboard.type(value);
    await page.keyboard.press('Enter');
  };
  await scan(crate);
  const notice = page.getByTestId('labeling-notice');
  await expect(notice).toContainText('je připravená k vkládání lahví');
  await expect(page.getByTestId('crate-content')).toContainText('0/3');

  await scan(urls[0]!);
  await expect(notice).toContainText(`${codes[0]} nalepena a vložena (1/3)`);
  await expect(page.getByTestId('crate-content')).toContainText('1/3');
  await expect(page.getByTestId('labeling-context')).toContainText('zbývá 9 ks');
  await scan(urls[0]!);
  await expect(notice).toContainText('už v této bedně je – nic se neodepsalo');
  await expect(page.getByTestId('labeling-context')).toContainText('zbývá 9 ks');
  await scan(otherUrl);
  await expect(notice).toContainText('Etiketa má jiný design');
  await scan('nesmysl');
  await expect(notice).toContainText('Toto není QR kód AYVO');
  await shot(page, 'labeling-scans');

  // A rapid series like a handheld scanner: no waiting between the two scans, nothing is lost.
  await scan(urls[1]!);
  await page.keyboard.type(urls[2]!);
  await page.keyboard.press('Enter');
  await expect(notice).toContainText('je plná a čeká na plnění');
  await expect(page.getByTestId('crate-content')).toContainText('3/3');
  await expect(page.getByTestId('crate-scan')).toBeVisible();
  await shot(page, 'labeling-crate-full');

  // The crate list and the bottle history show the recorded facts.
  await page.goto('/production/crates');
  await expect(page.locator('body')).toContainText('Čeká na plnění · obsah 3/3');
  await page.goto(`/bottles/${codes[0]}`);
  await expect(page.locator('body')).toContainText('Vložena do bedny');
  await expect(page.locator('body')).toContainText('Etiketa nalepena – prázdná lahev');
});

test('an uncertain scan stops the queue; nothing is lost, doubled or moved to another crate', async ({
  page,
  request,
}) => {
  const lotLeft = async () =>
    Number(/zbývá (\d+) ks/.exec(await page.getByTestId('labeling-context').innerText())![1]);
  const typeScan = async (value: string) => {
    await page.keyboard.type(value);
    await page.keyboard.press('Enter');
  };
  await page.goto('/production/station');
  await expect(page.getByTestId('crate-scan')).toBeVisible();
  await typeScan(await crateUrl(request, kit.crateTypeCode));
  await expect(page.getByTestId('labeling-notice')).toContainText('je připravená k vkládání lahví');
  const before = await lotLeft();

  // 1. Lost BEFORE the server: the queue stops; later scans wait visibly and are not sent.
  const bodies: { requestId: string; contextRevision: number }[] = [];
  let dropNext = true;
  await page.route(/\/label-scans$/, async (route) => {
    bodies.push(JSON.parse(route.request().postData() ?? '{}'));
    if (dropNext) {
      dropNext = false;
      await route.abort('failed');
    } else await route.fallback();
  });
  await typeScan(urls[3]!);
  const unresolved = page.getByTestId('labeling-unresolved');
  await expect(unresolved).toContainText('Výsledek posledního scanu není jistý');
  await typeScan(urls[4]!);
  await typeScan(urls[5]!);
  await expect(page.getByTestId('labeling-waiting')).toHaveText('Čeká na odeslání: 2');
  expect(bodies).toHaveLength(1);
  await expect(page.getByRole('button', { name: 'Jiná bedna' })).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Změnit' })).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Opustit pracoviště' })).toBeDisabled();
  await shot(page, 'labeling-uncertain');
  await unresolved.getByRole('button', { name: 'Zkusit znovu' }).click();
  await expect(unresolved).toHaveCount(0);
  await expect(page.getByTestId('crate-content')).toContainText('3/3');
  expect(bodies[1]!.requestId).toBe(bodies[0]!.requestId); // the same attempt
  expect(bodies).toHaveLength(4);
  expect(await lotLeft()).toBe(before - 3);
  await page.unroute(/\/label-scans$/);

  // 2. Lost AFTER the server committed: the retry is replayed, never consumed twice.
  await typeScan(await crateUrl(request, kit.crateTypeCode));
  await expect(page.getByTestId('crate-content')).toContainText('0/3');
  let lostAfter = true;
  await page.route(/\/label-scans$/, async (route) => {
    if (!lostAfter) return route.fallback();
    lostAfter = false;
    await route.fetch();
    await route.abort('failed');
  });
  await typeScan(urls[6]!);
  await expect(unresolved).toContainText('není jistý');
  await unresolved.getByRole('button', { name: 'Zkusit znovu' }).click();
  await expect(page.getByTestId('labeling-notice')).toContainText('nalepena a vložena (1/3)');
  expect(await lotLeft()).toBe(before - 4);

  // 3. Committed, response lost, then the page is reloaded: scanning the bottle again only
  //    confirms it is already in THIS crate.
  lostAfter = true;
  await typeScan(urls[7]!);
  await expect(unresolved).toContainText('není jistý');
  page.once('dialog', (d) => void d.accept());
  await page.unroute(/\/label-scans$/);
  await page.reload();
  await expect(page.getByTestId('crate-content')).toContainText('2/3');
  await typeScan(urls[7]!);
  await expect(page.getByTestId('labeling-notice')).toContainText('už v této bedně je');
  await expect(page.getByTestId('crate-content')).toContainText('2/3');
  expect(await lotLeft()).toBe(before - 5);
});

test('the labelling station works at phone width', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/production/station');
  await expect(page.getByTestId('station-banner')).toBeVisible();
  await expect(page.getByTestId('labeling-context')).toBeVisible();
  await noOverflow(page);
  await shot(page, 'labeling-mobile');
});
