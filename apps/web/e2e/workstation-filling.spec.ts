import { mkdirSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import {
  fillingStation,
  labelingSetup,
  labelledCrate,
  newCrate,
  openStation,
  receiveStock,
  releaseOwnStation,
  type LabelingSetup,
} from './labeling-setup';

/**
 * Filling into the same crate (doc 025 A4) on the real built app with synthetic data: crates
 * labelled through the API (capacity 3); at a filling station the operator loads the crate,
 * chooses the liquid lot explicitly and scans each bottle after filling — Obsah and Naplněno are
 * shown separately, a duplicate writes nothing, a bottle of another crate is refused, only Hotovo
 * makes the full, filled crate ready. An uncertain answer stops the queue; the retry consumes
 * once. Screenshots go to AYVO_SCREENSHOT_DIR when it is set.
 */
test.use({ storageState: 'e2e/.auth/admin.json' });
test.describe.configure({ mode: 'serial' });

const SHOTS = process.env.AYVO_SCREENSHOT_DIR;
let kit: LabelingSetup;
let urls: string[] = [];
let codes: string[] = [];
let liquidLot = '';
let crateA = { url: '', code: '' };
let crateB = { url: '', code: '' };
let crateC = { url: '', code: '' };

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
const lotLeft = async (page: Page) =>
  Number(/zbývá (\d+) ml/.exec(await page.getByTestId('filling-lot').innerText())![1]);

test.beforeAll(async ({ browser }) => {
  const context = await browser.newContext({ storageState: 'e2e/.auth/admin.json' });
  const request = context.request;
  const printed = await printedBottles(request, `plneni-${Date.now()}`, 9);
  urls = printed.urls;
  codes = printed.codes;
  kit = await labelingSetup(request, { versionId: printed.version.versionId, capacity: 3 });
  const bottleLot = (await receiveStock(request, 'NEW_BOTTLE', '20'))!;
  liquidLot = (await receiveStock(request, kit.liquidCode, '5000'))!;
  await receiveStock(request, kit.pumpCode, '50');
  const labelled = (slice: string[]) =>
    labelledCrate(request, kit, {
      versionId: printed.version.versionId,
      bottleLotCode: bottleLot,
      urls: slice,
    });
  crateA = await labelled(urls.slice(0, 3));
  crateB = await labelled(urls.slice(3, 6));
  crateC = await labelled(urls.slice(6, 9));
  const station = await fillingStation(request);
  await openStation(request, station.url);
  await context.close();
});

test.afterAll(async ({ browser }) => {
  const context = await browser.newContext({ storageState: 'e2e/.auth/admin.json' });
  await releaseOwnStation(context.request);
  await context.close();
});

test('fills the same crate: explicit liquid lot, Obsah ≠ Naplněno, duplicate, foreign bottle, Hotovo', async ({
  page,
}) => {
  await page.goto('/production/station');
  await expect(page.getByTestId('crate-scan')).toBeVisible();
  // The scanner types only into the focused scan field.
  await expect(page.getByTestId('crate-scan').getByRole('textbox')).toBeFocused();
  await typeScan(page, crateA.url);
  await expect(page.getByTestId('filling-notice')).toContainText(`Bedna ${crateA.code} je načtená`);
  await expect(page.getByTestId('crate-content')).toContainText('3/3');
  await expect(page.getByTestId('crate-filled')).toContainText('0/3');
  // The lot is chosen explicitly — never pre-selected.
  const lotSelect = page.getByTestId('filling-lot-form').getByLabel('Šarže kapaliny');
  await expect(lotSelect).toHaveValue('');
  await lotSelect.selectOption({ label: `${liquidLot} (zbývá 5000 ml)` });
  await shot(page, 'filling-lot');
  await page.getByRole('button', { name: 'Použít šarži' }).click();
  await expect(page.getByTestId('filling-lot')).toContainText(`Šarže ${liquidLot}: zbývá 5000 ml`);
  await expect(page.getByTestId('filling-finish')).toBeDisabled();

  await typeScan(page, urls[0]!);
  await expect(page.getByTestId('filling-notice')).toContainText(`${codes[0]} naplněna (1/3)`);
  await expect(page.getByTestId('crate-filled')).toContainText('1/3');
  await expect(page.getByTestId('crate-content')).toContainText('3/3');
  expect(await lotLeft(page)).toBe(4670);
  await typeScan(page, urls[0]!);
  await expect(page.getByTestId('filling-notice')).toContainText('už je naplněná');
  await typeScan(page, urls[3]!); // a bottle of crate B
  await expect(page.getByTestId('filling-notice')).toContainText('patří do jiné bedny');
  expect(await lotLeft(page)).toBe(4670);
  // A rapid series: queued in order.
  await typeScan(page, urls[1]!);
  await typeScan(page, urls[2]!);
  await expect(page.getByTestId('crate-filled')).toContainText('3/3');
  expect(await lotLeft(page)).toBe(4010);
  await shot(page, 'filling-scans');
  await page.getByTestId('filling-finish').click();
  await expect(page.getByTestId('filling-notice')).toContainText(
    `Bedna ${crateA.code} je připravená`,
  );
  await expect(page.getByTestId('crate-scan')).toBeVisible();
  // The scanner types only into the focused scan field.
  await expect(page.getByTestId('crate-scan').getByRole('textbox')).toBeFocused();
  await shot(page, 'filling-done');
});

test('an uncertain fill stops the queue; Hotovo and the crate are blocked; the retry consumes once', async ({
  page,
}) => {
  await page.goto('/production/station');
  await expect(page.getByTestId('crate-scan')).toBeVisible();
  // The scanner types only into the focused scan field.
  await expect(page.getByTestId('crate-scan').getByRole('textbox')).toBeFocused();
  await typeScan(page, crateB.url);
  // The liquid lot stays chosen for the next crate of the same liquid.
  await expect(page.getByTestId('filling-lot')).toContainText(`Šarže ${liquidLot}`);
  const before = await lotLeft(page);
  const bodies: { requestId: string }[] = [];
  let lostAfter = true;
  await page.route(/\/fill-scans$/, async (route) => {
    bodies.push(JSON.parse(route.request().postData() ?? '{}'));
    if (!lostAfter) return route.fallback();
    lostAfter = false;
    await route.fetch(); // committed on the server …
    await route.abort('failed'); // … but the answer is lost
  });
  await typeScan(page, urls[3]!);
  const unresolved = page.getByTestId('filling-unresolved');
  await expect(unresolved).toContainText('Výsledek posledního scanu není jistý');
  await typeScan(page, urls[4]!);
  await typeScan(page, urls[5]!);
  await expect(page.getByTestId('filling-waiting')).toHaveText('Čeká na odeslání: 2');
  await expect(page.getByRole('button', { name: 'Jiná bedna' })).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Změnit šarži' })).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Opustit pracoviště' })).toBeDisabled();
  expect(bodies).toHaveLength(1);
  await shot(page, 'filling-uncertain');
  await unresolved.getByRole('button', { name: 'Zkusit znovu' }).click();
  await expect(unresolved).toHaveCount(0);
  await expect(page.getByTestId('crate-filled')).toContainText('3/3');
  expect(bodies[1]!.requestId).toBe(bodies[0]!.requestId);
  expect(await lotLeft(page)).toBe(before - 990); // three bottles, each once
  await page.unroute(/\/fill-scans$/);
  await page.getByTestId('filling-finish').click();
  await expect(page.getByTestId('filling-notice')).toContainText('je připravená');
});

