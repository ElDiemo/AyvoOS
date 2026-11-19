import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { json, measurement, noOverflow, printedBottles } from './dispatch-setup';
import { e2eRows, e2eSql } from './e2e-db';
import {
  crateUrl,
  filledCrate,
  labelingSetup,
  labelledCrate,
  lotIdOf,
  receiveStock,
  releaseOwnStation,
  type LabelingSetup,
} from './labeling-setup';

/**
 * R3-b (doc 048 §3.0, review 5829525229) on the real built app: washed bottles ("Po mytí") go into
 * a crate at the ordinary labelling station WITHOUT a lot of new bottles — the same station, the
 * same scan, no choice washed/new. A new bottle scanned there without a lot is refused and writes
 * nothing. Synthetic data; the FAKE test carrier delivers (SIMULATED PPL 450, written into the
 * recreated e2e database only). Screenshots go to AYVO_SCREENSHOT_DIR when it is set.
 */
test.use({ storageState: 'e2e/.auth/admin.json' });
test.describe.configure({ mode: 'serial' });

const SHOTS = process.env.AYVO_SCREENSHOT_DIR;
let kit: LabelingSetup;
let washed: string[] = [];
let spare = '';

async function shot(page: Page, name: string) {
  if (!SHOTS) return;
  mkdirSync(SHOTS, { recursive: true });
  await page.screenshot({ path: join(SHOTS, `${name}.png`), fullPage: true });
}

test.beforeAll(async ({ browser }) => {
  const context = await browser.newContext({ storageState: 'e2e/.auth/admin.json' });
  const request = context.request;
  // Two bottles for the first circulation, one new bottle that stays unlabelled.
  const printed = await printedBottles(request, `znovu-${Date.now()}`, 3);
  kit = await labelingSetup(request, {
    versionId: printed.versionId,
    capacity: 2,
    productName: 'Tekuté mýdlo (druhý oběh E2E)',
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
  const bottleLot = (await receiveStock(request, 'NEW_BOTTLE', '2'))!;
  await receiveStock(request, kit.pumpCode, '4');
  const liquid = await lotIdOf(
    request,
    kit.liquidCode,
    (await receiveStock(request, kit.liquidCode, '2000'))!,
  );
  washed = printed.urls.slice(0, 2);
  spare = printed.urls[2]!;
  const crate = await labelledCrate(request, kit, {
    versionId: printed.versionId,
    bottleLotCode: bottleLot,
    urls: washed,
  });
  await filledCrate(request, crate, { liquidLotId: liquid, bottleUrls: washed });
  const me = await json<{ sites: { id: string; code: string }[] }>(
    await request.get('/api/auth/me'),
  );
  const hotelCode = (
    await json<{ code: string }>(
      await request.post('/api/admin/hotels', {
        data: {
          requestId: crypto.randomUUID(),
          name: 'Hotel Druhý oběh (E2E)',
          addressLine1: 'Wilsonova 6',
          addressLine2: null,
          postalCode: '750 02',
          city: 'Přerov',
          countryCode: 'CZ',
          contactName: 'Recepce',
          contactPhone: '+420 581 000 778',
          contactEmail: 'recepce@druhy-obeh.test',
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
          lines: [{ productCode: kit.productCode, crates: 1 }],
        },
      }),
    )
  ).code;
  await json(
    await request.post(`/api/admin/orders/${order}/crates`, {
      data: { requestId: crypto.randomUUID(), scannedValue: crate.url },
    }),
  );
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
  // Returned (R1), every bottle good, then washed (R2 "Po mytí").
  const post = (path: string, data: object) =>
    request.post(`/api/admin/returns${path}`, {
      data: { requestId: crypto.randomUUID(), ...data },
    });
  const receipt = await json<{ code: string }>(await post('/receipts', { hotelCode: null }));
  const line = await json<{ lineId: string }>(
    await post(`/receipts/${receipt.code}/crates`, { scannedValue: crate.url }),
  );
  for (const url of washed) {
    await json(
      await post(`/receipts/${receipt.code}/lines/${line.lineId}/bottles`, {
        scannedValue: url,
        outcome: 'GOOD',
      }),
    );
    await json(await post('/after-wash', { scannedValue: url }));
  }
  await releaseOwnStation(request);
  await context.close();
});

test.afterAll(async ({ browser }) => {
  const context = await browser.newContext({ storageState: 'e2e/.auth/admin.json' });
  await releaseOwnStation(context.request);
  await context.close();
});

test('washed bottles at the labelling station without a lot of new bottles; a new bottle then writes nothing', async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 900 });
  await page.goto('/production/station');
  const station = page.getByLabel('Naskenujte QR pracoviště');
  await station.fill(kit.stationUrl);
  await station.press('Enter');
  await expect(page.getByTestId('station-mode')).toHaveText('Lepení etiket');

  // The context: product and design; the lot of new bottles stays "Bez šarže – jen umyté lahve".
  const ctx = page.getByTestId('labeling-context-form');
  await ctx
    .getByLabel('Produkt')
    .selectOption({ label: `${kit.productName} (${kit.productCode})` });
  // The product's one approved design.
  await ctx.getByLabel('Schválený design etikety').selectOption({ index: 1 });
  const lot = ctx.getByLabel('Šarže nových lahví');
  await expect(lot).toBeEnabled();
  await expect(lot.locator('option:checked')).toHaveText('Bez šarže – jen umyté lahve');
  await ctx.getByRole('button', { name: 'Použít' }).click();
  const context = page.getByTestId('labeling-context');
  await expect(context).toContainText('bez šarže nových lahví (jen umyté lahve)');

  const scan = async (value: string) => {
    const field = page.getByTestId('labeling').locator('input').last();
    await expect(field).toBeFocused();
    await page.keyboard.type(value);
    await page.keyboard.press('Enter');
  };
  const notice = page.getByTestId('labeling-notice');
  await scan(await crateUrl(page.request, kit.crateTypeCode));
  await expect(notice).toContainText('je připravená k vkládání lahví');
  await scan(washed[0]!);
  await expect(notice).toContainText('po mytí vložena (1/2)');
  // A new bottle without a lot: refused, nothing written (still not labelled, no new event).
  const spareState = async () =>
    (
      await e2eRows<{ status: string; events: bigint }>(
        `SELECT b."status"::text AS "status",
                (SELECT count(*) FROM "bottle_events" e WHERE e."bottle_id" = b."id") AS "events"
           FROM "bottles" b JOIN "label_print_job_items" i ON i."bottle_id" = b."id"
          WHERE i."qr_url" = '${spare}'`,
      )
    ).map((r) => [r.status, Number(r.events)]);
  const before = await spareState();
  expect(before[0]![0]).toBe('CREATED');
  await scan(spare);
  await expect(notice).toContainText('Nová lahev potřebuje šarži nových lahví');
  await expect(page.getByTestId('crate-content')).toContainText('1/2');
  expect(await spareState()).toEqual(before);
  await noOverflow(page);
  await shot(page, 'reuse-station-no-lot-390');
  // The second washed bottle: the same scan, the crate full and waiting for filling.
  await scan(washed[1]!);
  await expect(notice).toContainText('po mytí vložena (2/2)');
  await expect(notice).toContainText('je plná a čeká na plnění');
  await expect(page.getByTestId('crate-content')).toContainText('2/2');
});
