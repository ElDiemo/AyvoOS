import { randomUUID } from 'node:crypto';
import type { OrderShipment, PickupBoard, PickupView, VerifyCarrierResult } from '@ayvo/types';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
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
 * API (no real PPL host is contacted). Covers: labels never order a pickup; the documented body;
 * the plan of concrete parcels — a parcel with the carrier (tracking) is never planned again, the
 * next pickup announces exactly the rest; confirmed only by PPL's answer; replay and concurrency
 * (one POST); a written pickup recovered after a "restart" is claimed once and sent with the same
 * reference, or closed NOT_SENT when its day or plan no longer holds; a lost answer, a time-out and
 * a lost Location stay uncertain and are only looked up; refusal and import errors; the
 * cancellation (one POST /order/cancel by the original reference, confirmed only when PPL shows
 * the order Canceled, parcels blocked meanwhile — also after the original day — then planned again
 * with the same labels); refused, lost, concurrent and repeated cancellations; validation; the
 * database rules. Synthetic data only.
 */
const KEY = CARRIER_TEST_KEY;
const DAY = 86_400_000;

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
  const candidate = async (order: string) =>
    (await board()).candidates.find((c) => c.orderCode === order);
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
  const view = async (code: string) =>
    (await http().get(`/api/admin/dispatch/pickups/${code}`).expect(200)).body as PickupView;
  const lookup = (code: string) =>
    http().post(`/api/admin/dispatch/pickups/${code}/lookup`).send({ requestId: randomUUID() });
  const cancel = (code: string, requestId = randomUUID()) =>
    http()
      .post(`/api/admin/dispatch/pickups/${code}/cancel`)
      .send({ requestId, reason: 'Svoz už nepotřebujeme', confirmed: true });
  const posts = (path: string) =>
    ppl.seen.filter((s) => s.method === 'POST' && s.path === path).length;
  const orderPosts = () => posts('/order/batch');
  const cancelPosts = () => posts('/order/cancel');
  const service = () => t.app.get(CarrierPickupsService);
  async function pollNow() {
    await t.prisma.$executeRaw`UPDATE "carrier_pickups" SET "next_poll_at" = now()
      WHERE "status" = 'ACCEPTED' AND "next_poll_at" IS NOT NULL`;
    await t.prisma.$executeRaw`UPDATE "carrier_pickup_cancellations" SET "next_poll_at" = now()
      WHERE "status" = 'ACCEPTED' AND "next_poll_at" IS NOT NULL`;
    await service().pollDue(50);
  }
  /** Runs `work` with the pickups' "today" moved `days` ahead (only that clock). */
  async function later<T>(days: number, work: () => Promise<T>): Promise<T> {
    service().clock = () => new Date(Date.now() + days * DAY);
    try {
      return await work();
    } finally {
      service().clock = () => new Date();
    }
  }
  /** A pickup written but not sent — as after a crash between the commit and the call. */
  async function written(orders: string[], over: Record<string, unknown> = {}) {
    const drive = vi.spyOn(service(), 'drive').mockResolvedValueOnce(undefined);
    try {
      const p = (await order(orders, over).expect(200)).body as PickupView;
      expect(p.status).toBe('PREPARED');
      return p;
    } finally {
      drive.mockRestore();
    }
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
    return { code: o.code, numbers: s.parcels.map((p) => p.carrierParcelNumber!) };
  }
  /** PPL's tracking reports this parcel picked up from the sender; the order refreshes it. */
  async function pplPicksUp(orderCode: string, number: string) {
    ppl.mode.events[number] = [
      {
        statusId: 150,
        code: 'PickedUp',
        phase: 'InTransport',
        group: 'PickedUp',
        eventDate: new Date(Date.now() - 60_000).toISOString(),
        name: 'Zásilku jsme převzali od odesílatele.',
      },
    ];
    await post(orderCode, 'tracking/refresh').expect(200);
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

  it('labels never order a pickup; one pickup: the documented CollectionOrder of concrete parcels', async () => {
    const before = orderPosts();
    const a = await readyForPickup(1);
    const b = await readyForPickup(2);
    // Creating labels and "ready for pickup" never call the pickup endpoints.
    expect(orderPosts()).toBe(before);
    expect(ppl.seen.some((s) => s.path.startsWith('/order'))).toBe(false);

    const ca = await candidate(a.code);
    const cb = await candidate(b.code);
    expect(ca).toMatchObject({ eligible: true, parcelCount: 1, pickedUpCount: 0 });
    expect(cb!.eligibleParcels.map((p) => p.carrierParcelNumber)).toEqual(b.numbers);

    expect((await order([a.code, b.code], { confirmed: false })).status).toBe(400);
    const res = await order([a.code, b.code], { window: { from: '13:00', to: '16:00' } });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const p = res.body as PickupView;
    expect(p).toMatchObject({ status: 'CONFIRMED', parcelCount: 3, cancellation: null });
    expect(orderPosts()).toBe(before + 1);
    const ref = [...ppl.orders.keys()].at(-1)!;
    expect(ref).toMatch(new RegExp(`^${p.code}-[0-9a-f]{8}$`));
    expect([...ppl.orders.values()].at(-1)!.body).toEqual({
      orderType: 'CollectionOrder',
      referenceId: ref,
      customerReference: p.code,
      productType: 'SIM-A',
      shipmentCount: 3,
      sendDate: `${pragueToday(1)}T00:00:00`,
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
    // The plan: each concrete parcel with its own number.
    expect(p.parcels.map((x) => x.carrierParcelNumber).sort()).toEqual(
      [...a.numbers, ...b.numbers].sort(),
    );
    expect(p.parcels.every((x) => !x.pickedUp && x.orderStatus === 'READY_FOR_PICKUP')).toBe(true);
    // The pickup changes no order or shipment.
    const orders = await t.prisma.order.findMany({
      where: { code: { in: [a.code, b.code] } },
      select: { status: true, events: { select: { type: true } } },
    });
    for (const o of orders) {
      expect(o.status).toBe('READY_FOR_PICKUP');
      expect(o.events.map((e) => e.type)).not.toContain('HANDED_TO_CARRIER');
    }
    expect(await candidate(a.code)).toMatchObject({
      eligible: false,
      blockedBy: 'IN_PICKUP',
      pickupCode: p.code,
    });
    expect((await order([a.code])).body.code).toBe('ORDER_IN_PICKUP');
  });

  it('PPL collects 1 of 2 parcels: the next pickup contains and announces exactly the second', async () => {
    const o = await readyForPickup(2);
    const first = (await order([o.code], { date: pragueToday(0) }).expect(200)).body as PickupView;
    expect(first).toMatchObject({ status: 'CONFIRMED', parcelCount: 2 });
    await pplPicksUp(o.code, o.numbers[0]!);
    // Partly with the carrier: the order stays ready for pickup; the board says so.
    expect((await t.prisma.order.findFirstOrThrow({ where: { code: o.code } })).status).toBe(
      'READY_FOR_PICKUP',
    );
    expect(await candidate(o.code)).toMatchObject({
      pickedUpCount: 1,
      eligible: false,
      blockedBy: 'IN_PICKUP',
    });
    const v = await view(first.code);
    expect(v.parcels.map((x) => [x.carrierParcelNumber, x.pickedUp])).toEqual([
      [o.numbers[0], true],
      [o.numbers[1], false],
    ]);
    // The next day the first pickup is past: only the second parcel is offered and ordered.
    await later(1, async () => {
      expect((await candidate(o.code))!.eligibleParcels.map((x) => x.carrierParcelNumber)).toEqual([
        o.numbers[1],
      ]);
      const next = (await order([o.code], { date: pragueToday(1) }).expect(200)).body as PickupView;
      expect(next).toMatchObject({ status: 'CONFIRMED', parcelCount: 1 });
      expect(next.parcels.map((x) => x.carrierParcelNumber)).toEqual([o.numbers[1]]);
      expect([...ppl.orders.values()].at(-1)!.body.shipmentCount).toBe(1);
    });
  });

  it('a replay sends nothing again; a concurrent second request is refused — one POST', async () => {
    const a = await readyForPickup(1);
    const before = orderPosts();
    const body = {
      requestId: randomUUID(),
      date: pragueToday(1),
      window: null,
      orders: [a.code],
      confirmed: true,
    };
    const first = await http().post('/api/admin/dispatch/pickups').send(body).expect(200);
    const again = await http().post('/api/admin/dispatch/pickups').send(body).expect(200);
    expect(again.body.code).toBe(first.body.code);
    expect(orderPosts()).toBe(before + 1);

    const b = await readyForPickup(1);
    const c = await readyForPickup(1);
    const mark = orderPosts();
    ppl.mode.orderProcessingPolls = 100; // both would wait for PPL
    const results = await Promise.all([order([b.code]), order([c.code])]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
    expect(results.find((r) => r.status === 409)!.body.code).toBe('PICKUP_IN_PROGRESS');
    expect(orderPosts()).toBe(mark + 1);
    expect((await board()).open!.status).toBe('ACCEPTED');
    ppl.mode.orderProcessingPolls = 0;
    await pollNow();
    expect((await board()).open).toBeNull();
    expect(orderPosts()).toBe(mark + 1);
  });

  it('recovery after a restart: a written pickup is claimed once and sent with its own reference', async () => {
    const a = await readyForPickup(1);
    const p = await written([a.code]);
    const before = orderPosts();
    // Several "processes" pick it up at once; exactly one sends it.
    await Promise.all([
      service().pollDue(5),
      service().pollDue(5),
      service().drive(
        (await t.prisma.carrierPickup.findFirstOrThrow({ where: { code: p.code } })).id,
      ),
    ]);
    expect(orderPosts()).toBe(before + 1);
    const row = await t.prisma.carrierPickup.findFirstOrThrow({ where: { code: p.code } });
    expect([...ppl.orders.keys()].at(-1)).toBe(row.clientReference);
    expect((await view(p.code)).status).toBe('CONFIRMED');
    await service().pollDue(5);
    expect(orderPosts()).toBe(before + 1);
  });

  it('recovery: a written pickup whose plan or day no longer holds is closed NOT_SENT, never sent', async () => {
    // The plan changed: the order was handed over meanwhile.
    const a = await readyForPickup(1);
    const p = await written([a.code]);
    await post(a.code, 'hand-over', { handedOver: true }).expect(200);
    const before = orderPosts();
    await service().pollDue(5);
    expect(await view(p.code)).toMatchObject({
      status: 'NOT_SENT',
      errorCode: 'PICKUP_PLAN_CHANGED',
    });
    // Its day passed (a restart after midnight).
    const b = await readyForPickup(1);
    const q = await written([b.code], { date: pragueToday(0) });
    await later(1, () => service().pollDue(5));
    expect(await view(q.code)).toMatchObject({
      status: 'NOT_SENT',
      errorCode: 'PICKUP_DAY_PASSED',
    });
    expect(orderPosts()).toBe(before);
    // Never sent: the order's parcel is free for a new pickup.
    expect((await order([b.code]).expect(200)).body.status).toBe('CONFIRMED');
  });

  it('asynchronous: accepted, looked up by the poller until PPL completes; an import error refuses', async () => {
    const a = await readyForPickup(1);
    ppl.mode.orderProcessingPolls = 2;
    const p = (await order([a.code]).expect(200)).body as PickupView;
    expect(p.status).toBe('ACCEPTED');
    await pollNow();
    expect((await lookup(p.code).expect(200)).body.status).toBe('CONFIRMED');
    const b = await readyForPickup(1);
    ppl.mode.orderProcessingPolls = 0;
    ppl.mode.orderImportError = true;
    const r = (await order([b.code]).expect(200)).body as PickupView;
    expect(r).toMatchObject({ status: 'REJECTED', errorCode: 'SIM-ORDER-ERR' });
    ppl.mode.orderImportError = false;
    expect((await order([b.code]).expect(200)).body.status).toBe('CONFIRMED');
  });

  it('refused by PPL (400): REJECTED, nothing ordered — the order can be planned again', async () => {
    const a = await readyForPickup(1);
    ppl.mode.orderReject = true;
    const r = (await order([a.code]).expect(200)).body as PickupView;
    expect(r).toMatchObject({ status: 'REJECTED', errorCode: 'PPL_400' });
    ppl.mode.orderReject = false;
    expect((await order([a.code]).expect(200)).body.status).toBe('CONFIRMED');
  });

  it('a lost answer, a time-out and a lost Location: uncertain, looked up by reference, never re-sent', async () => {
    const a = await readyForPickup(1);
    ppl.mode.orderError = true;
    const lost = (await order([a.code]).expect(200)).body as PickupView;
    expect(lost).toMatchObject({ status: 'SENT', errorCode: 'NO_ANSWER' });
    ppl.mode.orderError = false;
    const b = await readyForPickup(1);
    expect((await order([b.code])).body.code).toBe('PICKUP_IN_PROGRESS');
    const before = orderPosts();
    expect((await lookup(lost.code).expect(200)).body.status).toBe('SENT');
    await service().pollDue(5);
    expect(orderPosts()).toBe(before);
    const closed = await http()
      .post(`/api/admin/dispatch/pickups/${lost.code}/resolve`)
      .send({
        requestId: randomUUID(),
        reason: 'PPL potvrdila, že svoz nemá',
        checkedWithCarrier: true,
      })
      .expect(200);
    expect(closed.body).toMatchObject({ status: 'NOT_CREATED' });

    ppl.mode.orderHang = true;
    const hung = (await order([a.code]).expect(200)).body as PickupView;
    expect(hung).toMatchObject({ status: 'SENT', errorCode: 'NO_ANSWER' });
    ppl.mode.orderHang = false;
    const mark = orderPosts();
    expect((await lookup(hung.code).expect(200)).body.status).toBe('CONFIRMED');
    expect(orderPosts()).toBe(mark);

    ppl.mode.orderNoLocation = true;
    const noLoc = (await order([b.code]).expect(200)).body as PickupView;
    expect(noLoc.status).toBe('SENT');
    ppl.mode.orderNoLocation = false;
    expect((await lookup(noLoc.code).expect(200)).body.status).toBe('CONFIRMED');
    expect(orderPosts()).toBe(mark + 1);
  });

  it('acceptance: tomorrow → cancel → another day refused → PPL confirms → same labels the day after', async () => {
    const o = await readyForPickup(2);
    const p = (await order([o.code], { date: pragueToday(1) }).expect(200)).body as PickupView;
    expect(p.status).toBe('CONFIRMED');
    // PPL shows it cancelled only after three more lookups (the first look, the replay's, one poll).
    ppl.mode.cancelOrderShownAfter = 3;
    const requestId = randomUUID();
    const c = (await cancel(p.code, requestId).expect(200)).body as PickupView;
    expect(c.status).toBe('CONFIRMED'); // the pickup itself is kept as ordered
    expect(c.cancellation).toMatchObject({ status: 'ACCEPTED', reason: 'Svoz už nepotřebujeme' });
    expect(cancelPosts()).toBe(1);
    const sent = ppl.seen.filter((s) => s.path === '/order/cancel')[0]!;
    expect(sent.query.get('orderReference')).toBe(
      (await t.prisma.carrierPickup.findFirstOrThrow({ where: { code: p.code } })).clientReference,
    );
    // A replay is the same request; nothing sent again.
    await cancel(p.code, requestId).expect(200);
    expect(cancelPosts()).toBe(1);
    // While the cancellation is not confirmed, the parcels stay blocked — another day too, and
    // also after the original day has passed.
    expect((await order([o.code], { date: pragueToday(2) })).body.code).toBe('ORDER_IN_PICKUP');
    await later(3, async () => {
      expect((await order([o.code], { date: pragueToday(3) })).body.code).toBe('ORDER_IN_PICKUP');
    });
    await pollNow();
    expect((await view(p.code)).cancellation!.status).toBe('ACCEPTED');
    await pollNow();
    const confirmed = await view(p.code);
    expect(confirmed.cancellation).toMatchObject({ status: 'CONFIRMED', carrierState: 'Canceled' });
    expect(confirmed).toMatchObject({
      status: 'CONFIRMED',
      carrierState: 'Canceled',
      parcelCount: 2,
    });
    expect(confirmed.parcels.map((x) => x.carrierParcelNumber)).toEqual(o.numbers);
    // Released: the same labels (the same parcel numbers) for the day after tomorrow.
    const again = (await order([o.code], { date: pragueToday(2) }).expect(200)).body as PickupView;
    expect(again.parcels.map((x) => x.carrierParcelNumber)).toEqual(o.numbers);
    expect(cancelPosts()).toBe(1);
    // The original pickup, its plan and the cancellation stay in the history.
    const hist = (await board()).pickups.find((x) => x.code === p.code)!;
    expect(hist.cancellation!.status).toBe('CONFIRMED');
  });

  it('cancellation: refused, lost, concurrent, not yet confirmed pickup — never a second POST by itself', async () => {
    // Refused: the pickup stands, its parcels held; a new request may follow.
    const a = await readyForPickup(1);
    const p = (await order([a.code]).expect(200)).body as PickupView;
    ppl.mode.cancelOrderRefuse = true;
    const r = (await cancel(p.code).expect(200)).body as PickupView;
    expect(r.cancellation).toMatchObject({ status: 'REJECTED', errorCode: 'PPL_400' });
    expect((await order([a.code])).body.code).toBe('ORDER_IN_PICKUP');
    ppl.mode.cancelOrderRefuse = false;
    // Concurrent requests: one cancellation, one POST.
    const before = cancelPosts();
    const both = await Promise.all([cancel(p.code), cancel(p.code)]);
    expect(both.map((x) => x.status).sort()).toEqual([200, 409]);
    expect(both.find((x) => x.status === 409)!.body.code).toBe('PICKUP_CANCEL_EXISTS');
    expect(cancelPosts()).toBe(before + 1);
    expect((await view(p.code)).cancellation!.status).toBe('CONFIRMED');

    // Lost (a time-out after PPL applied it): uncertain — looked up, never re-sent.
    const b = await readyForPickup(1);
    const q = (await order([b.code]).expect(200)).body as PickupView;
    ppl.mode.cancelOrderHang = true;
    const lost = (await cancel(q.code).expect(200)).body as PickupView;
    expect(lost.cancellation).toMatchObject({ status: 'SENT', errorCode: 'NO_ANSWER' });
    ppl.mode.cancelOrderHang = false;
    expect((await order([b.code], { date: pragueToday(2) })).body.code).toBe('ORDER_IN_PICKUP');
    const mark = cancelPosts();
    await service().pollDue(5);
    expect(cancelPosts()).toBe(mark);
    expect((await lookup(q.code).expect(200)).body.cancellation.status).toBe('CONFIRMED');
    expect(cancelPosts()).toBe(mark);
    // A 500 before PPL applied it: uncertain; the lookup does not find it cancelled — it stays.
    const d = await readyForPickup(1);
    const s = (await order([d.code]).expect(200)).body as PickupView;
    ppl.mode.cancelOrderError = true;
    expect(((await cancel(s.code).expect(200)).body as PickupView).cancellation!.status).toBe(
      'SENT',
    );
    ppl.mode.cancelOrderError = false;
    expect((await lookup(s.code).expect(200)).body.cancellation.status).toBe('SENT');
    expect((await order([d.code], { date: pragueToday(2) })).body.code).toBe('ORDER_IN_PICKUP');

    // Only a pickup PPL confirmed is cancelled.
    const e = await readyForPickup(1);
    ppl.mode.orderProcessingPolls = 100;
    const w = (await order([e.code]).expect(200)).body as PickupView;
    expect(w.status).toBe('ACCEPTED');
    expect((await cancel(w.code)).body.code).toBe('PICKUP_NOT_CANCELLABLE');
    ppl.mode.orderProcessingPolls = 0;
    await pollNow();
  });

  it('validation: a past day, an unknown or not-ready order', async () => {
    const a = await readyForPickup(1);
    expect((await order([a.code], { date: pragueToday(-1) })).body.code).toBe('PICKUP_DATE_PAST');
    expect((await order([a.code], { window: { from: '16:00', to: '13:00' } })).status).toBe(400);
    expect((await order(['ORD-999999'])).status).toBe(404);
    const made = await factory.make();
    const o = await createOrder(t, hotel, [{ productCode: factory.kit.productCode, crates: 1 }]);
    await scanCrate(t, o.code, made.crateUrl);
    await completeOrder(t, o.code);
    expect((await order([o.code])).body.code).toBe('ORDER_NOT_READY_FOR_PICKUP');
  });

  it('database rules: the plan is fixed when written (also PREPARED), nothing changes or is deleted', async () => {
    const refuse = (sql: Promise<unknown>) => expect(sql).rejects.toThrow();
    // A written (PREPARED) pickup: no plan row can be added afterwards.
    const a = await readyForPickup(1);
    const extra = await readyForPickup(1);
    const p = await written([a.code]);
    const row = await t.prisma.carrierPickup.findFirstOrThrow({ where: { code: p.code } });
    const ep = await t.prisma.shipmentParcel.findFirstOrThrow({
      where: { shipment: { order: { code: extra.code }, status: 'LABELED' } },
    });
    const eo = await t.prisma.order.findFirstOrThrow({ where: { code: extra.code } });
    await withPrivileged(async (db) => {
      await expect(
        db.$executeRaw`INSERT INTO "carrier_pickup_parcels" ("pickup_id", "parcel_id", "shipment_id", "order_id", "carrier_parcel_number")
          VALUES (${row.id}::uuid, ${ep.id}::uuid, ${ep.shipmentId}::uuid, ${eo.id}::uuid, ${ep.carrierParcelNumber})`,
      ).rejects.toThrow(/fixed when the pickup is written/);
      await refuse(
        db.$executeRaw`UPDATE "carrier_pickups" SET "parcel_count" = 2 WHERE "id" = ${row.id}::uuid`,
      );
      await refuse(
        db.$executeRaw`UPDATE "carrier_pickups" SET "pickup_date" = '2030-01-01' WHERE "id" = ${row.id}::uuid`,
      );
      await refuse(
        db.$executeRaw`UPDATE "carrier_pickups" SET "created_txid" = 1 WHERE "id" = ${row.id}::uuid`,
      );
      await refuse(db.$executeRaw`DELETE FROM "carrier_pickups" WHERE "id" = ${row.id}::uuid`);
      await refuse(
        db.$executeRaw`DELETE FROM "carrier_pickup_parcels" WHERE "pickup_id" = ${row.id}::uuid`,
      );
      await refuse(
        db.$executeRaw`UPDATE "carrier_pickup_parcels" SET "carrier_parcel_number" = 'X' WHERE "pickup_id" = ${row.id}::uuid`,
      );
      // A cancellation only for a pickup PPL confirmed.
      await expect(
        db.$executeRaw`INSERT INTO "carrier_pickup_cancellations" ("pickup_id", "reason", "created_at", "created_by", "operation_request_id")
          SELECT ${row.id}::uuid, 'x', now(), "created_by", "operation_request_id" FROM "carrier_pickups" WHERE "id" = ${row.id}::uuid`,
      ).rejects.toThrow(/only a pickup confirmed/);
    });
    await service().pollDue(5);
    expect((await view(p.code)).status).toBe('CONFIRMED');
    // A confirmed pickup: its status never goes back; a parcel with the carrier is never planned.
    await withPrivileged(async (db) => {
      await refuse(
        db.$executeRaw`UPDATE "carrier_pickups" SET "status" = 'SENT' WHERE "id" = ${row.id}::uuid`,
      );
    });
    // Cancellations are never deleted or rewritten.
    await cancel(p.code).expect(200);
    const c = await t.prisma.carrierPickupCancellation.findFirstOrThrow({
      where: { pickupId: row.id },
    });
    await withPrivileged(async (db) => {
      await refuse(
        db.$executeRaw`DELETE FROM "carrier_pickup_cancellations" WHERE "id" = ${c.id}::uuid`,
      );
      await refuse(
        db.$executeRaw`UPDATE "carrier_pickup_cancellations" SET "reason" = 'jinak' WHERE "id" = ${c.id}::uuid`,
      );
      await refuse(
        db.$executeRaw`UPDATE "carrier_pickup_cancellations" SET "status" = 'PREPARED' WHERE "id" = ${c.id}::uuid`,
      );
    });
    // Two waiting pickups of one site are impossible (partial unique index).
    ppl.mode.orderProcessingPolls = 100;
    const w = (await order([extra.code]).expect(200)).body as PickupView;
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