test('the filling station works at phone width', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/production/station');
  await expect(page.getByTestId('crate-scan')).toBeVisible();
  // The scanner types only into the focused scan field.
  await expect(page.getByTestId('crate-scan').getByRole('textbox')).toBeFocused();
  await typeScan(page, crateC.url);
  await expect(page.getByTestId('crate-content')).toContainText('3/3');
  await typeScan(page, urls[6]!);
  await expect(page.getByTestId('crate-filled')).toContainText('1/3');
  await noOverflow(page);
  await shot(page, 'filling-mobile');
});

test('a completely filled crate finishes without a liquid lot; another crate loads before a lot is chosen', async ({
  page,
}) => {
  const request = page.request;
  // Own product and liquid: exactly two bottles' worth, used up by the fills below.
  const printed = await printedBottles(request, `bez-sarze-${Date.now()}`, 4);
  const k = await labelingSetup(request, {
    versionId: printed.version.versionId,
    capacity: 2,
    productName: 'Mýdlo bez šarže (E2E)',
  });
  const bottleLot = (await receiveStock(request, 'NEW_BOTTLE', '10'))!;
  const liquidCode = (await receiveStock(request, k.liquidCode, '660'))!;
  await receiveStock(request, k.pumpCode, '10');
  const labelled = (slice: string[]) =>
    labelledCrate(request, k, {
      versionId: printed.version.versionId,
      bottleLotCode: bottleLot,
      urls: slice,
    });
  const a = await labelled(printed.urls.slice(0, 2));
  const c = await labelled(printed.urls.slice(2, 4)); // waits for filling, no liquid left later

  // Fill A completely through the API, abort it and repack both finished bottles into empty B.
  const lots = await json<{ id: string; code: string; onHand: string }[]>(
    await request.get(`/api/admin/inventory/lots?item=${k.liquidCode}&available=false`),
  );
  const lot = lots.find((l) => l.code === liquidCode)!;
  const session = await openStation(request, (await fillingStation(request)).url);
  const base = `/api/admin/station-sessions/${session}`;
  await json(
    await request.post(`${base}/filling-crate`, {
      data: { requestId: crypto.randomUUID(), scannedValue: a.url },
    }),
  );
  const chosen = await json<{ contextRevision: number }>(
    await request.post(`${base}/liquid-lot`, {
      data: { requestId: crypto.randomUUID(), liquidLotId: lot.id },
    }),
  );
  for (const url of printed.urls.slice(0, 2)) {
    await json(
      await request.post(`${base}/fill-scans`, {
        data: {
          requestId: crypto.randomUUID(),
          scannedValue: url,
          contextRevision: chosen.contextRevision,
        },
      }),
    );
  }
  await releaseOwnStation(request);
  await json(
    await request.post(`/api/admin/crates/${a.code}/abort-cycle`, {
      data: { requestId: crypto.randomUUID(), reason: 'nová bedna' },
    }),
  );
  const b = await newCrate(request, k.crateTypeCode);
  for (const code of printed.codes.slice(0, 2)) {
    await json(
      await request.post(`/api/admin/crates/${b.code}/add-bottle`, {
        data: { requestId: crypto.randomUUID(), bottle: code, reason: 'přeložení' },
      }),
    );
  }
  const movements = async () =>
    (await json<{ total: number }>(await request.get('/api/admin/inventory/movements?pageSize=1')))
      .total;
  const before = await movements();

  // A NEW filling session: no liquid lot chosen, none in stock — Hotovo still works.
  await openStation(request, (await fillingStation(request)).url);
  await page.goto('/production/station');
  await expect(page.getByTestId('crate-scan').getByRole('textbox')).toBeFocused();
  await typeScan(page, b.url);
  await expect(page.getByTestId('crate-content')).toContainText('2/2');
  await expect(page.getByTestId('crate-filled')).toContainText('2/2');
  await expect(page.getByTestId('filling-lot-form')).toContainText('není žádná šarže');
  await shot(page, 'filling-finish-without-lot');
  await page.getByTestId('filling-finish').click();
  await expect(page.getByTestId('filling-notice')).toContainText(`Bedna ${b.code} je připravená`);
  expect(await movements()).toBe(before); // Hotovo consumes nothing

  // A crate waiting for filling, no lot to choose: another crate can still be loaded.
  await expect(page.getByTestId('crate-scan').getByRole('textbox')).toBeFocused();
  await typeScan(page, c.url);
  await expect(page.getByTestId('crate-content')).toContainText('2/2');
  await expect(page.getByTestId('filling-finish')).toBeDisabled();
  await page.getByRole('button', { name: 'Jiná bedna' }).click();
  await expect(page.getByTestId('crate-scan')).toBeVisible();
  expect(await movements()).toBe(before);
});
