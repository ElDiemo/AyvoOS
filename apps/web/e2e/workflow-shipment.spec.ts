import { mkdirSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import {
  filledCrate,
  labelingSetup,
  labelledCrate,
  lotIdOf,
  receiveStock,
  type LabelingSetup,
} from './labeling-setup';

/**
 * Dokončení objednávky a příprava k vyzvednutí (doc 029) on the real built app with synthetic data
 * and the FAKE test carrier (CARRIER_PROVIDER=test exists only with APP_ENV=test): an order of one
 * crate of soap and two of gel, picked on a phone, becomes three parcels; the soap's reference
 * comes from its Hotovo snapshot, the gel parcels have none and are weighed; one click creates the
 * three labels; the PDF is re-opened without a new carrier request; "Připraveno k vyzvednutí" and
 * "Předáno dopravci" are explicit confirmations; nothing claims delivery. Screenshots
 * (AYVO_SCREENSHOT_DIR) are taken only after the real content is shown.
 */
test.use({ storageState: 'e2e/.auth/admin.json', timezoneId: 'Europe/Prague' });
test.describe.configure({ mode: 'serial' });

const SHOTS = process.env.AYVO_SCREENSHOT_DIR;
let soap: LabelingSetup;
let gel: LabelingSetup;
const crates: { url: string; code: string }[] = [];
let hotelCode = '';
let orderCode = '';

type Res = Awaited<ReturnType<APIRequestContext['get']>>;
async function json<T>(res: Res): Promise<T> {
  expect(res.ok(), `${res.url()} -> ${res.status()} ${await res.text()}`).toBe(true);
  return (await res.json()) as T;
}

async function shot(page: Page, name: string) {
  if (!SHOTS) return;
  mkdirSync(SHOTS, { recursive: true });
  await expect(page.locator('.animate-pulse')).toHaveCount(0);
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

const WIDTHS = [
  { name: 'desktop', width: 1280, height: 900 },
  { name: '390', width: 390, height: 844 },
  { name: '320', width: 320, height: 740 },
];
async function shots(page: Page, name: string) {
  for (const w of WIDTHS) {
    await page.setViewportSize({ width: w.width, height: w.height });
    await noOverflow(page);
    await shot(page, `${name}-${w.name}`);
  }
  await page.setViewportSize({ width: 390, height: 844 });
}

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
  const version = await json<{ versionId: string }>(
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
  return { versionId: version.versionId, urls };
}

const measurement = (extra: Record<string, unknown>) => ({
  requestId: crypto.randomUUID(),
  measuredOn: '2026-10-15',
  method: 'Plošinová váha (E2E, syntetické)',
  correctionOf: null,
  correctionReason: null,
  ...extra,
});

test.beforeAll(async ({ browser }) => {
  const context = await browser.newContext({ storageState: 'e2e/.auth/admin.json' });
  const request = context.request;
  // One label design belongs to one product: a printed series for each.
  const soapPrinted = await printedBottles(request, `preprava-mydlo-${Date.now()}`, 2);
  const gelPrinted = await printedBottles(request, `preprava-gel-${Date.now()}`, 4);
  soap = await labelingSetup(request, {
    versionId: soapPrinted.versionId,
    capacity: 2,
    productName: 'Tekuté mýdlo (přeprava E2E)',
  });
  gel = await labelingSetup(request, {
    versionId: gelPrinted.versionId,
    capacity: 2,
    productName: 'Sprchový gel (přeprava E2E)',
    category: 'SHOWER_GEL',
  });
  // Soap only: W1 references measured before Hotovo → its parcel gets a calculated reference.
  await json(
    await request.post(`/api/admin/catalog/products/${soap.productCode}/weights`, {
      data: measurement({ recipeVersion: 1, massG: '372.5', bottlesWeighed: 10 }),
    }),
  );
  await json(
    await request.post(`/api/admin/catalog/crate-types/${soap.crateTypeCode}/tare`, {
      data: measurement({ massG: '1850', configuration: 'Bedna s přepážkami' }),
    }),
  );
  await json(
    await request.post(`/api/admin/catalog/crate-types/${soap.crateTypeCode}/dimensions`, {
      data: measurement({
        subject: 'SHIPPING_PACKAGE',
        lengthMm: 600,
        widthMm: 400,
        heightMm: 300,
        extraPackaging: 'NONE',
        extraDescription: null,
        extraMassG: null,
        extraItemCode: null,
        extraInTare: null,
      }),
    }),
  );
  const bottleLot = (await receiveStock(request, 'NEW_BOTTLE', '20'))!;
  await receiveStock(request, soap.pumpCode, '20');
  await receiveStock(request, gel.pumpCode, '20');
  const soapLiquid = await lotIdOf(
    request,
    soap.liquidCode,
    (await receiveStock(request, soap.liquidCode, '5000'))!,
  );
  const gelLiquid = await lotIdOf(
    request,
    gel.liquidCode,
    (await receiveStock(request, gel.liquidCode, '5000'))!,
  );
  const make = async (
    kit: LabelingSetup,
    versionId: string,
    urls: string[],
    liquidLotId: string,
    category: string,
  ) => {
    const crate = await labelledCrate(request, kit, {
      versionId,
      bottleLotCode: bottleLot,
      urls,
    });
    await filledCrate(request, crate, { liquidLotId, bottleUrls: urls, category });
    crates.push(crate);
  };
  await make(soap, soapPrinted.versionId, soapPrinted.urls, soapLiquid, 'HAND_SOAP');
  await make(gel, gelPrinted.versionId, gelPrinted.urls.slice(0, 2), gelLiquid, 'SHOWER_GEL');
  await make(gel, gelPrinted.versionId, gelPrinted.urls.slice(2, 4), gelLiquid, 'SHOWER_GEL');

  hotelCode = (
    await json<{ code: string }>(
      await request.post('/api/admin/hotels', {
        data: {
          requestId: crypto.randomUUID(),
          name: 'Hotel Přeprava (E2E)',
          addressLine1: 'Nádražní 5',
          addressLine2: null,
          postalCode: '750 02',
          city: 'Přerov',
          countryCode: 'CZ',
          contactName: 'Recepce',
          contactPhone: '+420 581 000 222',
          contactEmail: 'recepce@preprava.test',
          fulfillmentSiteId: (
            await json<{ sites: { id: string; code: string }[] }>(await request.get('/api/auth/me'))
          ).sites.find((s) => s.code === 'CZ-PREROV-01')!.id,
        },
      }),
    )
  ).code;
  const calendar = await json<{ today: string }>(await request.get('/api/admin/orders/calendar'));
  orderCode = (
    await json<{ code: string }>(
      await request.post('/api/admin/orders', {
        data: {
          requestId: crypto.randomUUID(),
          hotelCode,
          requestedShipDate: calendar.today,
          lines: [
            { productCode: soap.productCode, crates: 1 },
            { productCode: gel.productCode, crates: 2 },
          ],
        },
      }),
    )
  ).code;
  await context.close();
});

test('picking on a phone: three crates, completion makes three parcels', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`/dispatch/orders/${orderCode}/pick`);
  for (const c of crates) {
    await expect(page.getByTestId('scan-input')).toBeFocused();
    await page.keyboard.type(c.url);
    await page.keyboard.press('Enter');
    await expect(page.getByTestId('order-crates').or(page.getByText(c.code)).first()).toBeVisible();
  }
  await expect(page.getByTestId(`line-crates-${gel.productCode}`)).toHaveText('2 / 2');
  await page.getByTestId('complete-picking').click();
  await expect(page.getByTestId('picking-ready')).toContainText('Kompletace dokončena');
  await page.goto(`/dispatch/orders/${orderCode}`);
  await expect(page.getByTestId('order-status')).toHaveText('Kompletace dokončena');
  const parcels = page.getByTestId('shipment-parcels');
  for (const [i, c] of crates.entries()) {
    await expect(parcels.getByTestId(`parcel-${i + 1}`)).toContainText(c.code);
  }
  // The soap: its Hotovo snapshot (2 × 372.5 g + 1850 g); the gel: unknown, never 0.
  await expect(page.getByTestId('parcel-1-reference')).toContainText('2,595 kg');
  await expect(page.getByTestId('parcel-1-reference')).toContainText('snímek při Hotovo');
  await expect(page.getByTestId('parcel-2-reference')).toHaveText('neznámá');
  await expect(page.getByTestId('shipment-phase')).toHaveAttribute('data-phase', 'MISSING');
  await expect(page.getByTestId('shipment-missing')).toContainText('Balík 2: hmotnost');
  await expect(page.getByTestId('create-labels')).toHaveCount(0);
  await shots(page, 'shipment-01-missing-weight');
});

