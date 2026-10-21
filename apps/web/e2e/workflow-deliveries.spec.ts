import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import { json, measurement, noOverflow, printedBottles } from './dispatch-setup';
import { e2eSql } from './e2e-db';
import { filledCrate, labelingSetup, labelledCrate, lotIdOf, receiveStock } from './labeling-setup';

/**
 * The hotel's deliveries overview (doc 032 §4) FILLED, on the real built app with synthetic data
 * in the recreated e2e database: four orders of one hotel — fully delivered, partially delivered
 * (one parcel delivered, one only picked up), open, cancelled. SIMULATED carrier events: the test
 * carrier runs inside the API process, so this spec writes the events the carrier "reported"
 * (PPL codes 150 pickup, 450 delivery) into the e2e database only; the operator presses "Obnovit
 * tracking" and the real tracking service derives the parcels' and orders' states. The overview
 * then counts only parcels the carrier delivered, with the content stored at loading; the open
 * part separately; the cancelled order not at all. Nothing here talks to PPL.
 */
test.use({ storageState: 'e2e/.auth/admin.json', timezoneId: 'Europe/Prague' });
test.describe.configure({ mode: 'serial' });

const SHOTS = process.env.AYVO_SCREENSHOT_DIR;
const PRODUCT = 'Tekuté mýdlo (dodávky E2E)';
let hotel = '';
let productCode = '';
let today = '';
const orders = { full: '', partial: '', open: '', cancelled: '' };

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

/** Simulated carrier event of one parcel of one order (e2e database only). */
async function carrierReports(order: string, parcelNo: number, delivered: boolean) {
  const e = delivered
    ? {
        statusId: 450,
        code: 'Delivered',
        meaning: 'DELIVERED',
        name: 'Zásilku jsme doručili příjemci.',
      }
    : {
        statusId: 150,
        code: 'PickedUp',
        meaning: 'PICKED_UP',
        name: 'Zásilku jsme převzali od odesílatele.',
      };
  // "Now": a delivery belongs to the month the carrier reports it in (the site's time zone).
  const at = new Date(Date.now() + (delivered ? 1000 : 0)).toISOString();
  await e2eSql([
    `INSERT INTO "shipment_tracking_events"
       ("shipment_id", "parcel_id", "carrier_code", "carrier_environment", "carrier_parcel_number",
        "status_id", "code", "phase", "event_group", "name", "meaning", "occurred_at", "fetched_at")
     SELECT s."id", p."id", s."carrier_code", s."carrier_environment", p."carrier_parcel_number",
            ${e.statusId}, '${e.code}', NULL, NULL, '${e.name}', '${e.meaning}', '${at}', now()
       FROM "shipments" s JOIN "orders" o ON o."id" = s."order_id"
       JOIN "shipment_parcels" p ON p."shipment_id" = s."id"
      WHERE o."code" = '${order}' AND s."status" = 'LABELED' AND p."parcel_no" = ${parcelNo}
     ON CONFLICT DO NOTHING`,
  ]);
}

async function newOrder(request: APIRequestContext, crates: number): Promise<string> {
  return (
    await json<{ code: string }>(
      await request.post('/api/admin/orders', {
        data: {
          requestId: crypto.randomUUID(),
          hotelCode: hotel,
          requestedShipDate: today,
          lines: [{ productCode, crates }],
        },
      }),
    )
  ).code;
}

/** Picked crates, labels without printing, the applied labels confirmed: ready for pickup. */
async function readyForPickup(request: APIRequestContext, order: string, crateUrls: string[]) {
  for (const url of crateUrls) {
    await json(
      await request.post(`/api/admin/orders/${order}/crates`, {
        data: { requestId: crypto.randomUUID(), scannedValue: url },
      }),
    );
  }
  await json(
    await request.post(`/api/admin/orders/${order}/complete-and-label`, {
      data: { requestId: crypto.randomUUID(), printerId: null },
    }),
  );
  await json(
    await request.post(`/api/admin/orders/${order}/shipment/ready`, {
      data: { requestId: crypto.randomUUID(), labelsApplied: true },
    }),
  );
}

