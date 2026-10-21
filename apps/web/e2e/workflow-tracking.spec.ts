import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { json, measurement, noOverflow, printedBottles } from './dispatch-setup';
import { e2eSql } from './e2e-db';
import { filledCrate, labelingSetup, labelledCrate, lotIdOf, receiveStock } from './labeling-setup';

/**
 * Order states and carrier tracking (doc 031) on the real built app with synthetic data and the
 * FAKE test carrier. SIMULATED carrier events: the test carrier runs inside the API process, so
 * this spec writes the events the carrier "reported" into the recreated e2e database only (as PPL
 * codes: 150 pickup, 450 delivery, an unknown one), then the operator presses "Obnovit tracking"
 * and the real service derives every state from them. Nothing here talks to PPL.
 */
test.use({ storageState: 'e2e/.auth/admin.json', timezoneId: 'Europe/Prague' });
test.describe.configure({ mode: 'serial' });

const SHOTS = process.env.AYVO_SCREENSHOT_DIR;
let orderCode = '';

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

/** Simulated carrier events of one parcel (e2e database only). */
async function carrierReports(
  parcelNo: number,
  e: { statusId: number; meaning: string; at: string; name: string; code: string },
) {
  await e2eSql([
    `INSERT INTO "shipment_tracking_events"
       ("shipment_id", "parcel_id", "carrier_code", "carrier_environment", "carrier_parcel_number",
        "status_id", "code", "phase", "event_group", "name", "meaning", "occurred_at", "fetched_at")
     SELECT s."id", p."id", s."carrier_code", s."carrier_environment", p."carrier_parcel_number",
            ${e.statusId}, '${e.code}', NULL, NULL, '${e.name}', '${e.meaning}', '${e.at}', now()
       FROM "shipments" s JOIN "orders" o ON o."id" = s."order_id"
       JOIN "shipment_parcels" p ON p."shipment_id" = s."id"
      WHERE o."code" = '${orderCode}' AND s."status" = 'LABELED' AND p."parcel_no" = ${parcelNo}
     ON CONFLICT DO NOTHING`,
  ]);
}
const pickup = (n: number, at: string) =>
  carrierReports(n, {
    statusId: 150,
    code: 'PickedUp',
    meaning: 'PICKED_UP',
    at,
    name: 'Zásilku jsme převzali od odesílatele.',
  });
const delivery = (n: number, at: string) =>
  carrierReports(n, {
    statusId: 450,
    code: 'Delivered',
    meaning: 'DELIVERED',
    at,
    name: 'Zásilku jsme doručili příjemci.',
  });

