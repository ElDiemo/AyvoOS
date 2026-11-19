import { expect, type APIRequestContext } from '@playwright/test';
import { json, measurement, printedBottles } from './dispatch-setup';
import { e2eSql } from './e2e-db';
import { filledCrate, labelingSetup, labelledCrate, lotIdOf, receiveStock } from './labeling-setup';

export interface SeededCrate {
  url: string;
  code: string;
  bottles: string[];
}

/**
 * One hotel order of N crates × C filled bottles, delivered by a SIMULATED carrier event (the
 * recreated e2e database only, FAKE test carrier), and an open return receipt for that hotel
 * opened after the delivery. Synthetic data.
 */
export async function deliveredReceipt(
  request: APIRequestContext,
  { crates: N, capacity: C, name }: { crates: number; capacity: number; name: string },
): Promise<{ receipt: string; crates: SeededCrate[] }> {
  const crates: SeededCrate[] = [];
  const printed = await printedBottles(
    request,
    `${name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}-${Date.now()}`,
    N * C,
  );
  const kit = await labelingSetup(request, {
    versionId: printed.versionId,
    capacity: C,
    productName: `Tekuté mýdlo (${name})`,
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
          name: `Hotel ${name} (E2E)`,
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
  const receipt = (
    await json<{ code: string }>(
      await request.post('/api/admin/returns/receipts', {
        data: { requestId: crypto.randomUUID(), hotelCode },
      }),
    )
  ).code;
  return { receipt, crates };
}
