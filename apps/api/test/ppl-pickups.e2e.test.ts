import { randomUUID } from 'node:crypto';
import type { OrderShipment, PickupBoard, PickupView, VerifyCarrierResult } from '@ayvo/types';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { CarrierPickupsService } from '../src/orders/carrier-pickups.service.js';
import { CARRIER_TEST_KEY, PPL_TEST_ACCOUNT } from './support/carrier-test-key.js';
import { FakePpl } from './support/fake-ppl.js';
import {
  completeOrder,
  crateFactory,
  createHotel,
  createOrder,
  pragueToday,
  scanCrate,
} from './support/order-fixtures.js';
import { INITIAL_SITE_ID } from './support/sign-in.js';
import { createTestApp, hasDatabase, withPrivileged, type TestApp } from './support/test-app.js';

/**
 * Pickup orders at PPL — "svoz" (doc 029 §11) — through the real adapter against a SIMULATED PPL
 * API (no real PPL host is contacted). Covers: labels never order a pickup; the documented body
 * (CollectionOrder, referenceId, shipmentCount = the planned parcels, sendDate, the registered
 * sender, no recipient, no parcel numbers); confirmed only by PPL's answer; a replay and a
 * concurrent second request send nothing again; a lost answer, a time-out and a lost Location stay
 * uncertain, are looked up by the same reference and never re-sent; refusal and import errors;
 * asynchronous processing with the poller; the site blocked while a pickup waits; the plan vs the
 * real hand-over (orders unchanged by the pickup); the exceptional closing; other sites; the
 * database rules. Synthetic data only.
 */
const KEY = CARRIER_TEST_KEY;

