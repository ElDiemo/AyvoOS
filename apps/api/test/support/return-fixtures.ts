import { randomUUID } from 'node:crypto';
import type { OrderShipment, ReturnReceiptDetail } from '@ayvo/types';
import request from 'supertest';
import { expect } from 'vitest';
import { testCarrierControl } from '../../src/carriers/test-carrier.js';
import { ShipmentTrackingService } from '../../src/orders/shipment-tracking.service.js';
import { createOrder, type MadeCrate, scanCrate } from './order-fixtures.js';
import type { TestApp } from './test-app.js';

/**
 * Return intake (doc 047) fixtures for superuser test apps: orders of finished crates labelled
 * through the real API, then picked up and delivered by the FAKE test carrier (PPL's code list:
 * 150 pickup, 450 delivery) — SIMULATED, never the real PPL. Synthetic data only.
 */
export const RETURN_ENV = {
  CARRIER_PROVIDER: 'test',
  CARRIER_POLL_SECONDS: '0',
  CARRIER_SETTLE_SECONDS: '0',
  CARRIER_CALL_TIMEOUT_SECONDS: '2',
  CARRIER_TRACKING_SECONDS: '60',
};
const PICKED_UP = 150;
const DELIVERED = 450;

const http = (t: TestApp) => request(t.app.getHttpServer());

export interface ShippedOrder {
  order: string;
  shipmentId: string;
  numbers: string[];
}

/** An order of these finished crates, labelled and ready for pickup (one parcel per crate). */
export async function shipCrates(
  t: TestApp,
  hotel: string,
  productCode: string,
  crates: MadeCrate[],
): Promise<ShippedOrder> {
  const order = await createOrder(t, hotel, [{ productCode, crates: crates.length }]);
  for (const c of crates) {
    const r = await scanCrate(t, order.code, c.crateUrl);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
  }
  await http(t)
    .post(`/api/admin/orders/${order.code}/complete-and-label`)
    .send({ requestId: randomUUID(), printerId: null })
    .expect(200);
  await http(t)
    .post(`/api/admin/orders/${order.code}/shipment/ready`)
    .send({ requestId: randomUUID(), labelsApplied: true })
    .expect(200);
  const view = (await http(t).get(`/api/admin/orders/${order.code}/shipment`).expect(200))
    .body as OrderShipment;
  const shipment = await t.prisma.shipment.findFirstOrThrow({
    where: { code: view.shipment!.code },
    select: { id: true },
  });
  return {
    order: order.code,
    shipmentId: shipment.id,
    numbers: view.shipment!.parcels.map((p) => p.carrierParcelNumber!),
  };
}

/** One tracking look of the shipment, as the poller would. */
async function look(t: TestApp, shipmentId: string) {
  await t.prisma.$executeRaw`INSERT INTO "shipment_tracking" ("shipment_id", "next_at")
    VALUES (${shipmentId}::uuid, now()) ON CONFLICT ("shipment_id") DO NOTHING`;
  await t.prisma.shipmentTracking.updateMany({
    where: { shipmentId, stoppedAt: null },
    data: { nextAt: new Date(Date.now() - 1000) },
  });
  return t.app.get(ShipmentTrackingService).sync(shipmentId, false);
}

/** The carrier picks the parcels up (the crates are DISPATCHED, not delivered). */
export async function pickUp(t: TestApp, shipped: ShippedOrder) {
  for (const n of shipped.numbers) {
    testCarrierControl.track(n, { statusId: PICKED_UP, at: new Date().toISOString() });
  }
  await look(t, shipped.shipmentId);
}

/** The carrier delivers every parcel (the order and its crates are DELIVERED). */
export async function deliver(t: TestApp, shipped: ShippedOrder) {
  for (const n of shipped.numbers) {
    testCarrierControl.track(n, { statusId: DELIVERED, at: new Date().toISOString() });
  }
  await look(t, shipped.shipmentId);
  const order = await t.prisma.order.findUniqueOrThrow({
    where: { code: shipped.order },
    select: { status: true },
  });
  expect(order.status).toBe('DELIVERED');
}

/** The return intake through its API (superuser app, active site MAIN). */
export function returnsApi(t: TestApp) {
  const post = (path: string, body: object) =>
    http(t)
      .post(`/api/admin/returns${path}`)
      .send({ requestId: randomUUID(), ...body });
  return {
    post,
    async open(hotelCode: string | null = null): Promise<ReturnReceiptDetail> {
      const r = await post('/receipts', { hotelCode });
      expect(r.status, JSON.stringify(r.body)).toBe(201);
      return r.body as ReturnReceiptDetail;
    },
    detail: async (code: string) =>
      (await http(t).get(`/api/admin/returns/receipts/${code}`).expect(200))
        .body as ReturnReceiptDetail,
    scanCrate: (code: string, crateUrl: string, requestId = randomUUID()) =>
      post(`/receipts/${code}/crates`, { requestId, scannedValue: crateUrl }),
    container: (code: string) => post(`/receipts/${code}/containers`, {}),
    scanBottle: (
      code: string,
      lineId: string,
      url: string,
      outcome: 'GOOD' | 'DEFECTIVE' = 'GOOD',
      requestId = randomUUID(),
    ) =>
      post(`/receipts/${code}/lines/${lineId}/bottles`, { requestId, scannedValue: url, outcome }),
    unreadable: (code: string, lineId: string) =>
      post(`/receipts/${code}/lines/${lineId}/unreadable`, {}),
    pumps: (code: string, defective: number, reason: string | null = null) =>
      post(`/receipts/${code}/pumps`, { defective, reason }),
    empty: (code: string, lineId: string, physicalCount: number, requestId = randomUUID()) =>
      post(`/receipts/${code}/lines/${lineId}/empty`, { requestId, physicalCount }),
    close: (code: string) => post(`/receipts/${code}/close`, {}),
    identify: (
      issue: string,
      url: string,
      outcome: 'GOOD' | 'DEFECTIVE' = 'GOOD',
      requestId = randomUUID(),
    ) => post(`/issues/${issue}/identify`, { requestId, scannedValue: url, outcome }),
    closeOut: (issue: string, resolution: 'NOT_AYVO' | 'WRITTEN_OFF', reason: string) =>
      post(`/issues/${issue}/close-out`, { resolution, reason }),
  };
}
