import { resolve } from 'node:path';
import { expect, test } from '@playwright/test';
import { json, measurement, noOverflow, printedBottles } from './dispatch-setup';
import { e2eRows, e2eSql } from './e2e-db';
import {
  filledCrate,
  labelingSetup,
  labelledCrate,
  lotIdOf,
  receiveStock,
  releaseOwnStation,
  type LabelingSetup,
} from './labeling-setup';

/**
 * R3-c (doc 048 §3.0a) on the real built app at 390 px: Výroba → Lahve and the bottle detail show
 * readiness, crate and location apart. Synthetic data; the FAKE test carrier delivers (SIMULATED
 * PPL 450 written into the recreated e2e database only). A mixed return brings back only the
 * bottles scanned individually; a printed code with no label is never stock.
 */
test.use({ storageState: 'e2e/.auth/admin.json', timezoneId: 'Europe/Prague' });
test.describe.configure({ mode: 'serial' });

const SHOTS = resolve(import.meta.dirname, '../../../docs/screenshots/returns');
let kit: LabelingSetup;
let orderCode = '';
let back = '';
let atHotel = '';
let printedOnly = '';

test.beforeAll(async ({ browser }) => {
  const context = await browser.newContext({ storageState: 'e2e/.auth/admin.json' });
  const request = context.request;
  // Crates K and L (two bottles each) and one printed code that is never labelled.
  const printed = await printedBottles(request, `poloha-${Date.now()}`, 5);
  kit = await labelingSetup(request, {
    versionId: printed.versionId,
    capacity: 2,
    productName: 'Tekuté mýdlo (poloha E2E)',
  });
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
  const bottleLot = (await receiveStock(request, 'NEW_BOTTLE', '4'))!;
  await receiveStock(request, kit.pumpCode, '4');
  const liquid = await lotIdOf(
    request,
    kit.liquidCode,
    (await receiveStock(request, kit.liquidCode, '2000'))!,
  );
  const k = printed.urls.slice(0, 2);
  const l = printed.urls.slice(2, 4);
  const crates = [];
  for (const urls of [k, l]) {
    const crate = await labelledCrate(request, kit, {
      versionId: printed.versionId,
      bottleLotCode: bottleLot,
      urls,
    });
    await filledCrate(request, crate, { liquidLotId: liquid, bottleUrls: urls });
    crates.push(crate);
  }
  const me = await json<{ sites: { id: string; code: string }[] }>(
    await request.get('/api/auth/me'),
  );
  const hotelCode = (
    await json<{ code: string }>(
      await request.post('/api/admin/hotels', {
        data: {
          requestId: crypto.randomUUID(),
          name: 'Hotel Poloha (E2E)',
          addressLine1: 'Wilsonova 6',
          addressLine2: null,
          postalCode: '750 02',
          city: 'Přerov',
          countryCode: 'CZ',
          contactName: 'Recepce',
          contactPhone: '+420 581 000 779',
          contactEmail: 'recepce@poloha.test',
          fulfillmentSiteId: me.sites.find((s) => s.code === 'CZ-PREROV-01')!.id,
        },
      }),
    )
  ).code;
  const calendar = await json<{ today: string }>(await request.get('/api/admin/orders/calendar'));
  const order = (
    await json<{ code: string }>(
      await request.post('/api/admin/orders', {
        data: {
          requestId: crypto.randomUUID(),
          hotelCode,
          requestedShipDate: calendar.today,
          lines: [{ productCode: kit.productCode, crates: 2 }],
        },
      }),
    )
  ).code;
  for (const crate of crates) {
    await json(
      await request.post(`/api/admin/orders/${order}/crates`, {
        data: { requestId: crypto.randomUUID(), scannedValue: crate.url },
      }),
    );
  }
  orderCode = order;
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
  // SIMULATED carrier: the parcel delivered (PPL 450), then the real tracking derives the states.
  await e2eSql([
    `INSERT INTO "shipment_tracking_events"
       ("shipment_id", "parcel_id", "carrier_code", "carrier_environment", "carrier_parcel_number",
        "status_id", "code", "phase", "event_group", "name", "meaning", "occurred_at", "fetched_at")
     SELECT s."id", p."id", s."carrier_code", s."carrier_environment", p."carrier_parcel_number",
            450, 'Delivered', NULL, NULL, 'Zásilku jsme doručili příjemci.', 'DELIVERED', now(), now()
       FROM "shipments" s JOIN "orders" o ON o."id" = s."order_id"
       JOIN "shipment_parcels" p ON p."shipment_id" = s."id"
      WHERE o."code" = '${order}' AND s."status" = 'LABELED'
     ON CONFLICT DO NOTHING`,
  ]);
  await json(
    await request.post(`/api/admin/orders/${order}/shipment/tracking/refresh`, {
      data: { requestId: crypto.randomUUID() },
    }),
  );
  // A mixed return: crate K scanned back, in its line K's first bottle and L's first bottle.
  const post = (path: string, data: object) =>
    request.post(`/api/admin/returns${path}`, {
      data: { requestId: crypto.randomUUID(), ...data },
    });
  const receipt = await json<{ code: string }>(await post('/receipts', { hotelCode: null }));
  const line = await json<{ lineId: string }>(
    await post(`/receipts/${receipt.code}/crates`, { scannedValue: crates[0]!.url }),
  );
  for (const url of [k[0]!, l[0]!]) {
    await json(
      await post(`/receipts/${receipt.code}/lines/${line.lineId}/bottles`, {
        scannedValue: url,
        outcome: 'GOOD',
      }),
    );
  }
  const code = async (url: string) =>
    (
      await e2eRows<{ code: string }>(
        `SELECT b."code" FROM "bottles" b JOIN "label_print_job_items" i ON i."bottle_id" = b."id"
          WHERE i."qr_url" = '${url}'`,
      )
    )[0]!.code;
  back = await code(k[0]!);
  atHotel = await code(k[1]!);
  printedOnly = await code(printed.urls[4]!);
  await releaseOwnStation(request);
  await context.close();
});