test.beforeAll(async ({ browser }) => {
  const context = await browser.newContext({ storageState: 'e2e/.auth/admin.json' });
  const request = context.request;
  const printed = await printedBottles(request, `dodavky-mydlo-${Date.now()}`, 8);
  // Crates of 2 bottles: the overview uses the stored content, never a constant 40.
  const kit = await labelingSetup(request, {
    versionId: printed.versionId,
    capacity: 2,
    productName: PRODUCT,
  });
  productCode = kit.productCode;
  await json(
    await request.post(`/api/admin/catalog/products/${kit.productCode}/weights`, {
      data: measurement({ recipeVersion: 1, massG: '372.5', bottlesWeighed: 10 }),
    }),
  );
  await json(
    await request.post(`/api/admin/catalog/crate-types/${kit.crateTypeCode}/tare`, {
      data: measurement({ massG: '1850', configuration: 'Bedna s přepážkami' }),
    }),
  );
  await json(
    await request.post(`/api/admin/catalog/crate-types/${kit.crateTypeCode}/dimensions`, {
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
  await receiveStock(request, kit.pumpCode, '20');
  const liquid = await lotIdOf(
    request,
    kit.liquidCode,
    (await receiveStock(request, kit.liquidCode, '5000'))!,
  );
  const crates: string[] = [];
  for (let i = 0; i < 4; i++) {
    const urls = printed.urls.slice(i * 2, i * 2 + 2);
    const crate = await labelledCrate(request, kit, {
      versionId: printed.versionId,
      bottleLotCode: bottleLot,
      urls,
    });
    await filledCrate(request, crate, {
      liquidLotId: liquid,
      bottleUrls: urls,
      category: 'HAND_SOAP',
    });
    crates.push(crate.url);
  }
  const siteId = (
    await json<{ sites: { id: string; code: string }[] }>(await request.get('/api/auth/me'))
  ).sites.find((s) => s.code === 'CZ-PREROV-01')!.id;
  hotel = (
    await json<{ code: string }>(
      await request.post('/api/admin/hotels', {
        data: {
          requestId: crypto.randomUUID(),
          name: 'Hotel Dodávky (E2E)',
          addressLine1: 'Kratochvílova 12',
          addressLine2: null,
          postalCode: '750 02',
          city: 'Přerov',
          countryCode: 'CZ',
          contactName: 'Recepce',
          contactPhone: '+420 581 000 777',
          contactEmail: 'recepce@dodavky.test',
          fulfillmentSiteId: siteId,
        },
      }),
    )
  ).code;
  today = (await json<{ today: string }>(await request.get('/api/admin/orders/calendar'))).today;
  orders.full = await newOrder(request, 2);
  await readyForPickup(request, orders.full, crates.slice(0, 2));
  orders.partial = await newOrder(request, 2);
  await readyForPickup(request, orders.partial, crates.slice(2, 4));
  orders.open = await newOrder(request, 1);
  orders.cancelled = await newOrder(request, 1);
  await json(
    await request.post(`/api/admin/orders/${orders.cancelled}/cancel`, {
      data: { requestId: crypto.randomUUID(), reason: 'Zkouška: storno se nepočítá' },
    }),
  );
  await context.close();
});

test('deliveries: nothing delivered yet — an honest empty chart, the open crates listed', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto(`/hotels/${hotel}#dodavky`);
  const section = page.getByTestId('hotel-deliveries');
  await expect(section.getByTestId('deliveries-chart-empty')).toBeVisible();
  // Ready for pickup is not delivered: 2 + 2 + 1 crates open, the cancelled one not counted.
  const [y, m] = today.split('-');
  const row = section.getByTestId(`delivery-${today.slice(0, 7)}-${productCode}`);
  await expect(row.locator('td')).toHaveText([`${Number(m)}/${y}`, PRODUCT, '0', '0', '10', '5']);
});

test('deliveries: the carrier delivers three parcels of four — orders Doručená and Převzatá dopravcem', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  for (const [order, parcels] of [
    [orders.full, [1, 2]],
    [orders.partial, [1, 2]],
  ] as const) {
    for (const n of parcels) await carrierReports(order, n, false);
  }
  await carrierReports(orders.full, 1, true);
  await carrierReports(orders.full, 2, true);
  await carrierReports(orders.partial, 1, true);
  for (const [order, summary, status] of [
    [orders.full, 'Převzato 2/2 · Doručeno 2/2', 'Doručená'],
    [orders.partial, 'Převzato 2/2 · Doručeno 1/2', 'Převzatá dopravcem'],
  ] as const) {
    await page.goto(`/dispatch/orders/${order}`);
    const card = page.getByTestId('tracking-card');
    await card.getByTestId('tracking-refresh').click();
    await expect(card.getByTestId('tracking-summary')).toHaveText(summary);
    await expect(page.getByTestId('order-status')).toHaveText(status);
  }
});

test('deliveries: the filled overview — delivered from confirmed parcels only, open separately — desktop, 390, 320', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto(`/hotels/${hotel}#dodavky`);
  const section = page.getByTestId('hotel-deliveries');
  const month = today.slice(0, 7);
  const [y, m] = month.split('-');
  const label = `${Number(m)}/${y}`;
  // 3 delivered parcels × 2 bottles stored at loading; open: the partial order's last crate
  // (handed over, not delivered) + the open order's crate; the cancelled order nowhere.
  const row = section.getByTestId(`delivery-${month}-${productCode}`);
  await expect(row.locator('td')).toHaveText([label, PRODUCT, '6', '3', '4', '2']);
  await expect(section.locator('tbody tr')).toHaveCount(1);
  const chart = section.getByTestId('deliveries-chart');
  await expect(chart.getByTestId('deliveries-chart-empty')).toHaveCount(0);
  await expect(chart.getByRole('img')).toHaveAttribute('aria-label', new RegExp(`${label}: 6`));
  await chart.locator('svg g').first().hover();
  await expect(chart.getByTestId('deliveries-tooltip')).toHaveText(`${label} · 6 doručeno lahví`);
  await expect(section).toContainText('spotřeb'); // no consumption claimed
  await section.scrollIntoViewIfNeeded();
  await shot(page, 'deliveries-01-filled-desktop');
  await page.mouse.move(0, 0);
  for (const width of [390, 320]) {
    await page.setViewportSize({ width, height: 844 });
    await noOverflow(page);
    await expect(row.locator('td').nth(2)).toHaveText('6');
    await shot(page, `deliveries-01-filled-${width}`);
  }
});
