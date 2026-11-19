import { writeFileSync } from 'node:fs';
import { expect, test, type Page } from '@playwright/test';
import { json, measurement, printedBottles } from './dispatch-setup';
import { e2eSql } from './e2e-db';
import { filledCrate, labelingSetup, labelledCrate, lotIdOf, receiveStock } from './labeling-setup';

/**
 * MEASUREMENT (opt-in: E2E_RECEIPT_PERF=1, never in CI): one large receipt walked through in the
 * browser like an operator with a keyboard scanner — N crates × C bottles delivered by SIMULATED
 * carrier events (the recreated e2e database only), every crate scanned and freed, all but the
 * last bottle of each crate scanned on their own. Midway ANOTHER operator (the API, same receipt)
 * identifies 5 bottles and records an unreadable piece: the next scan in the browser must show
 * them. Per scan: from the click until the message AND the running total are on the screen. The
 * result is written to E2E_PERF_OUT. Synthetic data, FAKE test carrier only.
 */
const N = Number(process.env.E2E_PERF_CRATES ?? 50);
const C = 10;
test.skip(!process.env.E2E_RECEIPT_PERF, 'measurement only (E2E_RECEIPT_PERF=1)');
test.use({ storageState: 'e2e/.auth/admin.json', timezoneId: 'Europe/Prague' });
test.describe.configure({ mode: 'serial' });
test.setTimeout(3_600_000);

let receipt = '';
const crates: { url: string; code: string; bottles: string[] }[] = [];

