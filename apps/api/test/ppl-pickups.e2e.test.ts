import { randomUUID } from 'node:crypto';
import type { OrderShipment, PickupBoard, PickupView } from '@ayvo/types';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CarrierSettingsSnapshot } from '../src/carriers/carrier.js';
import { CarrierRegistryService } from '../src/carriers/carrier-registry.service.js';
import { PplPickups } from '../src/carriers/ppl/ppl-pickups.js';
import { CarrierPickupsService, PICKUP_MAX_POLLS } from '../src/orders/carrier-pickups.service.js';
import { ShipmentCarrierFlow } from '../src/orders/shipment-carrier-flow.service.js';
import { ShipmentPoller } from '../src/orders/shipment-poller.service.js';
import { ShipmentTrackingService } from '../src/orders/shipment-tracking.service.js';
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
  /**
   * The site's PPL settings as the registry gives them to a new request (doc 029 §9). Given to the
   * registry of this test app directly — nothing is stored: test files share one database (in no
   * fixed order) and site settings are never deleted, so ppl.e2e still starts from unsaved ones.
   */
  const SETTINGS: CarrierSettingsSnapshot = {
    service: 'SIM-A',
    label: { format: 'PDF', dpi: 203, complete: false },
    sender: {
      name: 'AYVO Přerov (test)',
      addressLine1: 'Průmyslová 1',
      addressLine2: null,
      postalCode: '750 02',
      city: 'Přerov',
      countryCode: 'CZ',
      contactName: 'Expedice',
      phone: '+420 581 000 333',
      email: 'expedice@ayvo.test',
    },
  };
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

  /** PPL's tracking reports this parcel DELIVERED with no pickup scan (CARRIER_IMPLIED, no time). */
  async function pplDeliversWithoutScan(orderCode: string, number: string) {
    ppl.mode.events[number] = [
      {
        statusId: 450,
        code: 'Delivered',
        phase: 'Delivered',
        group: 'Delivered',
        eventDate: new Date(Date.now() - 60_000).toISOString(),
        name: 'Zásilku jsme doručili příjemci.',
      },
    ];
    await post(orderCode, 'tracking/refresh').expect(200);
  }
  /** The closing of exactly this attempt (its id fixed when the dialog opened). */
  const closeCancel = (code: string, cancellationId: string, requestId = randomUUID()) =>
    http().post(`/api/admin/dispatch/pickups/${code}/cancel/resolve`).send({
      requestId,
      cancellationId,
      reason: 'PPL potvrdila, že storno neprovedla',
      checkedWithCarrier: true,
    });
  /** The pickup's latest cancellation attempt, as the board shows it now. */
  const attemptOf = async (code: string) => (await view(code)).cancellation!.id;

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
    // The real PPL adapter of the PPL_TEST connection (the simulation); ppl.e2e may have left its
    // administration credentials — the same synthetic account and key (support/carrier-test-key.ts).
    const registry = t.app.get(CarrierRegistryService);
    const gateway = await registry.ppl('PPL_TEST');
    expect(gateway).not.toBeNull();
    vi.spyOn(registry, 'forSite').mockImplementation(async (siteId) =>
      siteId === INITIAL_SITE_ID
        ? { gateway: gateway!, settings: SETTINGS }
        : { gateway: null, reason: 'NOT_CONFIGURED' },
    );
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
    expect(p.parcels.every((x) => !x.withCarrierNow && x.orderStatus === 'READY_FOR_PICKUP')).toBe(
      true,
    );
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
    expect(v.parcels.map((x) => [x.carrierParcelNumber, x.withCarrierNow])).toEqual([
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
    expect(confirmed.cancelledByCarrierAt).not.toBeNull();
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

  it('a parcel delivered without a pickup scan (CARRIER_IMPLIED) is with the carrier: never planned', async () => {
    // Recovery: a written pickup of both parcels; tracking learns only afterwards.
    const o = await readyForPickup(2);
    const w = await written([o.code]);
    await pplDeliversWithoutScan(o.code, o.numbers[0]!);
    // By its order and position — simulated parcel numbers repeat across test files.
    const firstParcel = {
      shipment: { order: { code: o.code }, status: 'LABELED' as const },
      parcelNo: 1,
    };
    const progress = await t.prisma.shipmentParcelProgress.findFirstOrThrow({
      where: { parcel: firstParcel },
    });
    expect(progress).toMatchObject({ pickedUpSource: 'CARRIER_IMPLIED', pickedUpAt: null });
    const before = orderPosts();
    await service().pollDue(5);
    expect(await view(w.code)).toMatchObject({
      status: 'NOT_SENT',
      errorCode: 'PICKUP_PLAN_CHANGED',
    });
    expect(orderPosts()).toBe(before);
    // The board and the API count it as with the carrier; a new pickup takes only the second.
    expect(await candidate(o.code)).toMatchObject({ pickedUpCount: 1, eligible: true });
    expect((await candidate(o.code))!.eligibleParcels.map((x) => x.carrierParcelNumber)).toEqual([
      o.numbers[1],
    ]);
    const p = (await order([o.code]).expect(200)).body as PickupView;
    expect(p.parcels.map((x) => x.carrierParcelNumber)).toEqual([o.numbers[1]]);
    expect([...ppl.orders.values()].at(-1)!.body.shipmentCount).toBe(1);
    // The database refuses it too (a plan row for the implied parcel, in its own transaction).
    const parcel = await t.prisma.shipmentParcel.findFirstOrThrow({
      where: firstParcel,
      include: { shipment: true },
    });
    expect(parcel.carrierParcelNumber).toBe(o.numbers[0]);
    const tpl = await t.prisma.carrierPickup.findFirstOrThrow({ where: { code: p.code } });
    await withPrivileged(async (db) => {
      await expect(
        db.$transaction(async (tx) => {
          const op = randomUUID();
          await tx.$executeRaw`INSERT INTO "operation_requests" ("request_id", "kind", "payload_sha256")
            VALUES (${op}::uuid, 'CARRIER_PICKUP_ORDER', ${'0'.repeat(64)})`;
          const [row] = await tx.$queryRaw<{ id: string }[]>`
            INSERT INTO "carrier_pickups" ("serial","code","site_id","carrier_code","carrier_connection","carrier_environment","carrier_account","client_reference","pickup_date","parcel_count","payload","created_at","created_by","operation_request_id")
            VALUES (999998, 'SV-999998', ${tpl.siteId}::uuid, ${tpl.carrierCode}, ${tpl.carrierConnection}, ${tpl.carrierEnvironment}, ${tpl.carrierAccount}, 'SV-999998-x', ${tpl.pickupDate}, 1, '{}', now(), ${tpl.createdBy}::uuid, ${op}::uuid)
            RETURNING "id"`;
          await tx.$executeRaw`INSERT INTO "carrier_pickup_parcels" ("pickup_id","parcel_id","shipment_id","order_id","carrier_parcel_number")
            VALUES (${row!.id}::uuid, ${parcel.id}::uuid, ${parcel.shipmentId}::uuid, ${parcel.shipment.orderId}::uuid, ${o.numbers[0]!})`;
        }),
      ).rejects.toThrow(/already with the carrier/);
    });
  });

  it('closing an uncertain cancellation: verified by a person, then a new request; the pickup stands', async () => {
    // A 500 before PPL carried it out: SENT for ever by itself — lookups and errors release nothing.
    const o = await readyForPickup(1);
    const p = (await order([o.code]).expect(200)).body as PickupView;
    ppl.mode.cancelOrderError = true;
    expect(((await cancel(p.code).expect(200)).body as PickupView).cancellation!.status).toBe(
      'SENT',
    );
    ppl.mode.cancelOrderError = false;
    ppl.mode.down = true;
    await service().pollDue(5);
    expect((await lookup(p.code).expect(200)).body.cancellation.status).toBe('SENT');
    ppl.mode.down = false;
    // The next lookup by its back-off (a person's lookup meanwhile leaves it to that one).
    await dueNow(p.code);
    expect((await lookup(p.code).expect(200)).body.cancellation).toMatchObject({
      status: 'SENT',
      carrierState: 'Created',
    });
    expect((await cancel(p.code)).body.code).toBe('PICKUP_CANCEL_EXISTS');
    expect((await order([o.code], { date: pragueToday(2) })).body.code).toBe('ORDER_IN_PICKUP');
    const before = cancelPosts();
    // Two people close it at once: one wins; the same request again is the same.
    const ids = [randomUUID(), randomUUID()];
    const attempt = await attemptOf(p.code);
    const both = await Promise.all(ids.map((id) => closeCancel(p.code, attempt, id)));
    expect(both.map((r) => r.status).sort()).toEqual([200, 409]);
    const requestId = ids[both.findIndex((r) => r.status === 200)]!;
    const closed = both.find((r) => r.status === 200)!.body as PickupView;
    expect(closed).toMatchObject({ status: 'CONFIRMED', parcelCount: 1 });
    expect(closed.cancellation).toMatchObject({
      status: 'NOT_CREATED',
      resolutionReason: 'PPL potvrdila, že storno neprovedla',
    });
    await closeCancel(p.code, attempt, requestId).expect(200);
    expect(cancelPosts()).toBe(before); // the closed attempt is never re-sent
    // The pickup still governs its parcels (confirmed for tomorrow): not released by the closing.
    expect((await order([o.code], { date: pragueToday(2) })).body.code).toBe('ORDER_IN_PICKUP');
    // A new, confirmed request; concurrent duplicates make one.
    const again = await Promise.all([cancel(p.code), cancel(p.code)]);
    expect(again.map((r) => r.status).sort()).toEqual([200, 409]);
    expect(cancelPosts()).toBe(before + 1);
    expect((await view(p.code)).cancellation!.status).toBe('CONFIRMED');
    expect(
      (await order([o.code], { date: pragueToday(2) }).expect(200)).body.parcels[0]
        .carrierParcelNumber,
    ).toBe(o.numbers[0]);
  });

  it('PPL really cancelled meanwhile: its Canceled confirms — before the closing and after it', async () => {
    // Before: the person's closing asks PPL once more; Canceled confirms, the closing is refused.
    const a = await readyForPickup(1);
    const p = (await order([a.code]).expect(200)).body as PickupView;
    ppl.mode.cancelOrderHang = true; // carried out, the answer never comes
    expect(((await cancel(p.code).expect(200)).body as PickupView).cancellation!.status).toBe(
      'SENT',
    );
    ppl.mode.cancelOrderHang = false;
    const refused = await closeCancel(p.code, await attemptOf(p.code));
    expect(refused.body.code).toBe('PICKUP_CANCEL_NOT_UNCERTAIN');
    expect((await view(p.code)).cancellation!.status).toBe('CONFIRMED');

    // After: PPL showed it only later; the closed attempt stays closed; a new request that PPL
    // refuses (already cancelled) is confirmed by PPL's own state.
    const b = await readyForPickup(1);
    const q = (await order([b.code]).expect(200)).body as PickupView;
    ppl.mode.cancelOrderHang = true;
    ppl.mode.cancelOrderShownAfter = 1000;
    await cancel(q.code).expect(200);
    ppl.mode.cancelOrderHang = false;
    expect(
      ((await closeCancel(q.code, await attemptOf(q.code)).expect(200)).body as PickupView)
        .cancellation!.status,
    ).toBe('NOT_CREATED');
    const ref = (await t.prisma.carrierPickup.findFirstOrThrow({ where: { code: q.code } }))
      .clientReference;
    ppl.orders.get(ref)!.hiddenLooks = 0; // PPL now shows Canceled
    ppl.mode.cancelOrderRefuse = true;
    const mark = cancelPosts();
    // After an attempt closed by a person, PPL's own state is read first: Canceled confirms the
    // new request without a POST.
    const n = (await cancel(q.code).expect(200)).body as PickupView;
    expect(n.cancellation).toMatchObject({ status: 'CONFIRMED', carrierState: 'Canceled' });
    expect(n.cancelledByCarrierAt).not.toBeNull();
    expect(cancelPosts()).toBe(mark);
    ppl.mode.cancelOrderRefuse = false;
    // Shown cancelled: no further cancellation starts.
    expect((await cancel(q.code)).body.code).toBe('PICKUP_NOT_CANCELLABLE');
  });

  it('accepted, lookups ran out without Canceled: still held; closed only by a person then', async () => {
    const o = await readyForPickup(1);
    const p = (await order([o.code]).expect(200)).body as PickupView;
    ppl.mode.cancelOrderShownAfter = 1000;
    const c = (await cancel(p.code).expect(200)).body as PickupView;
    expect(c.cancellation).toMatchObject({ status: 'ACCEPTED', lookingUp: true });
    expect((await closeCancel(p.code, await attemptOf(p.code))).body.code).toBe(
      'PICKUP_CANCEL_STILL_LOOKED_UP',
    );
    for (let i = 0; i < 40; i++) {
      const row = await t.prisma.carrierPickupCancellation.findFirstOrThrow({
        where: { pickup: { code: p.code } },
      });
      if (row.nextPollAt === null) break;
      await pollNow();
    }
    const v = await view(p.code);
    expect(v.cancellation).toMatchObject({
      status: 'ACCEPTED',
      lookingUp: false,
      carrierState: 'Created',
    });
    // "Created" alone releases nothing.
    expect((await order([o.code], { date: pragueToday(2) })).body.code).toBe('ORDER_IN_PICKUP');
    expect(
      ((await closeCancel(p.code, await attemptOf(p.code)).expect(200)).body as PickupView)
        .cancellation!.status,
    ).toBe('NOT_CREATED');
  });

  /** PPL's answers to GET /order for the next lookups, in order — each held until released. */
  type Shown = Awaited<ReturnType<PplPickups['find']>>;
  function heldAnswer(shown: Shown) {
    let entered!: () => void;
    let release!: () => void;
    const reached = new Promise<void>((r) => (entered = r));
    const answer = new Promise<Shown>((r) => (release = () => r(shown)));
    return {
      run: () => {
        entered();
        return answer;
      },
      reached,
      release,
    };
  }
  const CREATED: Shown = { orderNumber: '1', state: 'Created', cancelled: false };
  const CANCELED: Shown = { orderNumber: '1', state: 'Canceled', cancelled: true };
  /** An uncertain attempt (a 500 before PPL carried it out — PPL shows "Created"). */
  async function uncertainCancel(code: string) {
    ppl.mode.cancelOrderError = true;
    const v = (await cancel(code).expect(200)).body as PickupView;
    ppl.mode.cancelOrderError = false;
    expect(v.cancellation!.status).toBe('SENT');
    return v.cancellation!.id;
  }
  const attemptRow = (id: string) =>
    t.prisma.carrierPickupCancellation.findUniqueOrThrow({ where: { id } });

  /** GET /order lookups of exactly this pickup's reference (reads only). */
  const orderReads = (ref: string) =>
    ppl.seen.filter(
      (s) => s.method === 'GET' && s.path === '/order' && s.query.get('OrderReferences') === ref,
    ).length;
  /** The uncertain attempt's next automatic lookup is due now (as when its back-off has passed). */
  const dueNow = (pickupCode: string) =>
    t.prisma.$executeRaw`UPDATE "carrier_pickup_cancellations" c SET "next_poll_at" = now()
      FROM "carrier_pickups" p WHERE p."id" = c."pickup_id" AND p."code" = ${pickupCode}
        AND c."status" = 'SENT' AND c."next_poll_at" IS NOT NULL`;
  const attemptOfCode = (pickupCode: string) =>
    t.prisma.carrierPickupCancellation.findFirstOrThrow({
      where: { pickup: { code: pickupCode } },
      orderBy: { createdAt: 'desc' },
    });
  const referenceOf = async (pickupCode: string) =>
    (await t.prisma.carrierPickup.findFirstOrThrow({ where: { code: pickupCode } }))
      .clientReference;

  it('uncertain cancellation: one POST, the HTTP status kept, read-only lookups until Canceled releases the parcels', async () => {
    const o = await readyForPickup(1);
    const p = (await order([o.code]).expect(200)).body as PickupView;
    const ref = await referenceOf(p.code);
    const traceId = '00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01';
    ppl.mode.cancelOrderAnswer = { status: 502, traceId };
    const sent = cancelPosts();
    const v = (await cancel(p.code).expect(200)).body as PickupView;
    ppl.mode.cancelOrderAnswer = null;
    expect(cancelPosts()).toBe(sent + 1);
    // Not usable, which is not "lost": the status and PPL's own request id, never the body.
    expect(v.cancellation).toMatchObject({
      status: 'SENT',
      errorCode: 'NO_ANSWER',
      lookingUp: true,
    });
    expect(v.cancellation!.errorMessage).toBe(
      `No usable answer from the carrier: HTTP 502 (PPL traceId ${traceId})`,
    );
    expect(v.cancellation!.errorMessage).not.toMatch(/Bad gateway|upstream/);
    expect(v.reference).toBe(ref);
    // The poller reads PPL's state (GET only): "Created" releases nothing.
    const reads = orderReads(ref);
    await service().pollDue(50);
    expect(orderReads(ref)).toBe(reads + 1);
    const created = await view(p.code);
    expect(created.cancellation).toMatchObject({
      status: 'SENT',
      carrierState: 'Created',
      lookups: 1,
      lookingUp: true,
      lookupsExhausted: false,
    });
    // The next lookup by the back-off from the lookup that ran (10 s), not before.
    const next = Date.parse(created.cancellation!.nextLookupAt!);
    expect(next).toBeGreaterThan(Date.now() + 5_000);
    expect(next).toBeLessThan(Date.now() + 15_000);
    expect((await order([o.code], { date: pragueToday(2) })).body.code).toBe('ORDER_IN_PICKUP');
    await service().pollDue(50);
    expect(orderReads(ref)).toBe(reads + 1);
    // PPL shows it Canceled: the next automatic read confirms and releases the same parcel.
    const shown = ppl.orders.get(ref)!;
    shown.cancelled = true;
    shown.hiddenLooks = 0;
    await dueNow(p.code);
    await service().pollDue(50);
    const done = await view(p.code);
    expect(done.cancellation).toMatchObject({
      status: 'CONFIRMED',
      carrierState: 'Canceled',
      nextLookupAt: null,
    });
    expect(done.cancelledByCarrierAt).not.toBeNull();
    expect(cancelPosts()).toBe(sent + 1);
    const again = (await order([o.code], { date: pragueToday(2) }).expect(200)).body as PickupView;
    expect(again.parcels.map((x) => x.carrierParcelNumber)).toEqual(o.numbers);
  });

  it('uncertain cancellation: outages are counted, the lookups stop at the limit — for a person, never a second POST', async () => {
    const o = await readyForPickup(1);
    const p = (await order([o.code]).expect(200)).body as PickupView;
    const ref = await referenceOf(p.code);
    // Carried out at PPL, but no answer in time; PPL never shows it cancelled here.
    ppl.mode.cancelOrderHang = true;
    ppl.mode.cancelOrderShownAfter = 1_000_000;
    const sent = cancelPosts();
    const v = (await cancel(p.code).expect(200)).body as PickupView;
    ppl.mode.cancelOrderHang = false;
    expect(v.cancellation!.errorMessage).toBe(
      'No usable answer from the carrier: no answer within the time limit',
    );
    // PPL down: the lookup fails, is counted, and nothing changes.
    ppl.mode.down = true;
    await service().pollDue(50);
    ppl.mode.down = false;
    expect((await view(p.code)).cancellation).toMatchObject({ status: 'SENT', lookups: 1 });
    // Every further lookup due: they run up to the limit and stop there.
    for (let i = 0; i < PICKUP_MAX_POLLS + 5; i++) {
      await dueNow(p.code);
      await service().pollDue(50);
    }
    const reads = orderReads(ref);
    const out = await view(p.code);
    expect(out.cancellation).toMatchObject({
      status: 'SENT',
      carrierState: 'Created',
      lookups: PICKUP_MAX_POLLS,
      lookingUp: false,
      lookupsExhausted: true,
      nextLookupAt: null,
    });
    await service().pollDue(50);
    expect(orderReads(ref)).toBe(reads);
    // A person's lookup after the last one: one extra read, not counted, nothing rescheduled.
    await lookup(p.code).expect(200);
    expect(orderReads(ref)).toBe(reads + 1);
    expect(await attemptOfCode(p.code)).toMatchObject({
      pollCount: PICKUP_MAX_POLLS,
      nextPollAt: null,
    });
    expect(cancelPosts()).toBe(sent + 1);
    // Still held; a person closes it after checking with PPL (shipments:resolve_uncertain).
    expect((await order([o.code], { date: pragueToday(2) })).body.code).toBe('ORDER_IN_PICKUP');
    expect((await cancel(p.code)).body.code).toBe('PICKUP_CANCEL_EXISTS');
    expect(
      ((await closeCancel(p.code, out.cancellation!.id).expect(200)).body as PickupView)
        .cancellation!.status,
    ).toBe('NOT_CREATED');
    expect(cancelPosts()).toBe(sent + 1);
  });

  it('an older uncertain attempt and two pollers: one lookup at a time, the next by its back-off; a crash is taken over; never a POST', async () => {
    const o = await readyForPickup(1);
    const p = (await order([o.code]).expect(200)).body as PickupView;
    const ref = await referenceOf(p.code);
    ppl.mode.cancelOrderShownAfter = 1_000_000;
    const id = await uncertainCancel(p.code);
    // As SV-000001 on DEV: sent long ago by the earlier release — no due time, nothing counted.
    await t.prisma.$executeRaw`UPDATE "carrier_pickup_cancellations"
      SET "next_poll_at" = NULL, "sent_at" = "sent_at" - interval '6 days' WHERE "id" = ${id}::uuid`;
    const posts = cancelPosts();
    const real = PplPickups.prototype.find;
    let mine = 0;
    let held: ReturnType<typeof heldAnswer> | null = null;
    const find = vi.spyOn(PplPickups.prototype, 'find').mockImplementation(async function (
      this: PplPickups,
      ...args
    ) {
      if (args[0].clientReference !== ref) return real.apply(this, args);
      mine++;
      if (held) {
        const h = held;
        held = null;
        return h.run();
      }
      return real.apply(this, args);
    });
    try {
      const gate = heldAnswer(CREATED);
      held = gate;
      // Two pollers (as two API processes): the first holds the lookup; the second skips it.
      const first = service().pollDue(50);
      await gate.reached;
      await service().pollDue(50);
      expect(mine).toBe(1);
      // A person's lookup meanwhile asks nothing either (the running lookup answers).
      await lookup(p.code).expect(200);
      expect(mine).toBe(1);
      gate.release();
      await first;
      // Due once — no catching up for the six days; "Created" releases nothing.
      const one = await attemptRow(id);
      expect(one).toMatchObject({ status: 'SENT', pollCount: 1, carrierState: 'Created' });
      const gap = one.nextPollAt!.getTime() - Date.now();
      expect(gap).toBeGreaterThan(5_000);
      expect(gap).toBeLessThan(15_000);
      await service().pollDue(50);
      await lookup(p.code).expect(200); // due within the lease: nothing asked
      expect(mine).toBe(1);
      expect((await order([o.code], { date: pragueToday(2) })).body.code).toBe('ORDER_IN_PICKUP');

      // A crash during the next lookup: its lease expires and another poller takes it over.
      await dueNow(p.code);
      const crashed = await t.prisma.$queryRaw<{ id: string }[]>`
        UPDATE "carrier_pickup_cancellations" SET "next_poll_at" = now() - interval '1 second',
               "poll_count" = "poll_count" + 1
         WHERE "id" = ${id}::uuid RETURNING "id"`; // claimed, then the process died
      expect(crashed).toHaveLength(1);
      await service().pollDue(50);
      expect(mine).toBe(2);
      expect(await attemptRow(id)).toMatchObject({ status: 'SENT', pollCount: 3 });

      // A person's lookup when the next one is far: one extra read, not counted, time kept.
      const far = new Date(Date.now() + 10 * 60_000);
      await t.prisma.$executeRaw`UPDATE "carrier_pickup_cancellations" SET "next_poll_at" = ${far}
        WHERE "id" = ${id}::uuid`;
      await lookup(p.code).expect(200);
      expect(mine).toBe(3);
      expect(await attemptRow(id)).toMatchObject({ pollCount: 3, nextPollAt: far });

      // PPL shows Canceled: the next due lookup confirms and releases.
      ppl.orders.get(ref)!.cancelled = true;
      ppl.orders.get(ref)!.hiddenLooks = 0;
      await dueNow(p.code);
      await service().pollDue(50);
      expect(await attemptRow(id)).toMatchObject({ status: 'CONFIRMED', nextPollAt: null });
      expect(
        (await order([o.code], { date: pragueToday(2) }).expect(200)).body.parcels[0]
          .carrierParcelNumber,
      ).toBe(o.numbers[0]);
      expect(cancelPosts()).toBe(posts);
    } finally {
      find.mockRestore();
    }
  });

  it('a late closing names its attempt: closing A after B exists leaves B and its hold untouched', async () => {
    const o = await readyForPickup(1);
    const p = (await order([o.code]).expect(200)).body as PickupView;
    const a = await uncertainCancel(p.code);
    // Two people open the dialog for A; the second closes it and requests B (uncertain too).
    expect((await closeCancel(p.code, a).expect(200)).body.cancellation.status).toBe('NOT_CREATED');
    const auditA = await attemptRow(a);
    const b = await uncertainCancel(p.code);
    expect(b).not.toBe(a);
    const before = await attemptRow(b);
    const posts0 = cancelPosts();
    // The first person's late submit for A: refused; A keeps its audit, B is not touched.
    const late = await closeCancel(p.code, a);
    expect(late.status).toBe(409);
    expect(late.body).toMatchObject({ code: 'PICKUP_CANCEL_NOT_UNCERTAIN' });
    expect(await attemptRow(a)).toEqual(auditA);
    expect(await attemptRow(b)).toEqual(before);
    expect((await view(p.code)).cancellation).toMatchObject({ id: b, status: 'SENT' });
    expect(cancelPosts()).toBe(posts0);
    // B still holds the parcels — after the pickup's day too.
    await later(3, async () => {
      expect((await order([o.code], { date: pragueToday(3) })).body.code).toBe('ORDER_IN_PICKUP');
    });
    // An unknown attempt does not exist (another pickup's: below).
    expect((await closeCancel(p.code, randomUUID())).status).toBe(404);
  });

  it('Canceled read by a lookup and a closing based on "Created": the fact holds in both commit orders', async () => {
    const find = vi.spyOn(PplPickups.prototype, 'find');
    try {
      // Order 1 — the closing (its look: Created) commits first; the lookup's Canceled after it.
      const o = await readyForPickup(1);
      const p = (await order([o.code]).expect(200)).body as PickupView;
      const a = await uncertainCancel(p.code);
      const late = heldAnswer(CANCELED);
      find.mockImplementationOnce(late.run).mockResolvedValueOnce(CREATED);
      const looking = lookup(p.code).then((r) => r);
      await late.reached;
      const closed = (await closeCancel(p.code, a).expect(200)).body as PickupView;
      expect(closed.cancellation).toMatchObject({ id: a, status: 'NOT_CREATED' });
      expect(closed.cancelledByCarrierAt).toBeNull();
      // Still held until PPL's Canceled is recorded.
      expect((await order([o.code], { date: pragueToday(2) })).body.code).toBe('ORDER_IN_PICKUP');
      const audit = await attemptRow(a);
      late.release();
      expect((await looking).status).toBe(200);
      const v = await view(p.code);
      expect(v.cancelledByCarrierAt).not.toBeNull();
      expect(v.carrierState).toBe('Canceled');
      expect(await attemptRow(a)).toEqual(audit); // A's audit is not rewritten
      // No further cancellation; released (same label).
      const posts0 = cancelPosts();
      expect((await cancel(p.code)).body.code).toBe('PICKUP_NOT_CANCELLABLE');
      expect(cancelPosts()).toBe(posts0);
      expect(
        (await order([o.code], { date: pragueToday(2) }).expect(200)).body.parcels[0]
          .carrierParcelNumber,
      ).toBe(o.numbers[0]);

      // Order 2 — the lookup's Canceled commits first; the closing's older "Created" arrives late.
      const o2 = await readyForPickup(1);
      const q = (await order([o2.code]).expect(200)).body as PickupView;
      const a2 = await uncertainCancel(q.code);
      // Another pickup's attempt is not this pickup's.
      expect((await closeCancel(q.code, a)).status).toBe(404);
      const stale = heldAnswer(CREATED);
      find.mockImplementationOnce(stale.run).mockResolvedValueOnce(CANCELED);
      const closing = closeCancel(q.code, a2).then((r) => r);
      await stale.reached;
      expect((await lookup(q.code).expect(200)).body.cancellation).toMatchObject({
        id: a2,
        status: 'CONFIRMED',
      });
      stale.release();
      const refused = await closing;
      expect(refused.status).toBe(409);
      expect(refused.body.code).toBe('PICKUP_CANCEL_NOT_UNCERTAIN');
      const w = await view(q.code);
      expect(w.cancellation).toMatchObject({ status: 'CONFIRMED', carrierState: 'Canceled' });
      expect(w.cancelledByCarrierAt).not.toBeNull();
      expect(w.carrierState).toBe('Canceled'); // the stale "Created" replaced nothing

      // The same with B created between the closing of A and the late Canceled: B is confirmed
      // with the pickup (never sent if not yet), A keeps its audit.
      const o3 = await readyForPickup(1);
      const r = (await order([o3.code]).expect(200)).body as PickupView;
      const a3 = await uncertainCancel(r.code);
      const late3 = heldAnswer(CANCELED);
      find.mockImplementationOnce(late3.run).mockResolvedValueOnce(CREATED);
      const looking3 = lookup(r.code).then((x) => x);
      await late3.reached;
      await closeCancel(r.code, a3).expect(200);
      const audit3 = await attemptRow(a3);
      // B: its pre-look (after a closed attempt) shows Created; sent; the answer is lost.
      find.mockResolvedValueOnce(CREATED);
      const b3 = await uncertainCancel(r.code);
      late3.release();
      expect((await looking3).status).toBe(200);
      const x = await view(r.code);
      expect(x.cancellation).toMatchObject({ id: b3, status: 'CONFIRMED' });
      expect(x.cancelledByCarrierAt).not.toBeNull();
      expect(await attemptRow(a3)).toEqual(audit3);
    } finally {
      find.mockRestore();
    }
    // The database: no attempt for a pickup shown cancelled; confirmed only with the pickup's fact.
    const cancelled = await t.prisma.carrierPickup.findFirstOrThrow({
      where: { carrierCancelledAt: { not: null } },
    });
    await withPrivileged(async (db) => {
      await expect(
        db.$transaction(async (tx) => {
          const op = randomUUID();
          await tx.$executeRaw`INSERT INTO "operation_requests" ("request_id", "kind", "payload_sha256")
            VALUES (${op}::uuid, 'CARRIER_PICKUP_CANCEL', ${'0'.repeat(64)})`;
          await tx.$executeRaw`INSERT INTO "carrier_pickup_cancellations" ("pickup_id","reason","created_at","created_by","operation_request_id")
            VALUES (${cancelled.id}::uuid, 'znovu', now(), ${cancelled.createdBy}::uuid, ${op}::uuid)`;
        }),
      ).rejects.toThrow(/not shown cancelled/);
      await expect(
        db.$executeRaw`UPDATE "carrier_pickups" SET "carrier_state" = 'Created' WHERE "id" = ${cancelled.id}::uuid`,
      ).rejects.toThrow(/stays cancelled/);
    });
  });

  it('after its day no new cancellation starts: yesterday’s pickup, its parcel planned for tomorrow', async () => {
    const o = await readyForPickup(1);
    const p = (await order([o.code], { date: pragueToday(1) }).expect(200)).body as PickupView;
    expect(p.status).toBe('CONFIRMED');
    await later(2, async () => {
      // "Yesterday's" confirmed pickup releases its parcel; it is planned for "tomorrow".
      const next = (await order([o.code], { date: pragueToday(3) }).expect(200)).body as PickupView;
      expect(next.parcels.map((x) => x.carrierParcelNumber)).toEqual(o.numbers);
      expect((await view(p.code)).dayPassed).toBe(true);
      const posts0 = cancelPosts();
      const r = await cancel(p.code);
      expect(r.status).toBe(409);
      expect(r.body.code).toBe('PICKUP_CANCEL_DAY_PASSED');
      expect(cancelPosts()).toBe(posts0); // nothing was asked of PPL
      expect((await view(p.code)).cancellation).toBeNull();
      expect((await view(next.code)).status).toBe('CONFIRMED');
    });
  });

  it('the poller: a pickup lookup still waiting never holds back labels, ZPL or tracking; one pickup round at a time', async () => {
    const o = await readyForPickup(2);
    const p = (await order([o.code]).expect(200)).body as PickupView;
    ppl.mode.cancelOrderShownAfter = 1000;
    await cancel(p.code).expect(200);
    const ref = (await t.prisma.carrierPickup.findFirstOrThrow({ where: { code: p.code } }))
      .clientReference;
    const poller = t.app.get(ShipmentPoller);
    const flow = t.app.get(ShipmentCarrierFlow);
    const tracking = t.app.get(ShipmentTrackingService);
    const serial = Number(o.code.split('-').at(-1));
    const due = async () => {
      await t.prisma.$executeRaw`UPDATE "carrier_pickup_cancellations" SET "next_poll_at" = now()
        WHERE "status" = 'ACCEPTED' AND "next_poll_at" IS NOT NULL`;
      await t.prisma
        .$executeRaw`UPDATE "shipment_tracking" SET "next_at" = now() - interval '1 day', "lease_until" = NULL
        WHERE "shipment_id" IN (SELECT s."id" FROM "shipments" s JOIN "orders" o ON o."id" = s."order_id"
                                 WHERE o."serial" = ${serial})`;
    }; // first in line: earlier tests leave other shipments due too (one batch per round)
    const tracked = async (n: number) =>
      (
        await t.prisma.shipmentParcelProgress.findFirst({
          where: { parcel: { shipment: { order: { code: o.code } }, parcelNo: n } },
        })
      )?.pickedUpSource ?? null;
    const pickedUp = {
      statusId: 150,
      code: 'PickedUp',
      phase: 'InTransport',
      group: 'PickedUp',
      eventDate: new Date(Date.now() - 60_000).toISOString(),
      name: 'Zásilku jsme převzali od odesílatele.',
    };
    // Every lookup of THIS pickup waits at a gate (as PPL hanging up to the call's time limit),
    // then asks the simulation for real; how many run at once is counted. Lookups of other
    // pickups (uncertain attempts left by earlier tests in the shared database) pass straight on.
    const real = PplPickups.prototype.find;
    let calls = 0;
    let inFlight = 0;
    let maxInFlight = 0;
    let entered!: () => void;
    const reached = new Promise<void>((r) => (entered = r));
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const find = vi.spyOn(PplPickups.prototype, 'find').mockImplementation(async function (
      this: PplPickups,
      ...args
    ) {
      if (args[0].clientReference !== ref) return real.apply(this, args);
      calls++;
      maxInFlight = Math.max(maxInFlight, ++inFlight);
      entered();
      try {
        await gate;
        return await real.apply(this, args);
      } finally {
        inFlight--;
      }
    });
    const labelsDue = vi.spyOn(flow, 'pollDue');
    const zplDue = vi.spyOn(flow, 'variantsDue');
    const trackingDue = vi.spyOn(tracking, 'due');
    try {
      await due();
      const first = poller.tick();
      await reached;
      // The first round's shipment work finishes on its own; only its pickup lookup waits.
      await vi.waitFor(() => expect(trackingDue).toHaveBeenCalledTimes(1));
      await trackingDue.mock.results[0]!.value;
      await new Promise((r) => setImmediate(r));
      labelsDue.mockClear();
      zplDue.mockClear();
      trackingDue.mockClear();

      // The NEXT ordinary round: label requests, ZPL and tracking all run to the end.
      ppl.mode.events[o.numbers[0]!] = [pickedUp];
      await due();
      await poller.tick();
      expect(labelsDue).toHaveBeenCalledTimes(1);
      expect(zplDue).toHaveBeenCalledTimes(1);
      expect(trackingDue).toHaveBeenCalledTimes(1);
      expect(await tracked(1)).toBe('CARRIER');
      // …and no second pickup round started meanwhile.
      await poller.tick();
      expect(trackingDue).toHaveBeenCalledTimes(2);
      expect(calls).toBe(1);
      expect(inFlight).toBe(1);

      // PPL answers again (still not Canceled): the first round ends, the attempt waits.
      release();
      await first;
      expect((await view(p.code)).cancellation!.status).toBe('ACCEPTED');
      // PPL shows Canceled: the next round's pickup lookup confirms it.
      ppl.orders.get(ref)!.hiddenLooks = 0;
      await due();
      await poller.tick();
      const v = await view(p.code);
      expect(v.cancellation!.status).toBe('CONFIRMED');
      expect(v.cancelledByCarrierAt).not.toBeNull();
      expect(calls).toBe(2);
      expect(maxInFlight).toBe(1);
    } finally {
      release();
      find.mockRestore();
      labelsDue.mockRestore();
      zplDue.mockRestore();
      trackingDue.mockRestore();
    }
  });

  it('history after a cancellation, a new pickup and the later collection: today’s state, not proof', async () => {
    const o = await readyForPickup(1);
    const first = (await order([o.code]).expect(200)).body as PickupView;
    await cancel(first.code).expect(200);
    expect((await view(first.code)).cancellation!.status).toBe('CONFIRMED');
    const second = (await order([o.code], { date: pragueToday(2) }).expect(200)).body as PickupView;
    await pplPicksUp(o.code, o.numbers[0]!);
    // Both show the parcel's state TODAY — the cancelled one included; neither claims to have
    // collected it (the field says "now", and the board labels it so).
    const a = await view(first.code);
    const b = await view(second.code);
    expect(a.parcels[0]).toMatchObject({ carrierParcelNumber: o.numbers[0], withCarrierNow: true });
    expect(b.parcels[0]).toMatchObject({ carrierParcelNumber: o.numbers[0], withCarrierNow: true });
    expect(a.cancellation!.status).toBe('CONFIRMED');
    expect(Object.keys(a.parcels[0]!)).not.toContain('pickedUp');
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
