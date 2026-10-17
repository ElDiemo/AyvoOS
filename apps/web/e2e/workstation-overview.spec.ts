import { mkdirSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import {
  fillingStation,
  newCrate,
  labelingSetup,
  receiveStock,
  releaseOwnStation,
  type LabelingSetup,
} from './labeling-setup';

/**
 * The whole stage-A flow through the UI and the normal navigation (doc 025 A5), synthetic data,
 * crate capacity 2: a labelling station labels two bottles into a crate, a filling station fills
 * them in the SAME crate and marks Hotovo; Výroba → Bedny shows the ready crate with both counts;
 * its detail lists the bottles with their liquid lot; the supervisor returns it to filling, takes
 * a finished bottle out (it is listed under "Hotové lahve mimo bednu" with the reason) and puts it
 * back — no new consumption anywhere. Screenshots go to AYVO_SCREENSHOT_DIR when it is set.
 */
test.use({ storageState: 'e2e/.auth/admin.json' });
test.describe.configure({ mode: 'serial' });

const SHOTS = process.env.AYVO_SCREENSHOT_DIR;
let kit: LabelingSetup;
let designLabel = '';
let urls: string[] = [];
let codes: string[] = [];
let bottleLot = '';
let liquidLot = '';
let crate = '';
let crateCode = '';
let fillingUrl = '';

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

const typeScan = async (page: Page, value: string) => {
  await page.keyboard.type(value);
  await page.keyboard.press('Enter');
};

/** Opens a station by scanning its QR on Výroba → Pracoviště (any open station is left first). */
async function scanStation(page: Page, stationUrl: string) {
  await releaseOwnStation(page.request);
  await page.goto('/production/station');
  const field = page.getByLabel('Naskenujte QR pracoviště');
  await expect(field).toBeFocused();
  await field.fill(stationUrl);
  await field.press('Enter');
}

test.beforeAll(async ({ browser }) => {
  const context = await browser.newContext({ storageState: 'e2e/.auth/admin.json' });
  const request = context.request;
  const printed = await printedBottles(request, `tok-${Date.now()}`, 2);
  urls = printed.urls;
  codes = printed.codes;
  designLabel = printed.version.label;
  kit = await labelingSetup(request, {
    versionId: printed.version.versionId,
    capacity: 2,
    productName: 'Sprchový gel tok (E2E)',
  });
  bottleLot = (await receiveStock(request, 'NEW_BOTTLE', '10'))!;
  liquidLot = (await receiveStock(request, kit.liquidCode, '2000'))!;
  await receiveStock(request, kit.pumpCode, '10');
  ({ url: crate, code: crateCode } = await newCrate(request, kit.crateTypeCode));
  fillingUrl = (await fillingStation(request)).url;
  await context.close();
});

test.afterAll(async ({ browser }) => {
  const context = await browser.newContext({ storageState: 'e2e/.auth/admin.json' });
  await releaseOwnStation(context.request);
  await context.close();
});

test('label → fill → Hotovo at two stations; Bedny shows the ready crate with both counts', async ({
  page,
}) => {
  // 1. Labelling station (scanned on Výroba → Pracoviště).
  await scanStation(page, kit.stationUrl);
  await expect(page.getByTestId('station-mode')).toHaveText('Lepení etiket');
  const ctx = page.getByTestId('labeling-context-form');
  await ctx
    .getByLabel('Produkt')
    .selectOption({ label: `${kit.productName} (${kit.productCode})` });
  await ctx.getByLabel('Schválený design etikety').selectOption({ label: designLabel });
  await ctx.getByLabel('Šarže nových lahví').selectOption({ label: `${bottleLot} (zbývá 10 ks)` });
  await ctx.getByRole('button', { name: 'Použít' }).click();
  await expect(page.getByTestId('crate-scan').getByRole('textbox')).toBeFocused();
  await typeScan(page, crate);
  await expect(page.getByTestId('bottle-scan').getByRole('textbox')).toBeFocused();
  await typeScan(page, urls[0]!);
  await typeScan(page, urls[1]!);
  await expect(page.getByTestId('labeling-notice')).toContainText('čeká na plnění');

  // 2. Filling station: the same crate, an explicit liquid lot, two fills, Hotovo.
  await scanStation(page, fillingUrl);
  await expect(page.getByTestId('station-mode')).toContainText('Plnění');
  await expect(page.getByTestId('crate-scan').getByRole('textbox')).toBeFocused();
  await typeScan(page, crate);
  await page
    .getByTestId('filling-lot-form')
    .getByLabel('Šarže kapaliny')
    .selectOption({ label: `${liquidLot} (zbývá 2000 ml)` });
  await page.getByRole('button', { name: 'Použít šarži' }).click();
  await expect(page.getByTestId('bottle-scan').getByRole('textbox')).toBeFocused();
  await typeScan(page, urls[0]!);
  await typeScan(page, urls[1]!);
  await expect(page.getByTestId('crate-filled')).toContainText('2/2');
  await expect(page.getByTestId('filling-lot')).toContainText('zbývá 1340 ml');
  await page.getByTestId('filling-finish').click();
  await expect(page.getByTestId('filling-notice')).toContainText(
    `Bedna ${crateCode} je připravená`,
  );

  // 3. Výroba → Bedny through the navigation: the ready crate, both counts.
  await page.getByRole('navigation', { name: 'Výroba' }).getByTestId('section-records').click(); // Evidence opens Bedny first
  await expect(page).toHaveURL(/\/production\/crates$/);
  await page.getByTestId('crate-state-FILLED').click();
  await expect(page).toHaveURL(/state=FILLED/);
  await expect(page.getByTestId(`crate-${crateCode}`)).toContainText(
    'Připravená · obsah 2/2 · naplněno 2/2',
  );
  await shot(page, 'crates-ready');
  await page.getByRole('link', { name: crateCode }).click();
  await expect(page.getByTestId('crate-cycle-status')).toHaveText('Připravená');
  await expect(page.getByTestId('crate-counts')).toHaveText('2/2 · 2/2');
  for (const code of codes) {
    await expect(page.getByTestId(`member-${code}`)).toContainText(`Šarže kapaliny: ${liquidLot}`);
  }
  await expect(page.getByTestId('crate-history')).toContainText('Hotovo – bedna připravená');
  await shot(page, 'crate-detail');
});

test('the supervisor returns the crate to filling, takes a finished bottle out and puts it back', async ({
  page,
}) => {
  await page.goto(`/production/crates/${crateCode}`);
  // Collapsed by default: corrections are not a work step (UI-24).
  await expect(page.getByTestId('crate-corrections')).toBeHidden();
  await page.getByTestId('crate-corrections-section').locator('summary').click();
  const corrections = page.getByTestId('crate-corrections');
  await corrections.getByLabel('Důvod (povinný)').fill('kontrola obsahu');
  await corrections.getByRole('button', { name: 'Vrátit do rozpracování' }).click();
  await page
    .getByTestId('reopen-dialog')
    .getByRole('button', { name: 'Vrátit do rozpracování' })
    .click();
  await expect(page.getByTestId('crate-cycle-status')).toHaveText('Plní se');

  await corrections.getByLabel('Lahev (kód nebo naskenovaný QR)').fill(urls[0]!);
  await corrections.getByLabel('Důvod (povinný)').fill('poškozená pumpička');
  await corrections.getByRole('button', { name: 'Vyjmout lahev' }).click();
  await expect(page.getByTestId('correction-notice')).toContainText('vyjmutá');
  await expect(page.getByTestId('crate-counts')).toHaveText('1/2 · 1/2');
  await expect(page.getByTestId('crate-history')).toContainText('důvod: poškozená pumpička');

  // Outside a crate: still finished, with its lot, the crate it left and the reason.
  await page.getByRole('link', { name: 'Zpět na bedny' }).click();
  await page.getByRole('link', { name: 'Lahve mimo bednu' }).click();
  const row = page.getByTestId('outside-finished').getByTestId(`outside-${codes[0]}`);
  await expect(row).toContainText('Naplněná – hotová');
  await expect(row).toContainText(`šarže ${liquidLot}`);
  await expect(row).toContainText(`vyjmuta z ${crateCode}`);
  await expect(row).toContainText('důvod: poškozená pumpička');
  await shot(page, 'outside-bottles');
  // Exact search by the scanned QR; the other groups have their own pages.
  await page.getByLabel('Hledat lahev').fill(urls[0]!);
  await page.getByRole('button', { name: 'Hledat', exact: true }).click();
  await expect(page.getByTestId('outside-range')).toHaveText('1–1 z 1');
  await expect(page.getByTestId(`outside-${codes[0]}`)).toBeVisible();
  await page.getByTestId('outside-group-labelledEmpty').click();
  await expect(page.getByTestId('outside-labelledEmpty')).toBeVisible();
  await expect(page.getByTestId(`outside-${codes[0]}`)).toHaveCount(0);

  await page.goto(`/production/crates/${crateCode}`);
  await page.getByTestId('crate-corrections-section').locator('summary').click();
  await corrections.getByLabel('Lahev (kód nebo naskenovaný QR)').fill(codes[0]!);
  await corrections.getByLabel('Důvod (povinný)').fill('vrácena po kontrole');
  await corrections.getByRole('button', { name: 'Doplnit / přeložit lahev' }).click();
  await expect(page.getByTestId('crate-counts')).toHaveText('2/2 · 2/2');
  await expect(page.getByTestId(`member-${codes[0]}`)).toContainText('přeložena (vedoucí)');
  // No step after the fills consumed anything: the liquid lot is unchanged.
  const lots = await json<{ code: string; onHand: string }[]>(
    await page.request.get(`/api/admin/inventory/lots?item=${kit.liquidCode}&available=false`),
  );
  expect(Number(lots.find((l) => l.code === liquidLot)?.onHand)).toBe(1340);
});

test('the crate overview works at phone width', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`/production/crates/${crateCode}`);
  await expect(page.getByTestId('crate-members')).toBeVisible();
  await noOverflow(page);
  await shot(page, 'crate-detail-mobile');
  await page.goto('/production/crates');
  await expect(page.getByTestId('crate-states')).toBeVisible();
  await noOverflow(page);
  await shot(page, 'crates-mobile');
  await page.goto('/production/crates/outside');
  await noOverflow(page);
});