test('Lahve and the bottle detail at 390 px: readiness, crate and location apart', async ({
  page,
}) => {
  void kit;
  await page.setViewportSize({ width: 390, height: 900 });
  // Back from the hotel by its own scan: at the site, no crate, the order no longer shown.
  await page.goto(`/bottles/${back}`);
  await expect(page.getByTestId('bottle-location')).toHaveText(/^Na provozovně$/);
  await expect(page.getByText('bez bedny')).toBeVisible();
  await expect(page.getByTestId('bottle-readiness')).toContainText('Vrácená, čeká na mytí');
  // Its crate was scanned back, the bottle never: still at the hotel, with order and delivery.
  await page.goto(`/bottles/${atHotel}`);
  const location = page.getByTestId('bottle-location');
  await expect(location).toContainText('U hotelu');
  await expect(location).toContainText(`objednávka ${orderCode} · Hotel Poloha (E2E)`);
  await expect(location).toContainText('doručeno');
  await noOverflow(page);
  await page.screenshot({ path: `${SHOTS}/bottle-location-390.png`, fullPage: true });
  // A printed code with no label: waiting for its label, nowhere, in no crate.
  await page.goto(`/bottles/${printedOnly}`);
  await expect(page.getByTestId('bottle-readiness')).toContainText('Kód čekající na nalepení');
  await expect(page.getByTestId('bottle-location')).toHaveText('—');
  // The list: the same three columns.
  await page.goto(`/bottles?search=${atHotel}`);
  const row = page.locator('tbody tr').filter({ hasText: atHotel });
  await expect(row).toContainText('U hotelu');
  await expect(row).toContainText('Naplněná – hotová');
  await noOverflow(page);
});