describe.skipIf(!hasDatabase)('PPL pickup orders (simulated PPL)', () => {
  const ppl = new FakePpl(PPL_TEST_ACCOUNT.id, PPL_TEST_ACCOUNT.secret);
  let t: TestApp;
  let factory: Awaited<ReturnType<typeof crateFactory>>;
  let hotel: string;
  const http = () => request(t.app.getHttpServer());
  const settingsUrl = `/api/admin/sites/${INITIAL_SITE_ID}/carriers/ppl`;
  const sender = {
    name: 'AYVO Přerov (test)',
    street: 'Průmyslová 1',
    city: 'Přerov',
    postalCode: '750 02',
    country: 'CZ',
    contact: 'Expedice',
    phone: '+420 581 000 333',
    email: 'expedice@ayvo.test',
  };
  const save = (over: Record<string, unknown> = {}) =>
    http()
      .put(settingsUrl)
      .send({
        requestId: randomUUID(),
        enabled: true,
        connection: 'PPL_TEST',
        sender,
        productCode: 'SIM-A',
        label: { layout: 'SINGLE' },
        ...over,
      });
  async function settingsReady() {
    await save({ productCode: null }).expect(200);
    const v = await http().post(`${settingsUrl}/verify`).send({ requestId: randomUUID() });
    expect((v.body as VerifyCarrierResult).ok).toBe(true);
    await save().expect(200);
  }
  const post = (order: string, path: string, body: object = {}) =>
    http()
      .post(`/api/admin/orders/${order}/shipment/${path}`)
      .send({ requestId: randomUUID(), ...body });
  const board = async () =>
    (await http().get('/api/admin/dispatch/pickups').expect(200)).body as PickupBoard;
  const order = (orders: string[], over: Record<string, unknown> = {}) =>
    http()
      .post('/api/admin/dispatch/pickups')
      .send({
        requestId: randomUUID(),
        date: pragueToday(1),
        window: null,
        orders,
        confirmed: true,
        ...over,
      });
  const lookup = (code: string) =>
    http().post(`/api/admin/dispatch/pickups/${code}/lookup`).send({ requestId: randomUUID() });
  const orderPosts = () =>
    ppl.seen.filter((s) => s.method === 'POST' && s.path === '/order/batch').length;
  const service = () => t.app.get(CarrierPickupsService);
  async function pollNow() {
    await t.prisma.$executeRaw`UPDATE "carrier_pickups" SET "next_poll_at" = now()
      WHERE "status" = 'ACCEPTED' AND "next_poll_at" IS NOT NULL`;
    await service().pollDue(50);
  }

  /** A labelled order "Připraveno k vyzvednutí" with `crates` parcels. */
  async function readyForPickup(crates = 1) {
    if (crates > 1) await factory.refill();
    const made = [];
    for (let i = 0; i < crates; i++) made.push(await factory.make());
    const o = await createOrder(t, hotel, [{ productCode: factory.kit.productCode, crates }]);
    for (const c of made) expect((await scanCrate(t, o.code, c.crateUrl)).status).toBe(200);
    expect((await completeOrder(t, o.code)).status).toBe(200);
    const s = ((await post(o.code, 'labels').expect(200)).body as OrderShipment).shipment!;
    expect(s.status).toBe('LABELED');
    await post(o.code, 'ready', { labelsApplied: true }).expect(200);
    return o.code;
  }

  beforeAll(async () => {
    await ppl.start();
    t = await createTestApp({
      PPL_TEST_CLIENT_ID: ppl.clientId,
      PPL_TEST_CLIENT_SECRET: ppl.clientSecret,
      PPL_TEST_API_BASE_URL_FOR_TESTS: ppl.base,
      CARRIER_POLL_SECONDS: '0',
      CARRIER_SETTLE_SECONDS: '0',
      CARRIER_CALL_TIMEOUT_SECONDS: '2',
      CARRIER_CREDENTIALS_KEY: KEY,
    });
    factory = await crateFactory(t, { capacity: 2 });
    hotel = (await createHotel(t, { name: 'Hotel Svoz', city: 'Přerov' })).code;
    // Test files share the database: ppl.e2e may have left PPL_TEST's administration credentials
    // (the same synthetic account and key — support/carrier-test-key.ts); nothing is stored here.
    await settingsReady();
  });
  afterAll(async () => {
    await t?.close();
    await ppl.stop();
  });
  beforeEach(() => ppl.reset());

  it('labels never order a pickup; one pickup: the documented CollectionOrder, confirmed by PPL', async () => {
    const posts = orderPosts();
    const a = await readyForPickup(1);
    const b = await readyForPickup(2);
    // Creating labels and "ready for pickup" never call the pickup endpoint.
    expect(orderPosts()).toBe(posts);
    expect(ppl.seen.some((s) => s.path.startsWith('/order'))).toBe(false);

    const before = await board();
    expect(before.carrier).toMatchObject({
      available: true,
      code: 'PPL',
      environment: 'TEST',
      maxParcels: 50,
      sender: { city: 'Přerov', postalCode: '750 02', country: 'CZ' },
    });
    const mine = before.candidates.filter((c) => [a, b].includes(c.orderCode));
    expect(mine.map((c) => [c.orderCode, c.parcelCount, c.eligible])).toEqual([
      [a, 1, true],
      [b, 2, true],
    ]);

    // The operator's explicit confirmation is required.
    expect((await order([a, b], { confirmed: false })).status).toBe(400);
    const res = await order([a, b], { window: { from: '13:00', to: '16:00' } });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const p = res.body as PickupView;
    expect(p).toMatchObject({
      status: 'CONFIRMED',
      parcelCount: 3,
      window: { from: '13:00', to: '16:00' },
      carrier: { code: 'PPL', environment: 'TEST' },
      errorCode: null,
    });
    expect(p.code).toMatch(/^SV-\d{6}$/);
    expect(orderPosts()).toBe(posts + 1);
    const sent = [...ppl.orders.values()].at(-1)!.body;
    const ref = [...ppl.orders.keys()].at(-1)!;
    expect(ref).toMatch(new RegExp(`^${p.code}-[0-9a-f]{8}$`));
    expect(sent).toEqual({
      orderType: 'CollectionOrder',
      referenceId: ref,
      customerReference: p.code,
      productType: 'SIM-A',
      shipmentCount: 3,
      sendDate: `${pragueToday(1)}T00:00:00`,
      // The wished window goes only into the note (its documented field has no defined format).
      note: `${p.code}, okno 13:00-16:00`,
      email: 'expedice@ayvo.test',
      sender: {
        name: 'AYVO Prerov (test)',
        street: 'Prumyslova 1',
        city: 'Prerov',
        zipCode: '75002',
        country: 'CZ',
        contact: 'Expedice',
        phone: '+420 581 000 333',
        email: 'expedice@ayvo.test',
      },
    });
    // No recipient, no parcel numbers or labels in a collection order.
    expect(JSON.stringify(sent)).not.toMatch(/recipient|shipmentNumber|label/i);
    expect(p.carrierOrderNumber).toBe([...ppl.orders.values()].at(-1)!.number);
    expect(p.orders.map((o) => [o.orderCode, o.parcelCount, o.orderStatus])).toEqual([
      [a, 1, 'READY_FOR_PICKUP'],
      [b, 2, 'READY_FOR_PICKUP'],
    ]);

    // The pickup changes no order or shipment: still ready for pickup, labelled, not handed over.
    for (const code of [a, b]) {
      const v = (await http().get(`/api/admin/orders/${code}/shipment`).expect(200))
        .body as OrderShipment;
      expect(v.shipment!.status).toBe('LABELED');
    }
    const orders = await t.prisma.order.findMany({
      where: { code: { in: [a, b] } },
      select: { status: true, events: { select: { type: true } } },
    });
    for (const o of orders) {
      expect(o.status).toBe('READY_FOR_PICKUP');
      expect(o.events.map((e) => e.type)).not.toContain('HANDED_TO_CARRIER');
    }
    // Planned now: not offered again for a coming pickup.
    const after = await board();
    expect(after.open).toBeNull();
    expect(after.candidates.filter((c) => [a, b].includes(c.orderCode))).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          orderCode: a,
          eligible: false,
          blockedBy: 'IN_PICKUP',
          pickupCode: p.code,
        }),
      ]),
    );
    expect((await order([a])).body.code).toBe('ORDER_IN_PICKUP');
  });

  it('a replay sends nothing again; a concurrent second request is refused — one POST', async () => {
    const a = await readyForPickup(1);
    const posts = orderPosts();
    const requestId = randomUUID();
    const body = { requestId, date: pragueToday(1), window: null, orders: [a], confirmed: true };
    const first = await http().post('/api/admin/dispatch/pickups').send(body).expect(200);
    const again = await http().post('/api/admin/dispatch/pickups').send(body).expect(200);
    expect(again.body.code).toBe(first.body.code);
    expect(orderPosts()).toBe(posts + 1);

    const b = await readyForPickup(1);
    const c = await readyForPickup(1);
    const before = orderPosts();
    ppl.mode.orderProcessingPolls = 100; // both would wait for PPL
    const results = await Promise.all([order([b]), order([c])]);
    const codes = results.map((r) => r.status).sort();
    expect(codes).toEqual([200, 409]);
    expect(results.find((r) => r.status === 409)!.body.code).toBe('PICKUP_IN_PROGRESS');
    expect(orderPosts()).toBe(before + 1);
    // While it waits for PPL, nothing else is ordered at this site.
    const open = (await board()).open!;
    expect(open.status).toBe('ACCEPTED');
    expect((await order([c])).body.code).toBe('PICKUP_IN_PROGRESS');
    ppl.mode.orderProcessingPolls = 0;
    await pollNow();
    expect((await board()).open).toBeNull();
    expect(orderPosts()).toBe(before + 1);
  });

  it('asynchronous: accepted, looked up by the poller until PPL completes; an import error refuses', async () => {
    const a = await readyForPickup(1);
    ppl.mode.orderProcessingPolls = 2;
    const p = (await order([a]).expect(200)).body as PickupView;
    expect(p.status).toBe('ACCEPTED');
    await pollNow();
    expect((await lookup(p.code).expect(200)).body.status).toBe('CONFIRMED');
    const posts = orderPosts();

    const b = await readyForPickup(1);
    ppl.mode.orderProcessingPolls = 0;
    ppl.mode.orderImportError = true;
    const r = (await order([b]).expect(200)).body as PickupView;
    expect(r).toMatchObject({ status: 'REJECTED', errorCode: 'SIM-ORDER-ERR' });
    expect(orderPosts()).toBe(posts + 1);
    // Refused = nothing ordered: the same order can be planned again.
    ppl.mode.orderImportError = false;
    expect((await order([b]).expect(200)).body.status).toBe('CONFIRMED');
  });

  it('refused by PPL (400): REJECTED, nothing ordered — the order can be planned again', async () => {
    const a = await readyForPickup(1);
    ppl.mode.orderReject = true;
    const r = (await order([a]).expect(200)).body as PickupView;
    expect(r).toMatchObject({ status: 'REJECTED', errorCode: 'PPL_400' });
    expect(r.errorMessage).toContain('validation');
    ppl.mode.orderReject = false;
    expect((await order([a]).expect(200)).body.status).toBe('CONFIRMED');
  });

  it('a lost answer, a time-out and a lost Location: uncertain, looked up by reference, never re-sent', async () => {
    // 1. The answer lost (500): PPL may or may not have it — SENT, the site blocked.
    const a = await readyForPickup(1);
    ppl.mode.orderError = true;
    const lost = (await order([a]).expect(200)).body as PickupView;
    expect(lost).toMatchObject({ status: 'SENT', errorCode: 'NO_ANSWER' });
    ppl.mode.orderError = false;
    const b = await readyForPickup(1);
    expect((await order([b])).body.code).toBe('PICKUP_IN_PROGRESS');
    // Looked up by its own reference: not found → still uncertain (no proof of absence).
    const posts = orderPosts();
    expect((await lookup(lost.code).expect(200)).body.status).toBe('SENT');
    expect(orderPosts()).toBe(posts);
    expect(
      ppl.seen.some((s) => s.path === '/order' && s.query.getAll('OrderReferences').length === 1),
    ).toBe(true);
    // Closed only by a person who checked with PPL (reason recorded); then the site can order.
    const closed = await http()
      .post(`/api/admin/dispatch/pickups/${lost.code}/resolve`)
      .send({
        requestId: randomUUID(),
        reason: 'PPL potvrdila, že svoz nemá',
        checkedWithCarrier: true,
      })
      .expect(200);
    expect(closed.body).toMatchObject({
      status: 'NOT_CREATED',
      resolutionReason: 'PPL potvrdila, že svoz nemá',
    });
    expect(orderPosts()).toBe(posts);

    // 2. A time-out: PPL created it but never answered — found by reference, confirmed.
    ppl.mode.orderHang = true;
    const hung = (await order([a]).expect(200)).body as PickupView;
    expect(hung).toMatchObject({ status: 'SENT', errorCode: 'NO_ANSWER' });
    ppl.mode.orderHang = false;
    const before = orderPosts();
    const found = (await lookup(hung.code).expect(200)).body as PickupView;
    expect(found.status).toBe('CONFIRMED');
    expect(found.carrierOrderNumber).toBeTruthy();
    expect(orderPosts()).toBe(before);
    // A confirmed pickup is never closed by a person.
    const refused = await http()
      .post(`/api/admin/dispatch/pickups/${hung.code}/resolve`)
      .send({ requestId: randomUUID(), reason: 'Omylem uzavírám', checkedWithCarrier: true });
    expect(refused.body.code).toBe('PICKUP_NOT_UNCERTAIN');

    // 3. 201 without a Location: uncertain, then found by reference (no batch id needed).
    ppl.mode.orderNoLocation = true;
    const noLoc = (await order([b]).expect(200)).body as PickupView;
    expect(noLoc.status).toBe('SENT');
    ppl.mode.orderNoLocation = false;
    expect((await lookup(noLoc.code).expect(200)).body.status).toBe('CONFIRMED');
    expect(orderPosts()).toBe(before + 1);
  });

  it('plan vs reality: the pickup never hands over; tracking or the manual hand-over does', async () => {
    const a = await readyForPickup(1);
    const p = (await order([a]).expect(200)).body as PickupView;
    expect(p.status).toBe('CONFIRMED');
    // The real hand-over (here the manual one) moves the order; the pickup stays as ordered.
    await post(a, 'hand-over', { handedOver: true }).expect(200);
    const v = (await http().get(`/api/admin/dispatch/pickups/${p.code}`).expect(200))
      .body as PickupView;
    expect(v).toMatchObject({ status: 'CONFIRMED', parcelCount: 1 });
    expect(v.orders[0]!.orderStatus).toBe('HANDED_TO_CARRIER');
    // Handed over: no longer a candidate for a pickup.
    expect((await board()).candidates.some((c) => c.orderCode === a)).toBe(false);
    expect((await order([a])).body.code).toBe('ORDER_NOT_READY_FOR_PICKUP');
  });

  it('validation: a past day, an unknown or not-ready order, an order of another site', async () => {
    const a = await readyForPickup(1);
    expect((await order([a], { date: pragueToday(-1) })).body.code).toBe('PICKUP_DATE_PAST');
    expect((await order([a], { window: { from: '16:00', to: '13:00' } })).status).toBe(400);
    expect((await order(['ORD-999999'])).status).toBe(404);
    // An order not yet ready for pickup (completed, labels not created).
    const made = await factory.make();
    const o = await createOrder(t, hotel, [{ productCode: factory.kit.productCode, crates: 1 }]);
    await scanCrate(t, o.code, made.crateUrl);
    await completeOrder(t, o.code);
    expect((await order([o.code])).body.code).toBe('ORDER_NOT_READY_FOR_PICKUP');
    expect(
      await t.prisma.carrierPickup.count({
        where: { status: { in: ['PREPARED', 'SENT', 'ACCEPTED'] } },
      }),
    ).toBe(0);
  });

  it('database rules: what was ordered never changes, nothing is deleted, one waiting pickup per site', async () => {
    const a = await readyForPickup(1);
    const p = (await order([a]).expect(200)).body as PickupView;
    const row = await t.prisma.carrierPickup.findFirstOrThrow({ where: { code: p.code } });
    const refuse = (sql: Promise<unknown>) => expect(sql).rejects.toThrow();
    await withPrivileged(async (db) => {
      await refuse(
        db.$executeRaw`UPDATE "carrier_pickups" SET "parcel_count" = 2 WHERE "id" = ${row.id}::uuid`,
      );
      await refuse(
        db.$executeRaw`UPDATE "carrier_pickups" SET "pickup_date" = '2030-01-01' WHERE "id" = ${row.id}::uuid`,
      );
      await refuse(
        db.$executeRaw`UPDATE "carrier_pickups" SET "status" = 'SENT' WHERE "id" = ${row.id}::uuid`,
      );
      await refuse(db.$executeRaw`DELETE FROM "carrier_pickups" WHERE "id" = ${row.id}::uuid`);
      await refuse(
        db.$executeRaw`DELETE FROM "carrier_pickup_orders" WHERE "pickup_id" = ${row.id}::uuid`,
      );
      await refuse(
        db.$executeRaw`UPDATE "carrier_pickup_orders" SET "parcel_count" = 5 WHERE "pickup_id" = ${row.id}::uuid`,
      );
      // A plan row added after sending is refused.
      const ship = await db.shipment.findFirstOrThrow({ where: { order: { code: a } } });
      const o = await db.order.findFirstOrThrow({ where: { code: a } });
      await refuse(db.$executeRaw`INSERT INTO "carrier_pickup_orders" ("pickup_id", "order_id", "shipment_id", "parcel_count")
        VALUES (${row.id}::uuid, ${o.id}::uuid, ${ship.id}::uuid, 1)`);
    });
    // Two waiting pickups of one site are impossible (partial unique index).
    const b = await readyForPickup(1);
    ppl.mode.orderProcessingPolls = 100;
    const w = (await order([b]).expect(200)).body as PickupView;
    expect(w.status).toBe('ACCEPTED');
    const wrow = await t.prisma.carrierPickup.findFirstOrThrow({ where: { code: w.code } });
    await withPrivileged(async (db) => {
      await expect(
        db.$executeRawUnsafe(
          `INSERT INTO "carrier_pickups" ("serial","code","site_id","carrier_code","carrier_connection","carrier_environment","carrier_account","client_reference","pickup_date","parcel_count","payload","created_at","created_by","operation_request_id")
         SELECT 999999,'SV-999999',"site_id","carrier_code","carrier_connection","carrier_environment","carrier_account",'SV-999999-x',"pickup_date",1,'{}',now(),"created_by",gen_random_uuid() FROM "carrier_pickups" WHERE "id" = '${wrow.id}'`,
        ),
      ).rejects.toThrow(/carrier_pickups_one_unresolved_per_site|unique/i);
    });
    ppl.mode.orderProcessingPolls = 0;
    await pollNow();
    expect((await board()).open).toBeNull();
  });
});
