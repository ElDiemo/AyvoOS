import { randomUUID } from 'node:crypto';
import type {
  HotelDeliveries,
  OrderDetail,
  SavedSupplyPreview,
  SupplyPlanResponse,
  SupplyPreview,
} from '@ayvo/types';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { testCarrierControl } from '../src/carriers/test-carrier.js';
import { SupplyPlansService } from '../src/orders/supply-plans.service.js';
import { crateFactory, createHotel, createOrder, scanCrate } from './support/order-fixtures.js';
import { createTestApp, hasDatabase, type TestApp } from './support/test-app.js';

const ENV = {
  CARRIER_PROVIDER: 'test',
  CARRIER_POLL_SECONDS: '0',
  SUPPLY_PLAN_SECONDS: '0',
};

/**
 * Hotel supply plans (doc 032) on a real database with synthetic data: the background round is
 * driven here with a fixed clock (always in the future of the real day, so the existing "not in
 * the past" rule of orders holds). The crate type holds 2 bottles — never the constant 40.
 */
describe.skipIf(!hasDatabase)('hotel supply plans and automatic orders (doc 032)', () => {
  let t: TestApp;
  let factory: Awaited<ReturnType<typeof crateFactory>>;
  let product: string;
  let noRecipe: string;
  const http = () => request(t.app.getHttpServer());
  const rid = () => randomUUID();
  const plans = () => t.app.get(SupplyPlansService);
  const base = (hotel: string) => `/api/admin/orders/hotel/${hotel}/supply-plan`;
  const save = (hotel: string, body: object) =>
    http()
      .post(base(hotel))
      .send({ requestId: rid(), reason: 'plán podle smlouvy', ...body });
  /** The saved plan's preview and the version it comes from (what the confirmation shows). */
  const savedPreview = async (hotel: string) =>
    (
      await http()
        .get(`${base(hotel)}/preview`)
        .expect(200)
    ).body as SavedSupplyPreview;
  /** Switches on as a client does: the version of the saved plan's preview is confirmed. */
  const activate = async (hotel: string) => {
    const { version } = await savedPreview(hotel);
    return http()
      .post(`${base(hotel)}/activate`)
      .send({ requestId: rid(), confirm: true, version })
      .expect(200);
  };
  const planOf = async (hotel: string) =>
    t.prisma.supplyPlan.findFirstOrThrow({ where: { hotel: { code: hotel } } });
  const ordersOf = (hotel: string) =>
    t.prisma.order.findMany({
      where: { hotel: { code: hotel } },
      include: { lines: { include: { product: { select: { code: true } } } } },
      orderBy: { requestedShipDate: 'asc' },
    });
  const detail = async (code: string) =>
    (await http().get(`/api/admin/orders/${code}`).expect(200)).body as OrderDetail;
  /** The round of the background job, at a given instant. */
  const round = async (hotel: string, at: string) =>
    plans().generate((await planOf(hotel)).id, new Date(at));
  const counts = async () => ({
    movements: await t.prisma.inventoryMovement.count(),
    cycles: await t.prisma.crateEvent.count(),
    shipments: await t.prisma.shipment.count(),
  });

  beforeAll(async () => {
    t = await createTestApp(ENV);
    factory = await crateFactory(t, { capacity: 2 });
    product = factory.kit.productCode;
    // A product without any recipe (and therefore without a crate type).
    noRecipe = (
      (
        await http()
          .post('/api/admin/catalog/products')
          .send({
            requestId: rid(),
            code: `NR-${randomUUID().slice(0, 6).toUpperCase()}`,
            name: 'Sprchový gel bez receptury',
            categoryCode: 'HAND_SOAP',
            nominalQuantity: '330',
            nominalUnitCode: 'ml',
            reason: 'test bez receptury',
          })
          .expect(201)
      ).body as { code: string }
    ).code;
  });
  afterAll(async () => {
    testCarrierControl.reset();
    await t?.close();
  });
  beforeEach(() => testCarrierControl.reset());

  it('preview: same day merged, bottles from the recipe, skipped days, overlap — writes nothing', async () => {
    const hotel = (await createHotel(t)).code;
    // An existing manual order of the hotel on a planned day: shown as a possible overlap.
    const today = new Date();
    const manual = await createOrder(t, hotel, [{ productCode: product, crates: 1 }]);
    const before = {
      plans: await t.prisma.supplyPlan.count(),
      occurrences: await t.prisma.supplyPlanOccurrence.count(),
      orders: await t.prisma.order.count(),
    };
    const day = manual.requestedShipDate.slice(8, 10);
    const res = await http()
      .post(`${base(hotel)}/preview`)
      .send({
        validFrom: '2026-01-01',
        validTo: null,
        rules: [
          { productCode: product, crates: 2, days: [Number(day), 31] },
          { productCode: product, crates: 1, days: [Number(day)] },
          { productCode: noRecipe, crates: 1, days: [Number(day) === 15 ? 16 : 15] },
        ],
      })
      .expect(200);
    const p = res.body as SupplyPreview;
    const first = p.days.find((d) => d.shipDate === manual.requestedShipDate)!;
    // Two rules of one product on one day: one line, the sum of crates; capacity 2 (not 40).
    expect(first.lines).toEqual([
      expect.objectContaining({ productCode: product, crates: 3, capacity: 2, bottles: 6 }),
    ]);
    expect(first.existingOrders.map((o) => o.code)).toEqual([manual.code]);
    expect(first.inHorizon).toBe(true);
    const blocked = p.days.find((d) => d.blockers.length > 0)!;
    expect(blocked.blockers).toEqual([
      { code: 'PRODUCT_WITHOUT_RECIPE', product: noRecipe, detail: null },
    ]);
    expect(blocked.lines[0]).toMatchObject({ bottles: null, capacity: null });
    // A 31st missing in a month of the window is reported, never moved.
    const short = p.skipped.filter((s) => s.day === 31);
    for (const s of short) expect(p.days.map((d) => d.shipDate)).not.toContain(`${s.month}-31`);
    expect(p.summary.blocked).toBeGreaterThan(0);
    expect(p.from).toBe(
      new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Prague' }).format(today),
    );
    expect(p.days.every((d) => d.shipDate >= p.from && d.shipDate <= p.to)).toBe(true);
    expect({
      plans: await t.prisma.supplyPlan.count(),
      occurrences: await t.prisma.supplyPlanOccurrence.count(),
      orders: await t.prisma.order.count(),
    }).toEqual(before);
  });

  it('a new plan is switched off; switching on needs an explicit confirmation; reason required', async () => {
    const hotel = (await createHotel(t)).code;
    const body = {
      validFrom: '2027-01-01',
      validTo: null,
      rules: [{ productCode: product, crates: 1, days: [5] }],
    };
    expect(
      (
        await http()
          .post(base(hotel))
          .send({ requestId: rid(), ...body })
      ).status,
    ).toBe(400);
    const saved = (await save(hotel, body).expect(200)).body as SupplyPlanResponse;
    expect(saved.plan).toMatchObject({ status: 'INACTIVE', version: 1, activatedAt: null });
    // Switched off: the round creates nothing.
    expect(await round(hotel, '2027-01-03T08:00:00Z')).toEqual({ created: 0, blocked: 0 });
    expect(await ordersOf(hotel)).toEqual([]);
    const unconfirmed = await http()
      .post(`${base(hotel)}/activate`)
      .send({ requestId: rid() });
    expect(unconfirmed.status).toBe(400);
    // Without the confirmed version: refused as invalid (PLAN40-R2).
    const versionless = await http()
      .post(`${base(hotel)}/activate`)
      .send({ requestId: rid(), confirm: true });
    expect(versionless.status).toBe(400);
    const on = (await activate(hotel)).body as SupplyPlanResponse;
    expect(on.plan).toMatchObject({ status: 'ACTIVE' });
    expect(on.plan!.activatedBy).not.toBeNull();
    const audit = await t.prisma.auditEvent.findMany({
      where: {
        type: { in: ['SUPPLY_PLAN_SAVED', 'SUPPLY_PLAN_ACTIVATED'] },
        payload: { path: ['hotel'], equals: hotel },
      },
      orderBy: { occurredAt: 'asc' },
    });
    expect(audit.map((a) => a.type)).toEqual(['SUPPLY_PLAN_SAVED', 'SUPPLY_PLAN_ACTIVATED']);
    expect(audit[0]!.payload).toMatchObject({ reason: 'plán podle smlouvy', rules: body.rules });
  });

  it('two admins: a version saved after the preview is never switched on by the old confirmation (PLAN40-R2)', async () => {
    const hotel = (await createHotel(t)).code;
    // The preview looks at the real next 30 days of the site: every day of the month planned.
    const { today } = (await http().get('/api/admin/orders/calendar').expect(200)).body as {
      today: string;
    };
    const every = Array.from({ length: 31 }, (_, d) => d + 1);
    const v1 = { validFrom: today, validTo: null };
    await save(hotel, { ...v1, rules: [{ productCode: product, crates: 10, days: every }] }).expect(
      200,
    );
    // Admin A previews the SAVED plan: version 1, 10 crates.
    const seenByA = await savedPreview(hotel);
    expect(seenByA.version).toBe(1);
    expect(seenByA.preview.days[0]!.lines).toEqual([
      expect.objectContaining({ productCode: product, crates: 10 }),
    ]);
    // Admin B saves version 2 meanwhile: 1 crate.
    await save(hotel, { ...v1, rules: [{ productCode: product, crates: 1, days: every }] }).expect(
      200,
    );
    // A confirms the old dialog: refused, nothing switched on, nothing audited as activated.
    const requestId = rid();
    const stale = await http()
      .post(`${base(hotel)}/activate`)
      .send({ requestId, confirm: true, version: seenByA.version });
    expect([stale.status, stale.body.code]).toEqual([409, 'SUPPLY_PLAN_VERSION_CHANGED']);
    expect(stale.body.details).toEqual({ confirmed: 1, saved: 2 });
    expect(await planOf(hotel)).toMatchObject({
      status: 'INACTIVE',
      activatedAt: null,
      version: 2,
    });
    const activated = () =>
      t.prisma.auditEvent.count({
        where: { type: 'SUPPLY_PLAN_ACTIVATED', payload: { path: ['hotel'], equals: hotel } },
      });
    expect(await activated()).toBe(0);
    // A new preview shows version 2 (1 crate); confirming that one switches it on.
    const fresh = await savedPreview(hotel);
    expect(fresh.version).toBe(2);
    expect(fresh.preview.days[0]!.lines).toEqual([
      expect.objectContaining({ productCode: product, crates: 1 }),
    ]);
    const okId = rid();
    await http()
      .post(`${base(hotel)}/activate`)
      .send({ requestId: okId, confirm: true, version: 2 })
      .expect(200);
    expect(await planOf(hotel)).toMatchObject({ status: 'ACTIVE', version: 2 });
    expect(await activated()).toBe(1);
    // The version is part of the idempotent payload: the same request id with another version is a
    // conflict, the same request replayed is the same answer.
    const reused = await http()
      .post(`${base(hotel)}/activate`)
      .send({ requestId: okId, confirm: true, version: 1 });
    expect([reused.status, reused.body.code]).toEqual([409, 'IDEMPOTENCY_CONFLICT']);
    await http()
      .post(`${base(hotel)}/activate`)
      .send({ requestId: okId, confirm: true, version: 2 })
      .expect(200);
    expect(await activated()).toBe(1);
  });

  it('the round: one complete order per day in the 14-day horizon, origin kept; no stock, cycles or carrier', async () => {
    const hotel = (await createHotel(t)).code;
    await save(hotel, {
      validFrom: '2027-01-01',
      validTo: null,
      rules: [
        { productCode: product, crates: 2, days: [1, 11, 21] },
        { productCode: product, crates: 1, days: [11] },
      ],
    }).expect(200);
    await activate(hotel);
    const before = await counts();
    // Prague 2027-01-10: the horizon is 10 → 23 January.
    expect(await round(hotel, '2027-01-10T09:00:00Z')).toEqual({ created: 2, blocked: 0 });
    const orders = await ordersOf(hotel);
    expect(orders.map((o) => o.requestedShipDate.toISOString().slice(0, 10))).toEqual([
      '2027-01-11',
      '2027-01-21',
    ]);
    // Two rules of the same product on the 11th: one line with 3 crates; bottles from capacity.
    expect(orders[0]!.lines.map((l) => [l.product.code, l.crates, l.capacity, l.bottles])).toEqual([
      [product, 3, 2, 6],
    ]);
    expect(orders.every((o) => o.origin === 'SUPPLY_PLAN' && o.status === 'OPEN')).toBe(true);
    const d = await detail(orders[0]!.code);
    expect(d).toMatchObject({ origin: 'SUPPLY_PLAN', plannedShipDate: '2027-01-11' });
    expect(d.history[0]).toMatchObject({ type: 'CREATED' });
    const occ = await t.prisma.supplyPlanOccurrence.findMany({
      where: { plan: { hotel: { code: hotel } } },
      orderBy: { shipDate: 'asc' },
    });
    expect(occ.map((o) => [o.status, o.planVersion])).toEqual([
      ['ORDERED', 1],
      ['ORDERED', 1],
    ]);
    expect(occ[0]!.snapshot).toMatchObject({
      lines: [{ productCode: product, crates: 3, capacity: 2, bottles: 6 }],
    });
    // Generating changes no stock, no crate cycle and calls no carrier.
    expect(await counts()).toEqual(before);
    expect(testCarrierControl.calls).toHaveLength(0);
    expect(testCarrierControl.trackCalls).toBe(0);
    const audit = await t.prisma.auditEvent.count({
      where: { type: 'SUPPLY_PLAN_ORDER_CREATED', payload: { path: ['hotel'], equals: hotel } },
    });
    expect(audit).toBe(2);
  });

  it('repeated, concurrent and restarted rounds never duplicate; after an outage only future days are filled', async () => {
    const hotel = (await createHotel(t)).code;
    await save(hotel, {
      validFrom: '2027-02-01',
      validTo: null,
      rules: [{ productCode: product, crates: 1, days: [2, 9, 16, 23] }],
    }).expect(200);
    await activate(hotel);
    // Three rounds at once (several processes / a lost answer repeated).
    const results = await Promise.all([
      round(hotel, '2027-02-01T08:00:00Z'),
      round(hotel, '2027-02-01T08:00:00Z'),
      round(hotel, '2027-02-01T08:00:00Z'),
    ]);
    expect(results.reduce((n, r) => n + r.created, 0)).toBe(2); // 2nd and 9th
    expect((await ordersOf(hotel)).length).toBe(2);
    await round(hotel, '2027-02-01T09:00:00Z');
    expect((await ordersOf(hotel)).length).toBe(2);
    // The job was down from 2 to 20 February: the 16th is past — never created; the 23rd and
    // 2 March (inside the new horizon, 20 Feb → 5 Mar) are.
    await round(hotel, '2027-02-20T08:00:00Z');
    expect(
      (await ordersOf(hotel)).map((o) => o.requestedShipDate.toISOString().slice(0, 10)),
    ).toEqual(['2027-02-02', '2027-02-09', '2027-02-23', '2027-03-02']);
    // The database refuses a second occurrence of the same day, whatever the version.
    const plan = await planOf(hotel);
    await expect(
      t.prisma.supplyPlanOccurrence.create({
        data: {
          planId: plan.id,
          shipDate: new Date('2027-02-23T00:00:00Z'),
          status: 'BLOCKED',
          planVersion: plan.version + 1,
          snapshot: {},
          blockedCode: 'UNKNOWN_PRODUCT',
        },
      }),
    ).rejects.toThrow();
  });

  it('month ends and a leap year: a missing day is skipped, never moved', async () => {
    const hotel = (await createHotel(t)).code;
    await save(hotel, {
      validFrom: '2028-02-01',
      validTo: null,
      rules: [{ productCode: product, crates: 1, days: [29, 30, 31] }],
    }).expect(200);
    await activate(hotel);
    await round(hotel, '2028-02-20T08:00:00Z'); // horizon 20 Feb → 4 Mar 2028
    expect(
      (await ordersOf(hotel)).map((o) => o.requestedShipDate.toISOString().slice(0, 10)),
    ).toEqual(['2028-02-29']);
  });

  it('the site time zone decides the day, also across a daylight saving change', async () => {
    const hotel = (await createHotel(t)).code;
    await save(hotel, {
      validFrom: '2027-03-01',
      validTo: null,
      rules: [{ productCode: product, crates: 1, days: [27, 28] }],
    }).expect(200);
    await activate(hotel);
    // 27 March 23:30 UTC = 28 March 00:30 in Prague (summer time starts that night): the 27th is
    // already past at the site, though it is still the 27th in UTC.
    await round(hotel, '2027-03-27T23:30:00Z');
    expect(
      (await ordersOf(hotel)).map((o) => o.requestedShipDate.toISOString().slice(0, 10)),
    ).toEqual(['2027-03-28']);
  });

  it('a changed ship day keeps the occurrence; a cancelled order is not created again; edits and pauses never rewrite orders', async () => {
    const hotel = (await createHotel(t)).code;
    await save(hotel, {
      validFrom: '2027-04-01',
      validTo: null,
      rules: [{ productCode: product, crates: 1, days: [5, 12] }],
    }).expect(200);
    await activate(hotel);
    await round(hotel, '2027-04-01T08:00:00Z');
    const [first, second] = await ordersOf(hotel);
    // Sent earlier: an explicit change of the ship day (orders:manage, reason, audit, event).
    const moved = (
      await http()
        .post(`/api/admin/orders/${first!.code}/reschedule`)
        .send({ requestId: rid(), shipDate: '2027-04-03', reason: 'hotel potřebuje dřív' })
        .expect(200)
    ).body as OrderDetail;
    expect(moved).toMatchObject({ requestedShipDate: '2027-04-03', plannedShipDate: '2027-04-05' });
    expect(moved.history.at(-1)).toMatchObject({
      type: 'RESCHEDULED',
      shipDateFrom: '2027-04-05',
      shipDateTo: '2027-04-03',
      reason: 'hotel potřebuje dřív',
    });
    const past = await http()
      .post(`/api/admin/orders/${first!.code}/reschedule`)
      .send({ requestId: rid(), shipDate: '2020-01-01', reason: 'chyba' });
    expect([past.status, past.body.code]).toEqual([422, 'SHIP_DATE_IN_PAST']);
    // Cancelled: never created again for the same occurrence.
    await http()
      .post(`/api/admin/orders/${second!.code}/cancel`)
      .send({ requestId: rid(), reason: 'hotel zavřený' })
      .expect(200);
    // A new version with more crates, then the round again.
    await save(hotel, {
      validFrom: '2027-04-01',
      validTo: null,
      rules: [{ productCode: product, crates: 3, days: [5, 12, 13] }],
    }).expect(200);
    await round(hotel, '2027-04-02T08:00:00Z');
    const after = await ordersOf(hotel);
    expect(after.map((o) => [o.code, o.status, o.lines[0]!.crates])).toEqual([
      [first!.code, 'OPEN', 1], // moved to the 3rd: unchanged, no replacement for the 5th
      [second!.code, 'CANCELLED', 1], // the 12th: cancelled, not created again
      [expect.any(String), 'OPEN', 3], // the 13th: new day of version 2
    ]);
    expect((await planOf(hotel)).version).toBe(2);
    // Paused: nothing new; existing orders untouched.
    await http()
      .post(`${base(hotel)}/pause`)
      .send({ requestId: rid(), reason: 'hotel v rekonstrukci' })
      .expect(200);
    await save(hotel, {
      validFrom: '2027-04-01',
      validTo: null,
      rules: [{ productCode: product, crates: 1, days: [14] }],
    }).expect(200);
    expect(await round(hotel, '2027-04-02T08:00:00Z')).toEqual({ created: 0, blocked: 0 });
    expect((await ordersOf(hotel)).length).toBe(3);
    const view = (await http().get(base(hotel)).expect(200)).body as SupplyPlanResponse;
    expect(view.plan).toMatchObject({ status: 'PAUSED', version: 3 });
    expect(
      view.plan!.orders.map((o) => [o.plannedShipDate, o.requestedShipDate, o.status]),
    ).toEqual([
      ['2027-04-13', '2027-04-13', 'OPEN'],
      ['2027-04-12', '2027-04-12', 'CANCELLED'],
      ['2027-04-05', '2027-04-03', 'OPEN'],
    ]);
  });

  it('a missing recipe blocks the whole day visibly — never a partial order', async () => {
    const hotel = (await createHotel(t)).code;
    await save(hotel, {
      validFrom: '2027-05-01',
      validTo: null,
      rules: [
        { productCode: product, crates: 1, days: [6, 7] },
        { productCode: noRecipe, crates: 1, days: [7] },
      ],
    }).expect(200);
    await activate(hotel);
    expect(await round(hotel, '2027-05-05T08:00:00Z')).toEqual({ created: 1, blocked: 1 });
    expect(
      (await ordersOf(hotel)).map((o) => o.requestedShipDate.toISOString().slice(0, 10)),
    ).toEqual(['2027-05-06']);
    const view = (await http().get(base(hotel)).expect(200)).body as SupplyPlanResponse;
    expect(view.plan!.blocked).toEqual([
      {
        shipDate: '2027-05-07',
        blockers: [{ code: 'PRODUCT_WITHOUT_RECIPE', product: noRecipe, detail: null }],
      },
    ]);
    // Tried again on the next round, still blocked — still no order and no second occurrence.
    expect(await round(hotel, '2027-05-05T09:00:00Z')).toEqual({ created: 0, blocked: 1 });
    expect(
      await t.prisma.supplyPlanOccurrence.count({ where: { planId: (await planOf(hotel)).id } }),
    ).toBe(2);
    // The rule removed: the old blocker is moot and no longer shown as current.
    await save(hotel, {
      validFrom: '2027-05-01',
      validTo: null,
      rules: [{ productCode: product, crates: 1, days: [6, 8] }],
    }).expect(200);
    expect(
      ((await http().get(base(hotel)).expect(200)).body as SupplyPlanResponse).plan!.blocked,
    ).toEqual([]);
  });

  it('manual orders stay possible beside a plan; the nearby orders are shown, nothing merged', async () => {
    const hotel = (await createHotel(t)).code;
    const manual = await createOrder(t, hotel, [{ productCode: product, crates: 1 }]);
    const extra = await createOrder(t, hotel, [{ productCode: product, crates: 2 }]);
    const near = (
      await http()
        .get(`/api/admin/orders/hotel/${hotel}/nearby/${manual.requestedShipDate}`)
        .expect(200)
    ).body as { code: string; origin: string }[];
    expect(near.map((o) => [o.code, o.origin])).toEqual([
      [manual.code, 'MANUAL'],
      [extra.code, 'MANUAL'],
    ]);
  });

  it('deliveries: only delivered parcels count as delivered; the rest stays open, nothing twice', async () => {
    // The test carrier needs no parcel weight here (as in the tracking tests).
    testCarrierControl.rules.parcelWeight = 'NOT_USED';
    const hotel = (await createHotel(t)).code;
    const order = await createOrder(t, hotel, [{ productCode: product, crates: 2 }]);
    for (let i = 0; i < 2; i++) {
      const c = await factory.make();
      expect((await scanCrate(t, order.code, c.crateUrl)).status).toBe(200);
    }
    await http()
      .post(`/api/admin/orders/${order.code}/complete-and-label`)
      .send({ requestId: rid(), printerId: null })
      .expect(200);
    const overview = async () =>
      (await http().get(`/api/admin/orders/hotel/${hotel}/deliveries`).expect(200))
        .body as HotelDeliveries;
    // Labelled, not delivered: nothing delivered, 2 crates open.
    let o = await overview();
    expect(o.months.flatMap((m) => m.products)).toEqual([
      expect.objectContaining({ deliveredCrates: 0, openCrates: 2, openBottles: 4 }),
    ]);
    // One of two parcels delivered (per the carrier's tracking, doc 031).
    const shipment = await t.prisma.shipment.findFirstOrThrow({
      where: { order: { code: order.code }, status: 'LABELED' },
      include: { parcels: { orderBy: { parcelNo: 'asc' } } },
    });
    testCarrierControl.track(shipment.parcels[0]!.carrierParcelNumber!, {
      statusId: 450,
      at: new Date().toISOString(),
    });
    await http()
      .post(`/api/admin/orders/${order.code}/shipment/ready`)
      .send({ requestId: rid(), labelsApplied: true })
      .expect(200);
    await http()
      .post(`/api/admin/orders/${order.code}/shipment/tracking/refresh`)
      .send({ requestId: rid() })
      .expect(200);
    o = await overview();
    const cells = o.months.flatMap((m) => m.products);
    expect(cells.reduce((n, c) => n + c.deliveredCrates, 0)).toBe(1);
    expect(cells.reduce((n, c) => n + c.deliveredBottles, 0)).toBe(2);
    expect(cells.reduce((n, c) => n + c.openCrates, 0)).toBe(1);
    expect(cells.reduce((n, c) => n + c.openBottles, 0)).toBe(2);
    // A cancelled order is not open.
    const other = await createOrder(t, hotel, [{ productCode: product, crates: 5 }]);
    await http()
      .post(`/api/admin/orders/${other.code}/cancel`)
      .send({ requestId: rid(), reason: 'omyl' })
      .expect(200);
    o = await overview();
    expect(o.months.flatMap((m) => m.products).reduce((n, c) => n + c.openCrates, 0)).toBe(1);
  });

  it('a round never builds an order from a version saved meanwhile (it stops; the next round uses the new one)', async () => {
    const hotel = (await createHotel(t)).code;
    await save(hotel, {
      validFrom: '2027-06-01',
      validTo: null,
      rules: [{ productCode: product, crates: 5, days: [10] }],
    }).expect(200);
    await activate(hotel);
    const read = await planOf(hotel); // the version a round read its rules from
    await save(hotel, {
      validFrom: '2027-06-01',
      validTo: null,
      rules: [{ productCode: product, crates: 3, days: [10] }],
    }).expect(200);
    const svc = plans() as unknown as {
      occurrence: (p: string, v: number, d: string, l: object[]) => Promise<string>;
    };
    expect(
      await svc.occurrence(read.id, read.version, '2027-06-10', [
        { productCode: product, crates: 5 },
      ]),
    ).toBe('STOPPED');
    expect(await ordersOf(hotel)).toEqual([]);
    await round(hotel, '2027-06-05T08:00:00Z');
    const [order] = await ordersOf(hotel);
    expect(order!.lines[0]!.crates).toBe(3);
    const occ = await t.prisma.supplyPlanOccurrence.findFirstOrThrow({
      where: { orderId: order!.id },
    });
    expect(occ.planVersion).toBe(2);
  });

  it('practical hotel details: optional, with a reason, audited', async () => {
    const hotel = (await createHotel(t)).code;
    const h = (await http().get(`/api/admin/hotels/${hotel}`).expect(200)).body;
    expect(h.practical).toEqual({ deliveryNote: null, receivingContact: null });
    const body = {
      requestId: rid(),
      deliveryNote: 'Příjem zboží 7–15 h, zadní vchod u parkoviště',
      receivingContactName: 'Jana Skladová',
      receivingContactPhone: '+420 600 000 111',
      receivingContactEmail: '',
      reason: 'doplnění z telefonátu',
    };
    expect(
      (
        await http()
          .post(`/api/admin/hotels/${hotel}/practical`)
          .send({ ...body, reason: '' })
      ).status,
    ).toBe(400);
    const updated = (
      await http().post(`/api/admin/hotels/${hotel}/practical`).send(body).expect(200)
    ).body;
    expect(updated.practical).toEqual({
      deliveryNote: 'Příjem zboží 7–15 h, zadní vchod u parkoviště',
      receivingContact: { name: 'Jana Skladová', phone: '+420 600 000 111', email: null },
    });
    const audit = await t.prisma.auditEvent.findFirstOrThrow({
      where: { type: 'HOTEL_UPDATED', payload: { path: ['hotel'], equals: hotel } },
    });
    expect(audit.payload).toMatchObject({ reason: 'doplnění z telefonátu' });
  });
});