test('weighing the gel parcels: actual weight kept apart from the reference', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`/dispatch/orders/${orderCode}`);
  for (const n of [2, 3]) {
    await page.getByTestId(`weigh-${n}`).click();
    const form = page.getByTestId(`weigh-form-${n}`);
    await expect(form.getByLabel('Hmotnost balíku (kg)')).toBeFocused();
    await form.getByLabel('Hmotnost balíku (kg)').fill('2,41');
    await form.getByRole('button', { name: 'Uložit vážení' }).click();
    await expect(page.getByTestId(`parcel-${n}-actual`)).toContainText('2,41 kg');
  }
  await expect(page.getByTestId('parcel-2-reference')).toHaveText('neznámá');
  await expect(page.getByTestId('shipment-phase')).toHaveAttribute('data-phase', 'CREATE');
  await expect(page.getByTestId('shipment-next-step')).toContainText('3 balíky');
  await shots(page, 'shipment-02-ready-to-create');
});

test('one click creates three labels; re-opening the PDF creates nothing new', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`/dispatch/orders/${orderCode}`);
  // A quick double tap: the button locks while the one request is open.
  await page.getByTestId('create-labels').dblclick();
  await expect(page.getByTestId('shipment-phase')).toHaveAttribute('data-phase', 'LABELED');
  for (const n of [1, 2, 3])
    await expect(page.getByTestId(`parcel-${n}-number`)).toHaveText(/TEST/);
  await expect(page.getByTestId('carrier-ref')).toBeVisible();
  // Labels exist ≠ printed ≠ ready: the order is still "Kompletace dokončena".
  await expect(page.getByTestId('order-status')).toHaveText('Kompletace dokončena');
  // Each parcel has its own label (1 crate = 1 parcel = 1 label) and there is a complete one.
  for (const n of [1, 2, 3]) {
    const own = await page.getByTestId(`parcel-${n}-label`).getAttribute('href');
    const res = await page.request.get(own!);
    expect(res.headers()['content-type']).toContain('application/pdf');
  }
  await expect(page.getByTestId('carrier-test-environment')).toHaveText(
    'Testovací prostředí dopravce',
  );
  const href = await page.getByTestId('open-labels').getAttribute('href');
  for (let i = 0; i < 2; i++) {
    const pdf = await page.request.get(href!);
    expect(pdf.headers()['content-type']).toContain('application/pdf');
  }
  const detail = await json<{ shipment: { request: { attemptNo: number } } }>(
    await page.request.get(`/api/admin/orders/${orderCode}/shipment`),
  );
  expect(detail.shipment.request.attemptNo).toBe(1);
  await expect(page.getByTestId('order-history')).toContainText('Dopravce vytvořil štítky');
  await shots(page, 'shipment-03-labels');
});

