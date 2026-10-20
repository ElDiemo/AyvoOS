import { randomUUID } from 'node:crypto';
import type { OrderDetail, OrderShipment } from '@ayvo/types';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { testCarrierControl } from '../src/carriers/test-carrier.js';
import {
  ShipmentTrackingService,
  TRACKING_MAX_FAILURES,
} from '../src/orders/shipment-tracking.service.js';
import { crateFactory, createHotel, createOrder, scanCrate } from './support/order-fixtures.js';
import { createTestApp, hasDatabase, type TestApp } from './support/test-app.js';

/**
 * Order states and automatic carrier tracking (doc 031) against the real database and the FAKE
 * test carrier, whose tracking events use PPL's code list (`statusId`) — SIMULATED, never the real
 * PPL. Pickup 150/151, delivery 450–453; everything else is history or a warning. Each parcel by its
 * own number; partial pickup/delivery; repeated, late and unknown events; a missing parcel; an
 * outage with back-off and pause; concurrent looks; an earlier manual hand-over.
 */
const ENV = {
  CARRIER_PROVIDER: 'test',
  CARRIER_POLL_SECONDS: '0',
  CARRIER_SETTLE_SECONDS: '0',
  CARRIER_CALL_TIMEOUT_SECONDS: '2',
  CARRIER_TRACKING_SECONDS: '60',
};

const PICKED_UP = 150;
const DELIVERED = 450;
const WAITING = 900; // „Čekáme na přijetí zásilky do přepravy.“ — data only
const PICKUP_POINT = 343;
const NOT_DELIVERED = 458;
const IN_TRANSIT = 500;
const CANCELLED_AT_PPL = 999;