test.beforeAll(async ({ browser }) => {
  const context = await browser.newContext({ storageState: 'e2e/.auth/admin.json' });
  const request = context.request;
  const printed = await printedBottles(request, `tracking-mydlo-${Date.now()}`, 6);
  const kit = await labelingSetup(request, {
    versionId: printed.versionId,
    capacity: 2,
    productName: 'Tekuté mýdlo (tracking E2E)',
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
  const bottleLot = (await receiveStock(request, 'NEW_BOTTLE', '20'))!;
  await receiveStock(request, kit.pumpCode, '20');
  const liquid = await lotIdOf(
    request,
    kit.liquidCode,
    (await receiveStock(request, kit.liquidCode, '5000'))!,
  );
  const crates: { url: string; code: string }[] = [];
  for (let i = 0; i < 3; i++) {
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
    crates.push(crate);
  }
  const siteId = (
    await json<{ sites: { id: string; code: string }[] }>(await request.get('/api/auth/me'))
  ).sites.find((s) => s.code === 'CZ-PREROV-01')!.id;
  const hotelCode = (
    await json<{ code: string }>(
      await request.post('/api/admin/hotels', {
        data: {
          requestId: crypto.randomUUID(),
          name: 'Hotel Tracking (E2E)',
          addressLine1: 'Wilsonova 3',
          addressLine2: null,
          postalCode: '750 02',
          city: 'Přerov',
          countryCode: 'CZ',
          contactName: 'Recepce',
          contactPhone: '+420 581 000 888',
          contactEmail: 'recepce@tracking.test',
          fulfillmentSiteId: siteId,
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
          lines: [{ productCode: kit.productCode, crates: 3 }],
        },
      }),
    )
  ).code;
  for (const c of crates) {
    await json(
      await request.post(`/api/admin/orders/${orderCode}/crates`, {
        data: { requestId: crypto.randomUUID(), scannedValue: c.url },
      }),
    );
  }
  // Labels without printing; then the operator confirms the applied labels.
  await json(
    await request.post(`/api/admin/orders/${orderCode}/complete-and-label`, {
      data: { requestId: crypto.randomUUID(), printerId: null },
    }),
  );
  await json(
    await request.post(`/api/admin/orders/${orderCode}/shipment/ready`, {
      data: { requestId: crypto.randomUUID(), labelsApplied: true },
    }),
  );
  await context.close();
});

test('tracking: one parcel picked up — Převzato 1/3, the order still ready, not cancellable', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto(`/dispatch/orders/${orderCode}`);
  await expect(page.getByTestId('order-status')).toHaveText('Připravená k vyzvednutí');
  const card = page.getByTestId('tracking-card');
  await expect(card.getByTestId('tracking-summary')).toHaveText('Převzato 0/3 · Doručeno 0/3');
  await pickup(1, '2026-10-21T12:10:00Z');
  await card.getByTestId('tracking-refresh').click();
  await expect(card.getByTestId('tracking-summary')).toHaveText('Převzato 1/3 · Doručeno 0/3');
  await expect(card.getByTestId('tracking-parcel-1-state')).toContainText('Převzato');
  await expect(card.getByTestId('tracking-parcel-2-state')).toHaveText('Čeká na převzetí');
  await expect(card.getByTestId('tracking-checked')).toContainText('Naposledy ověřeno u dopravce');
  // A partial pickup: the order stays ready for pickup; a cancellation is refused.
  await expect(page.getByTestId('order-status')).toHaveText('Připravená k vyzvednutí');
  const cancel = await page.request.post(`/api/admin/orders/${orderCode}/shipment/cancel`, {
    data: { requestId: crypto.randomUUID(), reason: 'Zkouška storna po převzetí' },
  });
  expect(cancel.status()).toBe(409);
  expect((await cancel.json()).code).toBe('PARCELS_WITH_CARRIER');
  // Nor a print of every label: only single parcels are printed again.
  await expect(page.getByTestId('print-card').getByTestId('print-all')).toHaveCount(0);
  await shot(page, 'tracking-01-partial-pickup-desktop');
});

test('tracking: every parcel with the carrier, two delivered, an unknown code kept — desktop, 390, 320', async ({
  page,
}) => {
  await pickup(2, '2026-10-21T12:12:00Z');
  await pickup(3, '2026-10-21T12:13:00Z');
  await delivery(1, '2026-10-22T08:30:00Z');
  await delivery(2, '2026-10-22T09:05:00Z');
  // A code not in PPL's list as we know it: kept as unknown, changes nothing.
  await carrierReports(3, {
    statusId: 7777,
    code: 'Unknown.Test',
    meaning: 'UNKNOWN',
    at: '2026-10-22T07:00:00Z',
    name: 'Simulace: neznámá událost',
  });
  // Parcel 3 going back to the sender: a warning on that parcel, never a delivery (owner 2026-10-21).
  await carrierReports(3, {
    statusId: 718,
    code: 'Return.Test',
    meaning: 'RETURNING',
    at: '2026-10-22T09:30:00Z',
    name: 'Zásilka bude vrácena zpět odesílateli.',
  });
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto(`/dispatch/orders/${orderCode}`);
  const card = page.getByTestId('tracking-card');
  await card.getByTestId('tracking-refresh').click();
  await expect(card.getByTestId('tracking-summary')).toHaveText('Převzato 3/3 · Doručeno 2/3');
  await expect(page.getByTestId('order-status')).toHaveText('Převzatá dopravcem');
  await expect(card.getByTestId('tracking-parcel-1-state')).toContainText('Doručeno');
  await expect(card.getByTestId('tracking-parcel-3-state')).toContainText('Převzato');
  const warning = card.getByTestId('tracking-warning-3');
  await expect(warning).toContainText('Balík 3');
  await expect(warning).toContainText('vrací se odesílateli – není doručení hotelu');
  await expect(warning).toContainText('PPL: „Zásilka bude vrácena zpět odesílateli.“');
  await expect(card.getByTestId('tracking-warnings')).not.toContainText('Balík 1');
  await expect(card).toContainText('Nic se automaticky nestornuje');
  // The history is collapsed; it shows PPL's own code and the time it was fetched.
  const history = card.getByTestId('tracking-history-3');
  await expect(history.getByText('kód 7777')).toBeHidden();
  await history.locator('summary').click();
  await expect(history).toContainText('kód 7777 (Unknown.Test)');
  await expect(history).toContainText('neznámý kód');
  await expect(history).toContainText('načteno');
  // A reload shows the same truth.
  await page.reload();
  await expect(card.getByTestId('tracking-summary')).toHaveText('Převzato 3/3 · Doručeno 2/3');
  await shot(page, 'tracking-02-in-transit-desktop');
  for (const width of [390, 320]) {
    await page.setViewportSize({ width, height: 844 });
    await noOverflow(page);
    await shot(page, `tracking-02-in-transit-${width}`);
  }
});

test('tracking: the last parcel delivered — the order Doručená; checking ends', async ({
  page,
}) => {
  await delivery(3, '2026-10-22T10:40:00Z');
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`/dispatch/orders/${orderCode}`);
  const card = page.getByTestId('tracking-card');
  await card.getByTestId('tracking-refresh').click();
  await expect(card.getByTestId('tracking-summary')).toHaveText('Převzato 3/3 · Doručeno 3/3');
  await expect(page.getByTestId('order-status')).toHaveText('Doručená');
  // The return reported before the delivery is no longer a current problem.
  await expect(card.getByTestId('tracking-warnings')).toHaveCount(0);
  await expect(card.getByTestId('tracking-checked')).toContainText('ověřování skončilo');
  await expect(card.getByTestId('tracking-refresh')).toHaveCount(0);
  await noOverflow(page);
  await shot(page, 'tracking-03-delivered-390');
  await page.setViewportSize({ width: 320, height: 700 });
  await noOverflow(page);
  await shot(page, 'tracking-03-delivered-320');
});