test.beforeAll(async ({ browser }) => {
  test.setTimeout(3_600_000);
  const context = await browser.newContext({ storageState: 'e2e/.auth/admin.json' });
  const request = context.request;
  const t0 = Date.now();
  const printed = await printedBottles(request, `perf-mydlo-${Date.now()}`, N * C);
  const kit = await labelingSetup(request, {
    versionId: printed.versionId,
    capacity: C,
    productName: 'Tekuté mýdlo (velký příjem)',
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
  const bottleLot = (await receiveStock(request, 'NEW_BOTTLE', String(N * C)))!;
  await receiveStock(request, kit.pumpCode, String(N * C));
  await receiveStock(request, kit.labelCode, String(N * C));
  const liquid = await lotIdOf(
    request,
    kit.liquidCode,
    (await receiveStock(request, kit.liquidCode, String(N * C * 400)))!,
  );
  for (let i = 0; i < N; i++) {
    const urls = printed.urls.slice(i * C, i * C + C);
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
    crates.push({ ...crate, bottles: urls });
  }
  const siteId = (
    await json<{ sites: { id: string; code: string }[] }>(await request.get('/api/auth/me'))
  ).sites.find((s) => s.code === 'CZ-PREROV-01')!.id;
  const hotelCode = (
    await json<{ code: string }>(
      await request.post('/api/admin/hotels', {
        data: {
          requestId: crypto.randomUUID(),
          name: 'Hotel Velký příjem (E2E)',
          addressLine1: 'Wilsonova 7',
          addressLine2: null,
          postalCode: '750 02',
          city: 'Přerov',
          countryCode: 'CZ',
          contactName: 'Recepce',
          contactPhone: '+420 581 000 778',
          contactEmail: 'recepce@velky.test',
          fulfillmentSiteId: siteId,
        },
      }),
    )
  ).code;
  const calendar = await json<{ today: string }>(await request.get('/api/admin/orders/calendar'));
  const orderCode = (
    await json<{ code: string }>(
      await request.post('/api/admin/orders', {
        data: {
          requestId: crypto.randomUUID(),
          hotelCode,
          requestedShipDate: calendar.today,
          lines: [{ productCode: kit.productCode, crates: N }],
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
  await e2eSql([
    `INSERT INTO "shipment_tracking_events"
       ("shipment_id", "parcel_id", "carrier_code", "carrier_environment", "carrier_parcel_number",
        "status_id", "code", "phase", "event_group", "name", "meaning", "occurred_at", "fetched_at")
     SELECT s."id", p."id", s."carrier_code", s."carrier_environment", p."carrier_parcel_number",
            450, 'Delivered', NULL, NULL, 'Zásilku jsme doručili příjemci.', 'DELIVERED', now(), now()
       FROM "shipments" s JOIN "orders" o ON o."id" = s."order_id"
       JOIN "shipment_parcels" p ON p."shipment_id" = s."id"
      WHERE o."code" = '${orderCode}' AND s."status" = 'LABELED'
     ON CONFLICT DO NOTHING`,
  ]);
  await json(
    await request.post(`/api/admin/orders/${orderCode}/shipment/tracking/refresh`, {
      data: { requestId: crypto.randomUUID() },
    }),
  );
  expect(
    (await json<{ status: string }>(await request.get(`/api/admin/orders/${orderCode}`))).status,
  ).toBe('DELIVERED');
  receipt = (
    await json<{ code: string }>(
      await request.post('/api/admin/returns/receipts', {
        data: { requestId: crypto.randomUUID(), hotelCode },
      }),
    )
  ).code;
  console.log(`seed ${N}×${C} in ${Math.round((Date.now() - t0) / 1000)} s, receipt ${receipt}`);
  await context.close();
});

const counts = (crates: number, identified: number, unreadable: number) =>
  `Bedny ${crates} · přijaté lahve ${identified} (z toho ke skartaci 0) · nečitelné ${unreadable}`;

async function timed(page: Page, field: string, button: string, value: string, expected: string) {
  const start = Date.now();
  await page.getByRole('textbox', { name: field }).fill(value);
  await page.getByRole('button', { name: button }).click();
  await expect(page.getByTestId('receipt-counts')).toHaveText(expected, { timeout: 60_000 });
  // The form is free again (the next scan can go).
  await expect(page.getByRole('button', { name: button })).toBeEnabled({ timeout: 60_000 });
  return Date.now() - start;
}

const pct = (xs: number[], p: number) => {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))]!;
};

test(`large receipt in the browser: ${N} crates × ${C} bottles`, async ({ page, browser }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const detailGets: { bytes: number }[] = [];
  page.on('response', async (r) => {
    if (
      r.request().method() === 'GET' &&
      r.url().includes(`/api/admin/returns/receipts/${receipt}`)
    ) {
      detailGets.push({ bytes: (await r.body().catch(() => Buffer.alloc(0))).length });
    }
  });
  const passStart = Date.now();
  await page.goto(`/production/cycle/returns/${receipt}`);
  await expect(page.getByTestId('receipt-state')).toContainText('Otevřený');
  const crateMs: number[] = [];
  const bottleMs: number[] = [];
  let identified = 0;
  let unreadable = 0;
  const other = await browser.newContext({ storageState: 'e2e/.auth/admin.json' });
  for (let i = 0; i < N; i++) {
    const c = crates[i]!;
    crateMs.push(
      await timed(
        page,
        'Naskenujte vrácenou bednu',
        'Uvolnit bednu',
        c.url,
        counts(i + 1, identified, unreadable),
      ),
    );
    for (let b = 0; b < C - 1; b++) {
      identified++;
      bottleMs.push(
        await timed(
          page,
          'Naskenujte lahev',
          'Zapsat lahev',
          c.bottles[b]!,
          counts(i + 1, identified, unreadable),
        ),
      );
    }
    if (i === Math.floor(N / 2)) {
      // ANOTHER operator, same receipt: the last bottle of crates 0–4 and an unreadable piece.
      for (let k = 0; k < 5; k++) {
        await json(
          await other.request.post(`/api/admin/returns/receipts/${receipt}/bottles`, {
            data: {
              requestId: crypto.randomUUID(),
              scannedValue: crates[k]!.bottles[C - 1],
              outcome: 'GOOD',
            },
          }),
        );
      }
      await json(
        await other.request.post(`/api/admin/returns/receipts/${receipt}/unreadable`, {
          data: { requestId: crypto.randomUUID() },
        }),
      );
      identified += 5;
      unreadable += 1;
    }
  }
  const passMs = Date.now() - passStart;
  // The other operator's unreadable piece is on the screen, and so is every received bottle.
  const bottlesCard = page.getByTestId('return-line-bottles');
  await expect(bottlesCard.getByText('Nečitelná', { exact: false }).first()).toBeVisible();
  const all = bottlesCard.getByRole('button', { name: /Zobrazit všechny/ });
  if (await all.count()) await all.click();
  await expect(bottlesCard.getByTestId('line-bottles').locator('li')).toHaveCount(identified, {
    timeout: 60_000,
  });
  await other.close();
  const result = {
    build: process.env.E2E_PERF_LABEL ?? '',
    crates: N,
    capacity: C,
    scans: crateMs.length + bottleMs.length,
    passSeconds: Math.round(passMs / 100) / 10,
    crate: { p50: pct(crateMs, 50), p95: pct(crateMs, 95), max: Math.max(...crateMs) },
    bottle: { p50: pct(bottleMs, 50), p95: pct(bottleMs, 95), max: Math.max(...bottleMs) },
    lastTenBottles: bottleMs.slice(-10),
    firstTenBottles: bottleMs.slice(0, 10),
    detailGets: detailGets.length,
    detailMB: Math.round(detailGets.reduce((s, g) => s + g.bytes, 0) / 1e4) / 100,
    lastDetailKB: Math.round((detailGets.at(-1)?.bytes ?? 0) / 100) / 10,
  };
  console.log(JSON.stringify(result));
  if (process.env.E2E_PERF_OUT)
    writeFileSync(process.env.E2E_PERF_OUT, JSON.stringify(result, null, 1));
});