describe.skipIf(!hasDatabase)('order states and carrier tracking (doc 031)', () => {
  let t: TestApp;
  let factory: Awaited<ReturnType<typeof crateFactory>>;
  let hotel: string;
  const http = () => request(t.app.getHttpServer());
  const rid = () => randomUUID();
  const tracking = () => t.app.get(ShipmentTrackingService);
  const view = async (order: string) =>
    (await http().get(`/api/admin/orders/${order}/shipment`).expect(200)).body as OrderShipment;
  const detail = async (order: string) =>
    (await http().get(`/api/admin/orders/${order}`).expect(200)).body as OrderDetail;
  const post = (order: string, path: string, body: object = {}) =>
    http()
      .post(`/api/admin/orders/${order}/shipment/${path}`)
      .send({ requestId: rid(), ...body });
  const at = (minutes: number) => new Date(Date.UTC(2026, 9, 21, 8, minutes)).toISOString();

  /** A labelled order of `crates` crates; returns its code, shipment id and parcel numbers. */
  async function labelled(crates: number, ready = true) {
    await factory.refill();
    const made = [];
    for (let i = 0; i < crates; i++) made.push(await factory.make());
    const order = await createOrder(t, hotel, [{ productCode: factory.kit.productCode, crates }]);
    for (const c of made) expect((await scanCrate(t, order.code, c.crateUrl)).status).toBe(200);
    await http()
      .post(`/api/admin/orders/${order.code}/complete-and-label`)
      .send({ requestId: rid(), printerId: null })
      .expect(200);
    if (ready) await post(order.code, 'ready', { labelsApplied: true }).expect(200);
    const v = await view(order.code);
    const shipment = await t.prisma.shipment.findFirstOrThrow({
      where: { code: v.shipment!.code },
      select: { id: true },
    });
    return {
      order: order.code,
      shipmentId: shipment.id,
      numbers: v.shipment!.parcels.map((p) => p.carrierParcelNumber!),
    };
  }
  /** Makes the shipment due and looks once (as the poller would). */
  async function look(shipmentId: string) {
    await t.prisma.$executeRaw`INSERT INTO "shipment_tracking" ("shipment_id", "next_at")
      VALUES (${shipmentId}::uuid, now()) ON CONFLICT ("shipment_id") DO NOTHING`;
    await t.prisma.shipmentTracking.updateMany({
      where: { shipmentId, stoppedAt: null },
      data: { nextAt: new Date(Date.now() - 1000) },
    });
    return tracking().sync(shipmentId, false);
  }
  const cycles = async (order: string) =>
    (
      await t.prisma.orderCrateAllocation.findMany({
        where: { order: { code: order }, releasedAt: null },
        include: { cycle: { select: { status: true } }, crate: { select: { code: true } } },
        orderBy: { allocatedAt: 'asc' },
      })
    ).map((a) => a.cycle.status);
  const carrierEvents = (order: string) =>
    t.prisma.orderEvent.findMany({
      where: { order: { code: order }, source: 'CARRIER' },
      orderBy: [{ occurredAt: 'asc' }, { id: 'asc' }],
    });

  beforeAll(async () => {
    t = await createTestApp(ENV);
    factory = await crateFactory(t, { capacity: 2 });
    hotel = (await createHotel(t, { name: 'Hotel Tracking' })).code;
  });
  afterAll(async () => {
    testCarrierControl.reset();
    await t?.close();
  });
  beforeEach(() => {
    testCarrierControl.reset();
    testCarrierControl.rules.parcelWeight = 'NOT_USED';
  });

  it('three parcels: each by its own number — Převzato 1/3, then all, then Doručeno 2/3 and 3/3', async () => {
    const o = await labelled(3);
    const [n1, n2, n3] = o.numbers as [string, string, string];
    // Data only: nothing proven ("Čekáme na přijetí" and a shipmentState of "Undelivered" alike).
    testCarrierControl.track(n1, { statusId: WAITING, at: at(0) });
    testCarrierControl.track(n2, { statusId: WAITING, at: at(0) });
    testCarrierControl.track(n3, { statusId: WAITING, at: at(0) });
    expect(await look(o.shipmentId)).toBe('SYNCED');
    let v = await view(o.order);
    expect(v.shipment!.tracking).toMatchObject({ pickedUp: 0, delivered: 0, parcels: 3 });
    expect((await detail(o.order)).status).toBe('READY_FOR_PICKUP');

    // Parcel 2 picked up (asked as n1, n2, n3 — answered by number, not position).
    testCarrierControl.track(n2, { statusId: PICKED_UP, at: at(10) });
    await look(o.shipmentId);
    v = await view(o.order);
    expect(v.shipment!.tracking).toMatchObject({ pickedUp: 1, delivered: 0 });
    expect(v.shipment!.parcels.map((p) => p.tracking!.pickedUp?.source ?? null)).toEqual([
      null,
      'CARRIER',
      null,
    ]);
    expect(v.shipment!.parcels[1]!.tracking!.pickedUp!.at).toBe(at(10));
    expect((await detail(o.order)).status).toBe('READY_FOR_PICKUP');
    expect(await cycles(o.order)).toEqual(['ALLOCATED', 'DISPATCHED', 'ALLOCATED']);
    // The carrier has a parcel: no ordinary cancellation releases the order and its crates.
    const cancel = await post(o.order, 'cancel', { reason: 'Hotel zrušil' });
    expect([cancel.status, cancel.body.code]).toEqual([409, 'PARCELS_WITH_CARRIER']);

    // The same answer again: nothing doubled.
    const before = await t.prisma.shipmentTrackingEvent.count({
      where: { shipmentId: o.shipmentId },
    });
    await look(o.shipmentId);
    expect(
      await t.prisma.shipmentTrackingEvent.count({ where: { shipmentId: o.shipmentId } }),
    ).toBe(before);

    // The others picked up → the order is with the carrier (proven by PPL, not confirmed by hand).
    testCarrierControl.track(n1, { statusId: PICKED_UP, at: at(12) });
    testCarrierControl.track(n3, { statusId: PICKED_UP, at: at(11) });
    await look(o.shipmentId);
    let d = await detail(o.order);
    expect(d.status).toBe('HANDED_TO_CARRIER');
    expect(await cycles(o.order)).toEqual(['DISPATCHED', 'DISPATCHED', 'DISPATCHED']);
    const handed = d.history.filter((h) => h.type === 'HANDED_TO_CARRIER');
    expect(handed).toEqual([
      expect.objectContaining({ source: 'CARRIER', actor: null, occurredAt: at(12) }),
    ]);

    // Two delivered, the third at a pick-up point (not the hotel) → Doručeno 2/3.
    testCarrierControl.track(
      n1,
      { statusId: IN_TRANSIT, at: at(30) },
      { statusId: DELIVERED, at: at(40) },
    );
    testCarrierControl.track(n2, { statusId: DELIVERED, at: at(41) });
    testCarrierControl.track(n3, { statusId: PICKUP_POINT, at: at(42) });
    await look(o.shipmentId);
    v = await view(o.order);
    expect(v.shipment!.tracking).toMatchObject({ pickedUp: 3, delivered: 2 });
    expect(v.shipment!.parcels[2]!.tracking!.warning).toMatchObject({ meaning: 'PICKUP_POINT' });
    expect((await detail(o.order)).status).toBe('HANDED_TO_CARRIER');
    expect(await cycles(o.order)).toEqual(['DELIVERED', 'DELIVERED', 'DISPATCHED']);

    // A late, older event and a "not delivered" after the delivery never move anything back.
    testCarrierControl.track(
      n1,
      { statusId: NOT_DELIVERED, at: at(50) },
      { statusId: IN_TRANSIT, at: at(5) },
    );
    await look(o.shipmentId);
    v = await view(o.order);
    expect(v.shipment!.parcels[0]!.tracking!.deliveredAt).toBe(at(40));
    expect(v.shipment!.tracking).toMatchObject({ delivered: 2 });

    // The last one delivered → the order is delivered; tracking is done.
    testCarrierControl.track(n3, { statusId: DELIVERED, at: at(55) });
    await look(o.shipmentId);
    d = await detail(o.order);
    expect(d.status).toBe('DELIVERED');
    expect(await cycles(o.order)).toEqual(['DELIVERED', 'DELIVERED', 'DELIVERED']);
    v = await view(o.order);
    expect(v.shipment!.tracking).toMatchObject({
      delivered: 3,
      stopped: 'DELIVERED',
      nextAt: null,
    });
    expect(d.history.filter((h) => h.source === 'CARRIER').map((h) => h.type)).toEqual([
      'PARCEL_PICKED_UP',
      'PARCEL_PICKED_UP',
      'PARCEL_PICKED_UP',
      'HANDED_TO_CARRIER',
      'PARCEL_DELIVERED',
      'PARCEL_DELIVERED',
      'PARCEL_DELIVERED',
      'DELIVERED',
    ]);
    // A delivery does not complete the bottles' reuse cycle: they stay as they were.
    const held = await t.prisma.orderCrateAllocation.findMany({
      where: { order: { code: o.order }, releasedAt: null },
      select: { cycleId: true },
    });
    const bottles = await t.prisma.crateAssignment.findMany({
      where: { cycleId: { in: held.map((h) => h.cycleId) }, releasedAt: null },
      include: { bottle: { select: { status: true } } },
    });
    expect(new Set(bottles.map((b) => b.bottle.status))).toEqual(new Set(['FILLED']));
    // Nothing more is asked about a delivered order.
    const calls = testCarrierControl.trackCalls;
    await tracking().due();
    expect(testCarrierControl.trackCalls).toBe(calls);
    expect((await post(o.order, 'tracking/refresh').expect(200)).body).toMatchObject({
      shipment: { tracking: { stopped: 'DELIVERED' } },
    });
    expect(testCarrierControl.trackCalls).toBe(calls);
  });

  it('delivered without a pickup event: picked up with an unknown time (never invented); a late pickup event fills it', async () => {
    const o = await labelled(2, false);
    const [n1] = o.numbers as [string, string];
    testCarrierControl.track(n1, { statusId: DELIVERED, at: at(20) });
    await look(o.shipmentId);
    let v = await view(o.order);
    expect(v.shipment!.parcels[0]!.tracking).toMatchObject({
      pickedUp: { source: 'CARRIER_IMPLIED', at: null },
      deliveredAt: at(20),
    });
    expect(await cycles(o.order)).toEqual(['DELIVERED', 'ALLOCATED']);
    expect((await carrierEvents(o.order)).map((e) => e.type)).toEqual(['PARCEL_DELIVERED']);
    // Not ready confirmed, one of two delivered: still at the site.
    expect((await detail(o.order)).status).toBe('READY_TO_DISPATCH');
    testCarrierControl.track(n1, { statusId: PICKED_UP, at: at(5) });
    await look(o.shipmentId);
    v = await view(o.order);
    expect(v.shipment!.parcels[0]!.tracking!.pickedUp).toEqual({ source: 'CARRIER', at: at(5) });
    expect(await cycles(o.order)).toEqual(['DELIVERED', 'ALLOCATED']);
  });

  it('unknown and data-only codes are kept as they are and change nothing', async () => {
    const o = await labelled(1);
    const [n1] = o.numbers as [string];
    testCarrierControl.track(
      n1,
      { statusId: WAITING, at: at(0) },
      { statusId: 31337, at: at(1), name: 'Neznámý stav' },
      { statusId: null, at: at(2) },
      { statusId: CANCELLED_AT_PPL, at: at(3) },
    );
    // A newly labelled shipment is scheduled and looked at by the poller round itself.
    expect(await t.prisma.shipmentTracking.count({ where: { shipmentId: o.shipmentId } })).toBe(0);
    await tracking().due();
    expect(
      (await t.prisma.shipmentTracking.findUniqueOrThrow({ where: { shipmentId: o.shipmentId } }))
        .lastSuccessAt,
    ).not.toBeNull();
    const v = await view(o.order);
    expect(v.shipment!.parcels[0]!.tracking!.events.map((e) => [e.statusId, e.meaning])).toEqual([
      [WAITING, 'DATA'],
      [31337, 'UNKNOWN'],
      [null, 'UNKNOWN'],
      [CANCELLED_AT_PPL, 'CANCELLED'],
    ]);
    expect(v.shipment!.tracking).toMatchObject({ pickedUp: 0, delivered: 0 });
    expect((await detail(o.order)).status).toBe('READY_FOR_PICKUP');
  });

  it('a parcel the carrier does not return keeps its last known state; the others go on', async () => {
    const o = await labelled(2);
    const [n1, n2] = o.numbers as [string, string];
    testCarrierControl.track(n1, { statusId: PICKED_UP, at: at(1) });
    testCarrierControl.track(n2, { statusId: PICKED_UP, at: at(2) });
    testCarrierControl.trackMissing.add(n2);
    await look(o.shipmentId);
    const v = await view(o.order);
    expect(v.shipment!.parcels.map((p) => [!!p.tracking!.pickedUp, p.tracking!.missing])).toEqual([
      [true, false],
      [false, true],
    ]);
    expect((await detail(o.order)).status).toBe('READY_FOR_PICKUP');
  });

  it('an outage keeps the last known state, backs off, pauses after too many — "Obnovit tracking" resumes', async () => {
    const o = await labelled(1);
    const [n1] = o.numbers as [string];
    testCarrierControl.track(n1, { statusId: PICKED_UP, at: at(1) });
    await look(o.shipmentId);
    const success = (await view(o.order)).shipment!.tracking!.lastSuccessAt;
    testCarrierControl.trackFail = TRACKING_MAX_FAILURES;
    for (let i = 1; i <= TRACKING_MAX_FAILURES; i++) {
      expect(await look(o.shipmentId)).toBe('FAILED');
      const row = await t.prisma.shipmentTracking.findUniqueOrThrow({
        where: { shipmentId: o.shipmentId },
      });
      expect(row.failures).toBe(i);
      if (i < TRACKING_MAX_FAILURES) {
        // Back-off: the next look later each time (60 s × 2^(n−1), at most 6 h).
        const wait = (row.nextAt!.getTime() - Date.now()) / 1000;
        expect(wait).toBeGreaterThan(Math.min(60 * 2 ** (i - 1), 21600) - 5);
      }
    }
    let v = await view(o.order);
    expect(v.shipment!.tracking).toMatchObject({
      stopped: 'GAVE_UP',
      lastSuccessAt: success,
      failures: TRACKING_MAX_FAILURES,
      pickedUp: 1,
    });
    expect(v.shipment!.tracking!.lastError).toContain('poslední známý stav');
    // Paused: the poller leaves it alone; a person resumes it.
    const calls = testCarrierControl.trackCalls;
    await tracking().due();
    expect(testCarrierControl.trackCalls).toBe(calls);
    v = (await post(o.order, 'tracking/refresh').expect(200)).body as OrderShipment;
    expect(v.shipment!.tracking).toMatchObject({ stopped: null, failures: 0, lastError: null });
  });

  it('concurrent looks (poller twice + "Obnovit tracking"): one proof, recorded once', async () => {
    const o = await labelled(2);
    const [n1, n2] = o.numbers as [string, string];
    testCarrierControl.track(
      n1,
      { statusId: PICKED_UP, at: at(1) },
      { statusId: DELIVERED, at: at(9) },
    );
    testCarrierControl.track(n2, { statusId: PICKED_UP, at: at(2) });
    await t.prisma.$executeRaw`INSERT INTO "shipment_tracking" ("shipment_id", "next_at")
      VALUES (${o.shipmentId}::uuid, now() - interval '1 second')`;
    const results = await Promise.all([
      tracking().sync(o.shipmentId, false),
      tracking().sync(o.shipmentId, false),
      tracking().sync(o.shipmentId, true),
    ]);
    expect(results.filter((r) => r === 'SYNCED')).toHaveLength(1);
    // And once more after the lease: still recorded once.
    await look(o.shipmentId);
    expect(
      await t.prisma.shipmentTrackingEvent.count({ where: { shipmentId: o.shipmentId } }),
    ).toBe(3);
    expect((await carrierEvents(o.order)).map((e) => e.type)).toEqual([
      'PARCEL_PICKED_UP',
      'PARCEL_PICKED_UP',
      'HANDED_TO_CARRIER',
      'PARCEL_DELIVERED',
    ]);
  });

  it('a look interrupted by a restart (expired lease) simply continues', async () => {
    const o = await labelled(1);
    const [n1] = o.numbers as [string];
    testCarrierControl.track(n1, { statusId: PICKED_UP, at: at(3) });
    // A process took it and died: the lease holds it until it expires.
    await t.prisma
      .$executeRaw`INSERT INTO "shipment_tracking" ("shipment_id", "next_at", "lease_until")
      VALUES (${o.shipmentId}::uuid, now() - interval '1 second', now() + interval '1 minute')`;
    expect(await tracking().sync(o.shipmentId, false)).toBe('BUSY');
    await t.prisma.shipmentTracking.update({
      where: { shipmentId: o.shipmentId },
      data: { leaseUntil: new Date(Date.now() - 1000) },
    });
    await tracking().due();
    expect((await detail(o.order)).status).toBe('HANDED_TO_CARRIER');
  });

  it('an earlier manual hand-over stays MANUAL and distinct; the carrier then proves the delivery', async () => {
    const o = await labelled(1);
    const [n1] = o.numbers as [string];
    await post(o.order, 'hand-over', { handedOver: true }).expect(200);
    let v = await view(o.order);
    expect(v.shipment!.parcels[0]!.tracking!.pickedUp!.source).toBe('MANUAL');
    testCarrierControl.track(
      n1,
      { statusId: PICKED_UP, at: at(7) },
      { statusId: DELIVERED, at: at(30) },
    );
    await look(o.shipmentId);
    v = await view(o.order);
    // The manual confirmation is kept; the carrier's own pickup event is in the history.
    expect(v.shipment!.parcels[0]!.tracking!.pickedUp!.source).toBe('MANUAL');
    expect(v.shipment!.parcels[0]!.tracking!.events.map((e) => e.meaning)).toEqual([
      'PICKED_UP',
      'DELIVERED',
    ]);
    const d = await detail(o.order);
    expect(d.status).toBe('DELIVERED');
    expect(d.history.filter((h) => h.type === 'HANDED_TO_CARRIER').map((h) => h.source)).toEqual([
      'USER',
    ]);
  });

  it('the database refuses what tracking may not do', async () => {
    const o = await labelled(2);
    const [n1] = o.numbers as [string, string];
    testCarrierControl.track(n1, { statusId: PICKED_UP, at: at(1) });
    await look(o.shipmentId);
    const order = await t.prisma.order.findFirstOrThrow({ where: { code: o.order } });
    // Not every parcel delivered: never DELIVERED.
    await expect(
      t.prisma.order.update({ where: { id: order.id }, data: { status: 'DELIVERED' } }),
    ).rejects.toThrow(/delivered order has every parcel delivered/);
    // A shipment the carrier has is not cancelled.
    await expect(
      t.prisma
        .$executeRaw`UPDATE "shipments" SET "status" = 'CANCELLING' WHERE "id" = ${o.shipmentId}::uuid`,
    ).rejects.toThrow(/already has is not cancelled/);
    // History and progress are never removed or undone.
    await expect(
      t.prisma
        .$executeRaw`DELETE FROM "shipment_tracking_events" WHERE "shipment_id" = ${o.shipmentId}::uuid`,
    ).rejects.toThrow();
    await expect(
      t.prisma
        .$executeRaw`UPDATE "shipment_parcel_progress" SET "picked_up_source" = NULL, "picked_up_at" = NULL, "picked_up_event_id" = NULL WHERE "shipment_id" = ${o.shipmentId}::uuid`,
    ).rejects.toThrow(/recorded once/);
    // A carrier event without its source or with a user is refused.
    await expect(
      t.prisma.orderEvent.create({
        data: {
          orderId: order.id,
          type: 'PARCEL_PICKED_UP',
          occurredAt: new Date(),
          actorId: null,
          source: 'USER',
          operationRequestId: (
            await t.prisma.orderEvent.findFirstOrThrow({ where: { orderId: order.id } })
          ).operationRequestId,
        },
      }),
    ).rejects.toThrow();
  });
});