test('ready for pickup is an explicit confirmation of applied labels', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`/dispatch/orders/${orderCode}`);
  await page.getByTestId('confirm-ready').click();
  const dialog = page.getByTestId('ready-dialog');
  await expect(dialog.getByRole('button', { name: 'Potvrdit' })).toBeDisabled();
  await dialog
    .getByLabel('Všech 3 štítků je vytištěných a nalepených na správných bednách.')
    .check();
  await dialog.getByRole('button', { name: 'Potvrdit' }).click();
  await expect(page.getByTestId('order-status')).toHaveText('Připraveno k vyzvednutí');
  await expect(page.getByTestId('shipment-phase')).toHaveAttribute(
    'data-phase',
    'READY_FOR_PICKUP',
  );
  await expect(page.getByRole('button', { name: 'Stornovat objednávku' })).toHaveCount(0);
  await shots(page, 'shipment-04-ready-for-pickup');
});

test('handed to the carrier — not delivered; the crates and the hotel show it', async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`/dispatch/orders/${orderCode}`);
  await page.getByTestId('confirm-handover').click();
  const dialog = page.getByTestId('handover-dialog');
  await dialog.getByLabel('Dopravce bedny skutečně převzal.').check();
  await dialog.getByRole('button', { name: 'Potvrdit předání' }).click();
  await expect(page.getByTestId('order-status')).toHaveText('Předáno dopravci');
  await expect(page.getByTestId('shipment-next-step')).toContainText('neznamená doručení hotelu');
  await expect(page.getByTestId('order-history')).toContainText('Potvrzeno: předáno dopravci');
  await shots(page, 'shipment-05-handed-over');
  await page.goto(`/production/crates/${crates[0]!.code}`);
  await expect(page.getByText('Předaná dopravci (na cestě, ne u hotelu)').first()).toBeVisible();
  await page.goto(`/hotels/${hotelCode}`);
  await expect(page.getByTestId('hotel-orders')).toContainText(orderCode);
  await expect(page.getByTestId('hotel-orders')).toContainText('Předáno dopravci');
  await shot(page, 'shipment-06-hotel-390');
  await page.goto('/dispatch?view=closed');
  await expect(page.getByTestId(`order-${orderCode}`)).toContainText('Předáno dopravci');
});
