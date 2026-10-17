import { randomUUID } from 'node:crypto';
import type {
  HotelDetail,
  HotelSummary,
  OrderDetail,
  OrderList,
  OrderScanResult,
} from '@ayvo/types';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CODE_PREFIX, formatCode } from '../src/common/codes.js';
import { allocateSerials } from '../src/database/code-counters.js';
import { correctCrate, fillingSession, fillLoadCrate } from './support/labeling-fixtures.js';
import {
  cancelOrder,
  completeOrder,
  crateFactory,
  createHotel,
  createOrder,
  hotelBody,
  pragueToday,
  removeCrate,
  scanCrate,
} from './support/order-fixtures.js';
import { INITIAL_SITE_ID } from './support/sign-in.js';
import { createTestApp, hasDatabase, type TestApp } from './support/test-app.js';
import { drift } from './support/warehouse-fixtures.js';

type Factory = Awaited<ReturnType<typeof crateFactory>>;

/**
 * Hotels, manual orders and picking (doc 028) through the API and the real database: an order
 * snapshots the hotel's site and address; bottles = crates × the crate type's capacity (2 here,
 * never 40 by code); only a full finished crate of the right product and site is loaded; a crate
 * is never in two orders; repeats change nothing; removal and cancellation release crates back to
 * FILLED with the history kept; completion only when exact; picking moves no stock.
 */
describe.skipIf(!hasDatabase)('hotels, orders and picking (doc 028)', () => {
  let t: TestApp;
  let soap: Factory;
  let gel: Factory;
  let hotel: HotelDetail;
  const http = () => request(t.app.getHttpServer());
  const ledger = async () => ({
    movements: await t.prisma.inventoryMovement.count(),
    balances: (await t.prisma.inventoryBalance.findMany({ orderBy: { id: 'asc' } })).map((b) =>
      b.onHand.toString(),
    ),
  });
  const cycleOf = (crateCode: string) =>
    t.prisma.crateCycle.findFirstOrThrow({
      where: { crate: { code: crateCode }, status: { not: 'ABORTED' } },
    });
  /** Every order of a tab, page by page (the first page's today and counts). */
  const allOf = async (view: string) => {
    let first: OrderList | null = null;
    const items: OrderList['items'] = [];
    for (let page = 1; ; page++) {
      const res = (
        await http().get('/api/admin/orders').query({ view, page, pageSize: 100 }).expect(200)
      ).body as OrderList;
      first ??= res;
      items.push(...res.items);
      if (page * res.pageSize >= res.total) break;
    }
    return { ...first!, items };
  };
  const detail = async (code: string) =>
    (await http().get(`/api/admin/orders/${code}`).expect(200)).body as OrderDetail;

  beforeAll(async () => {
    t = await createTestApp();
    soap = await crateFactory(t);
    gel = await crateFactory(t);
    hotel = await createHotel(t, { name: 'Hotel Bečva' });
  });
  afterAll(async () => {
    if (t) expect(await drift(t)).toEqual([]);
    await t?.close();
  });

  it('hotels: explicit fulfilment site (not the country), validated, idempotent, listed', async () => {
    // A Slovak hotel may be served from Přerov: the country never chooses the site.
    const body = hotelBody({ name: 'Hotel Tatry', countryCode: 'SK', city: 'Poprad' });
    const first = await http().post('/api/admin/hotels').send(body).expect(201);
    const again = await http().post('/api/admin/hotels').send(body).expect(201);
    expect(again.body.code).toBe(first.body.code); // replay, no second hotel
    expect(first.body).toMatchObject({
      name: 'Hotel Tatry',
      countryCode: 'SK',
      fulfillmentSite: { code: 'CZ-PREROV-01' },
      address: { city: 'Poprad', addressLine2: null },
      contact: { email: 'recepce@hotel.test' },
    });
    // A site that does not exist (or has no warehouse) cannot serve a hotel.
    const bad = await http()
      .post('/api/admin/hotels')
      .send(hotelBody({ fulfillmentSiteId: randomUUID() }));
    expect([bad.status, bad.body.code]).toEqual([422, 'FULFILLMENT_SITE_INVALID']);
    const invalid = await http()
      .post('/api/admin/hotels')
      .send(hotelBody({ contactEmail: 'not-an-email' }));
    expect(invalid.status).toBe(400);
    const list = (await http().get('/api/admin/hotels').expect(200)).body as HotelSummary[];
    expect(list.map((h) => h.code)).toEqual(expect.arrayContaining([hotel.code, first.body.code]));
    const sites = (await http().get('/api/admin/hotels/fulfillment-sites').expect(200)).body;
    expect(sites.map((s: { id: string }) => s.id)).toContain(INITIAL_SITE_ID);
    // The database keeps the code and fulfilment site immutable and never deletes a hotel.
    await expect(
      t.prisma.hotel.update({
        where: { code: hotel.code },
        data: { fulfillmentSiteId: randomUUID() },
      }),
    ).rejects.toThrow();
    await expect(t.prisma.hotel.delete({ where: { code: hotel.code } })).rejects.toThrow();
  });

  it('orders: whole crates × the crate type capacity, snapshot, validation, overview tabs', async () => {
    const order = await createOrder(t, hotel.code, [
      { productCode: soap.kit.productCode, crates: 2 },
      { productCode: gel.kit.productCode, crates: 1 },
    ]);
    expect(order).toMatchObject({
      status: 'OPEN',
      hotel: { code: hotel.code, name: 'Hotel Bečva' },
      site: { code: 'CZ-PREROV-01' },
      delivery: { hotelName: 'Hotel Bečva', city: 'Přerov', countryCode: 'CZ' },
      totals: { requiredCrates: 3, loadedCrates: 0, requiredBottles: 6, loadedBottles: 0 },
      lines: [
        { lineNo: 1, product: { code: soap.kit.productCode }, capacity: 2, requiredBottles: 4 },
        { lineNo: 2, product: { code: gel.kit.productCode }, capacity: 2, requiredBottles: 2 },
      ],
      history: [{ type: 'CREATED' }],
    });
    expect(order.code).toMatch(/^ORD-\d{6}$/);
    const past = await http()
      .post('/api/admin/orders')
      .send({
        requestId: randomUUID(),
        hotelCode: hotel.code,
        requestedShipDate: pragueToday(-2),
        lines: [{ productCode: soap.kit.productCode, crates: 1 }],
      });
    expect([past.status, past.body.code]).toEqual([422, 'SHIP_DATE_IN_PAST']);
    const half = await http()
      .post('/api/admin/orders')
      .send({
        requestId: randomUUID(),
        hotelCode: hotel.code,
        requestedShipDate: pragueToday(),
        lines: [{ productCode: soap.kit.productCode, crates: 1.5 }],
      });
    expect(half.status).toBe(400); // whole crates only
    const unknown = await http()
      .post('/api/admin/orders')
      .send({
        requestId: randomUUID(),
        hotelCode: hotel.code,
        requestedShipDate: pragueToday(),
        lines: [{ productCode: 'NO-SUCH', crates: 1 }],
      });
    expect([unknown.status, unknown.body.code]).toEqual([422, 'UNKNOWN_PRODUCT']);

    const future = await createOrder(
      t,
      hotel.code,
      [{ productCode: soap.kit.productCode, crates: 1 }],
      pragueToday(5),
    );
    // An overdue order (ship day passed while still open) — created directly as of an earlier day.
    const overdue = await t.prisma.$transaction(async (tx) => {
      const requestId = randomUUID();
      await tx.operationRequest.create({
        data: { requestId, kind: 'ORDER_CREATE', payloadSha256: '0'.repeat(64) },
      });
      const { first } = await allocateSerials(tx, 'order', 1);
      const h = await tx.hotel.findUniqueOrThrow({ where: { code: hotel.code } });
      const line = await tx.orderLine.findFirstOrThrow({ where: { order: { code: order.code } } });
      return tx.order.create({
        data: {
          serial: first,
          code: formatCode(CODE_PREFIX.order, first),
          hotelId: h.id,
          siteId: INITIAL_SITE_ID,
          requestedShipDate: new Date(`${pragueToday(-3)}T00:00:00Z`),
          hotelName: h.name,
          addressLine1: h.addressLine1,
          postalCode: h.postalCode,
          city: h.city,
          countryCode: h.countryCode,
          contactName: h.contactName,
          contactPhone: h.contactPhone,
          contactEmail: h.contactEmail,
          createdBy: h.createdBy,
          operationRequestId: requestId,
          lines: {
            create: [
              {
                lineNo: 1,
                productId: line.productId,
                crateTypeId: line.crateTypeId,
                capacity: line.capacity,
                crates: 1,
                bottles: line.capacity,
              },
            ],
          },
        },
      });
    });
    const tab = (view: string) => allOf(view);
    const today = await tab('today');
    expect(today.today).toBe(pragueToday());
    expect(today.items.map((o) => o.code)).toContain(order.code);
    expect(today.items.map((o) => o.code)).not.toContain(future.code);
    expect((await tab('future')).items.map((o) => o.code)).toContain(future.code);
    expect((await tab('overdue')).items.map((o) => o.code)).toContain(overdue.code);
    expect(today.counts.future).toBeGreaterThanOrEqual(1);
    const ofHotel = (
      await http().get(`/api/admin/orders/hotel/${hotel.code}?pageSize=100`).expect(200)
    ).body as { items: { code: string }[] };
    expect(ofHotel.items.map((o) => o.code)).toEqual(
      expect.arrayContaining([order.code, future.code, overdue.code]),
    );
    // The snapshot is immutable: an order never moves to another site or address.
    await expect(
      t.prisma.order.update({ where: { code: order.code }, data: { city: 'Brno' } }),
    ).rejects.toThrow();
    await cancelOrder(t, future.code).expect(200);
    await cancelOrder(t, overdue.code).expect(200);
    await cancelOrder(t, order.code).expect(200);
    expect((await tab('closed')).items.map((o) => o.code)).toEqual(
      expect.arrayContaining([order.code, future.code, overdue.code]),
    );
  });

  it('picking: only full finished crates of the ordered product; exact completion; no stock moved', async () => {
    const [a, b, c] = [await soap.make(), await soap.make(), await soap.make()];
    const g = await gel.make();
    const filling = await soap.make('FILLING');
    const assembled = await soap.make('READY_TO_FILL');
    const order = await createOrder(t, hotel.code, [
      { productCode: soap.kit.productCode, crates: 2 },
      { productCode: gel.kit.productCode, crates: 1 },
    ]);
    const before = await ledger();
    const statuses = await t.prisma.bottle.findMany({
      where: { id: { in: [...a.bottleIds, ...b.bottleIds, ...g.bottleIds] } },
      select: { id: true, status: true },
      orderBy: { id: 'asc' },
    });

    // Not finished: refused with what is missing, nothing written.
    for (const crate of [filling, assembled]) {
      const r = await scanCrate(t, order.code, crate.crateUrl);
      expect([r.status, r.body.code]).toEqual([409, 'CRATE_NOT_FINISHED']);
      expect(r.body.details).toMatchObject({ crate: crate.crateCode, capacity: 2 });
    }
    const notQr = await scanCrate(t, order.code, 'https://example.com/x');
    expect([notQr.status, notQr.body.code]).toEqual([422, 'NOT_AYVO_QR']);
    const bottleQr = (await t.prisma.bottle.findUniqueOrThrow({ where: { id: a.bottleIds[0]! } }))
      .publicToken;
    const notCrate = await scanCrate(t, order.code, a.crateUrl.replace(/[^/]+$/, bottleQr));
    expect([notCrate.status, notCrate.body.code]).toEqual([422, 'NOT_A_CRATE']);

    const requestId = randomUUID();
    const added = await scanCrate(t, order.code, a.crateUrl, requestId);
    expect(added.status, JSON.stringify(added.body)).toBe(200);
    expect(added.body as OrderScanResult).toMatchObject({
      outcome: 'ADDED',
      crate: a.crateCode,
      product: { code: soap.kit.productCode },
      order: {
        totals: { requiredCrates: 3, loadedCrates: 1, requiredBottles: 6, loadedBottles: 2 },
        crates: [{ crate: a.crateCode, bottles: 2, recipeVersion: 1 }],
      },
    });
    // The replay and a re-scan change nothing.
    const replay = await scanCrate(t, order.code, a.crateUrl, requestId);
    expect(replay.body.outcome).toBe('ADDED');
    const rescan = await scanCrate(t, order.code, a.crateUrl);
    expect([rescan.status, rescan.body.outcome]).toEqual([200, 'ALREADY_IN_ORDER']);
    expect(
      await t.prisma.orderCrateAllocation.count({ where: { crate: { code: a.crateCode } } }),
    ).toBe(1);
    expect((await detail(order.code)).totals.loadedCrates).toBe(1);

    // The cycle and every bottle membership are linked; the crate history records the order.
    const cycle = await cycleOf(a.crateCode);
    expect(cycle.status).toBe('ALLOCATED');
    const allocation = await t.prisma.orderCrateAllocation.findFirstOrThrow({
      where: { cycleId: cycle.id },
      include: { bottles: true },
    });
    expect(allocation.bottles.map((x) => x.bottleId).sort()).toEqual([...a.bottleIds].sort());
    const crateDetail = (await http().get(`/api/admin/crates/${a.crateCode}`).expect(200)).body;
    expect(crateDetail.events.at(-1)).toMatchObject({
      type: 'ALLOCATED_TO_ORDER',
      order: order.code,
    });
    expect(crateDetail.cycle.status).toBe('ALLOCATED');

    await scanCrate(t, order.code, b.crateUrl).expect(200);
    const over = await scanCrate(t, order.code, c.crateUrl);
    expect([over.status, over.body.code]).toEqual([409, 'LINE_COMPLETE']);
    const early = await completeOrder(t, order.code);
    expect([early.status, early.body.code]).toEqual([409, 'ORDER_INCOMPLETE']);
    expect(early.body.details.lines).toEqual([{ lineNo: 2, loaded: 0, crates: 1 }]);

    // An allocated crate keeps its bottles: no correction, refill or relabel touches it.
    const fix = await correctCrate(t, a.crateCode, 'remove-bottle', {
      bottle: (await t.prisma.bottle.findUniqueOrThrow({ where: { id: a.bottleIds[0]! } })).code,
    });
    expect([fix.status, fix.body.code]).toEqual([409, 'CRATE_ALLOCATED']);
    const reopen = await correctCrate(t, a.crateCode, 'reopen');
    expect([reopen.status, reopen.body.code]).toEqual([409, 'CRATE_ALLOCATED']);
    const fs = await fillingSession(t, 'HAND_SOAP');
    const load = await fillLoadCrate(t, fs, a.crateUrl);
    expect([load.status, load.body.code]).toEqual([409, 'CRATE_ALLOCATED']);

    // Removal before completion: back to FILLED, history kept, another crate fits.
    const removed = await removeCrate(t, order.code, b.crateCode, 'špatná bedna');
    expect(removed.status, JSON.stringify(removed.body)).toBe(200);
    expect((await cycleOf(b.crateCode)).status).toBe('FILLED');
    await scanCrate(t, order.code, c.crateUrl).expect(200);
    await scanCrate(t, order.code, g.crateUrl).expect(200);
    const done = await completeOrder(t, order.code);
    expect(done.status, JSON.stringify(done.body)).toBe(200);
    const final = done.body as OrderDetail;
    expect(final).toMatchObject({
      status: 'READY_TO_DISPATCH',
      totals: { requiredCrates: 3, loadedCrates: 3, requiredBottles: 6, loadedBottles: 6 },
    });
    expect(final.crates.map((x) => x.crate).sort()).toEqual(
      [a.crateCode, c.crateCode, g.crateCode].sort(),
    );
    expect(final.history.map((e) => [e.type, e.crate])).toEqual([
      ['CREATED', null],
      ['CRATE_ADDED', a.crateCode],
      ['CRATE_ADDED', b.crateCode],
      ['CRATE_REMOVED', b.crateCode],
      ['CRATE_ADDED', c.crateCode],
      ['CRATE_ADDED', g.crateCode],
      ['COMPLETED', null],
    ]);
    expect(final.history[3]!.reason).toBe('špatná bedna');
    // The released allocation stays as history.
    expect(
      await t.prisma.orderCrateAllocation.count({
        where: { crate: { code: b.crateCode }, releasedAt: { not: null } },
      }),
    ).toBe(1);
    // A ready order takes no more changes.
    const late = await removeCrate(t, order.code, a.crateCode);
    expect([late.status, late.body.code]).toEqual([409, 'ORDER_NOT_OPEN']);
    const again = await completeOrder(t, order.code);
    expect([again.status, again.body.code]).toEqual([409, 'ORDER_NOT_OPEN']);

    // Picking consumed nothing and changed no bottle status.
    expect(await ledger()).toEqual(before);
    expect(
      await t.prisma.bottle.findMany({
        where: { id: { in: [...a.bottleIds, ...b.bottleIds, ...g.bottleIds] } },
        select: { id: true, status: true },
        orderBy: { id: 'asc' },
      }),
    ).toEqual(statuses);
  });

  it('a crate is never in two orders; cancellation releases crates and keeps the history', async () => {
    const crate = await soap.make();
    const first = await createOrder(t, hotel.code, [
      { productCode: soap.kit.productCode, crates: 1 },
    ]);
    const second = await createOrder(t, hotel.code, [
      { productCode: soap.kit.productCode, crates: 1 },
    ]);
    const wrong = await createOrder(t, hotel.code, [
      { productCode: gel.kit.productCode, crates: 1 },
    ]);
    const notOrdered = await scanCrate(t, wrong.code, crate.crateUrl);
    expect([notOrdered.status, notOrdered.body.code]).toEqual([409, 'PRODUCT_NOT_IN_ORDER']);

    await scanCrate(t, first.code, crate.crateUrl).expect(200);
    const taken = await scanCrate(t, second.code, crate.crateUrl);
    expect([taken.status, taken.body.code, taken.body.details]).toEqual([
      409,
      'CRATE_IN_ANOTHER_ORDER',
      { crate: crate.crateCode, order: first.code },
    ]);
    await completeOrder(t, first.code).expect(200);
    // Cancelling the ready order releases its crate (FILLED again); the history stays.
    const cancelled = await cancelOrder(t, first.code, 'hotel odložil dodávku');
    expect(cancelled.status, JSON.stringify(cancelled.body)).toBe(200);
    expect(cancelled.body).toMatchObject({
      status: 'CANCELLED',
      cancelReason: 'hotel odložil dodávku',
      crates: [],
    });
    expect((cancelled.body as OrderDetail).history.map((e) => e.type)).toEqual([
      'CREATED',
      'CRATE_ADDED',
      'COMPLETED',
      'CANCELLED',
    ]);
    expect((await cycleOf(crate.crateCode)).status).toBe('FILLED');
    const kept = await t.prisma.orderCrateAllocation.findFirstOrThrow({
      where: { order: { code: first.code } },
    });
    expect(kept.releasedAt).not.toBeNull();
    const twice = await cancelOrder(t, first.code);
    expect([twice.status, twice.body.code]).toEqual([409, 'ORDER_NOT_OPEN']);
    const scanCancelled = await scanCrate(t, first.code, crate.crateUrl);
    expect([scanCancelled.status, scanCancelled.body.code]).toEqual([409, 'ORDER_NOT_OPEN']);
    // The released crate now fits the other order.
    await scanCrate(t, second.code, crate.crateUrl).expect(200);
    await cancelOrder(t, second.code).expect(200);
    await cancelOrder(t, wrong.code).expect(200);
  });

  it('concurrent scans: one crate into two orders, two crates into one remaining place', async () => {
    const crate = await soap.make();
    const [x, y] = [
      await createOrder(t, hotel.code, [{ productCode: soap.kit.productCode, crates: 1 }]),
      await createOrder(t, hotel.code, [{ productCode: soap.kit.productCode, crates: 1 }]),
    ];
    const results = await Promise.all([
      scanCrate(t, x.code, crate.crateUrl),
      scanCrate(t, y.code, crate.crateUrl),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
    expect(results.find((r) => r.status === 409)!.body.code).toBe('CRATE_IN_ANOTHER_ORDER');
    expect(
      await t.prisma.orderCrateAllocation.count({
        where: { crate: { code: crate.crateCode }, releasedAt: null },
      }),
    ).toBe(1);

    const [p, q] = [await soap.make(), await soap.make()];
    const one = await createOrder(t, hotel.code, [
      { productCode: soap.kit.productCode, crates: 1 },
    ]);
    const race = await Promise.all([
      scanCrate(t, one.code, p.crateUrl),
      scanCrate(t, one.code, q.crateUrl),
    ]);
    expect(race.map((r) => r.status).sort()).toEqual([200, 409]);
    expect(race.find((r) => r.status === 409)!.body.code).toBe('LINE_COMPLETE');
    expect((await detail(one.code)).totals.loadedCrates).toBe(1);
    // The same request sent twice at once is applied once.
    const twin = await createOrder(t, hotel.code, [
      { productCode: soap.kit.productCode, crates: 1 },
    ]);
    const r = await soap.make();
    const id = randomUUID();
    const both = await Promise.all([
      scanCrate(t, twin.code, r.crateUrl, id),
      scanCrate(t, twin.code, r.crateUrl, id),
    ]);
    expect(both.map((b) => b.status)).toEqual([200, 200]);
    expect(
      await t.prisma.orderEvent.count({
        where: { order: { code: twin.code }, type: 'CRATE_ADDED' },
      }),
    ).toBe(1);
    for (const o of [x, y, one, twin]) await cancelOrder(t, o.code).expect(200);
  });

  it('the database enforces the picking rules on its own', async () => {
    const crate = await soap.make();
    const order = await createOrder(t, hotel.code, [
      { productCode: soap.kit.productCode, crates: 1 },
    ]);
    const cycle = await cycleOf(crate.crateCode);
    // ALLOCATED only with an allocation (checked at commit).
    await expect(
      t.prisma.crateCycle.update({ where: { id: cycle.id }, data: { status: 'ALLOCATED' } }),
    ).rejects.toThrow(/ALLOCATED exactly while an order holds it/);
    await scanCrate(t, order.code, crate.crateUrl).expect(200);
    const allocation = await t.prisma.orderCrateAllocation.findFirstOrThrow({
      where: { cycleId: cycle.id, releasedAt: null },
    });
    // Never deleted; a bottle never leaves an allocated crate; no second active allocation.
    await expect(
      t.prisma.orderCrateAllocation.delete({ where: { id: allocation.id } }),
    ).rejects.toThrow();
    const member = await t.prisma.crateAssignment.findFirstOrThrow({
      where: { cycleId: cycle.id, releasedAt: null },
    });
    await expect(
      t.prisma.crateAssignment.update({
        where: { id: member.id },
        data: {
          releasedAt: new Date(),
          releasedBy: allocation.allocatedBy,
          releaseReason: 'x',
          releaseOperationId: allocation.operationRequestId,
        },
      }),
    ).rejects.toThrow(/never leaves a crate allocated/);
    // A ready order cannot be marked without its crates; the line counter cannot exceed crates.
    const line = await t.prisma.orderLine.findFirstOrThrow({
      where: { orderId: allocation.orderId },
    });
    await expect(
      t.prisma.orderLine.update({ where: { id: line.id }, data: { allocatedCrates: 2 } }),
    ).rejects.toThrow();
    const empty = await createOrder(t, hotel.code, [
      { productCode: soap.kit.productCode, crates: 1 },
    ]);
    await expect(
      t.prisma.order.update({
        where: { code: empty.code },
        data: {
          status: 'READY_TO_DISPATCH',
          completedAt: new Date(),
          completedBy: allocation.allocatedBy,
        },
      }),
    ).rejects.toThrow(/every line exactly complete/);
    await expect(
      t.prisma.orderEvent.deleteMany({ where: { orderId: allocation.orderId } }),
    ).rejects.toThrow();
    await cancelOrder(t, order.code).expect(200);
    await cancelOrder(t, empty.code).expect(200);
  });

  it('a site with only the WAREHOUSE capability but no warehouse cannot serve a hotel', async () => {
    const site = (
      await http()
        .post('/api/admin/sites')
        .send({
          code: `NW-${randomUUID().slice(0, 4).toUpperCase()}`,
          name: 'Bez skladu',
          countryCode: 'AT',
          addressLine1: 'Gasse 1',
          addressLine2: null,
          postalCode: '1010',
          city: 'Wien',
          timeZone: 'Europe/Vienna',
          defaultLocale: 'de-AT',
          defaultCurrency: 'EUR',
          capabilities: ['WAREHOUSE'],
          reason: 'site without its warehouse yet',
        })
        .expect(201)
    ).body as { id: string };
    const refused = await http()
      .post('/api/admin/hotels')
      .send(hotelBody({ fulfillmentSiteId: site.id }));
    expect([refused.status, refused.body.code]).toEqual([422, 'FULFILLMENT_SITE_INVALID']);
    const sites = (await http().get('/api/admin/hotels/fulfillment-sites').expect(200)).body;
    expect(sites.map((s: { id: string }) => s.id)).not.toContain(site.id);
  });

  it('one order line never mixes recipe versions or label designs; the pin is recorded', async () => {
    // Same product: two crates of one design (different liquid lots), one of another design.
    const first = await soap.make();
    const otherLot = await soap.make('FILLED', await soap.receiveLiquid());
    await soap.refill(); // next crates carry another approved design
    const otherDesign = await soap.make();
    const sameAsFirst = await t.prisma.crateCycle.findFirstOrThrow({
      where: { crate: { code: first.crateCode }, status: { not: 'ABORTED' } },
    });
    const order = await createOrder(t, hotel.code, [
      { productCode: soap.kit.productCode, crates: 2 },
    ]);
    await scanCrate(t, order.code, first.crateUrl).expect(200);
    let d = await detail(order.code);
    expect(d.lines[0]).toMatchObject({ recipeVersion: 1, loadedCrates: 1 });
    expect(d.lines[0]!.design).toBeTruthy();
    expect(d.crates[0]!.design).toBe(d.lines[0]!.design);
    const mixed = await scanCrate(t, order.code, otherDesign.crateUrl);
    expect([mixed.status, mixed.body.code]).toEqual([409, 'LINE_VERSION_MISMATCH']);
    expect(mixed.body.details.line.design).toBe(d.lines[0]!.design);
    expect(mixed.body.details.scanned.design).not.toBe(d.lines[0]!.design);
    // Different liquid lots are not a version: the first design with another lot fits.
    await scanCrate(t, order.code, otherLot.crateUrl).expect(200);
    const line = await t.prisma.orderLine.findFirstOrThrow({
      where: { order: { code: order.code } },
    });
    expect(line).toMatchObject({
      recipeVersionId: sameAsFirst.recipeVersionId,
      labelTemplateVersionId: sameAsFirst.labelTemplateVersionId,
    });
    // The database refuses a pin change while the line holds a crate.
    await expect(
      t.prisma.orderLine.update({
        where: { id: line.id },
        data: {
          labelTemplateVersionId: (
            await t.prisma.crateCycle.findFirstOrThrow({
              where: { crate: { code: otherDesign.crateCode }, status: { not: 'ABORTED' } },
            })
          ).labelTemplateVersionId,
        },
      }),
    ).rejects.toThrow(/never mixes/);
    // Empty again: the pin is released and the other design may start the line.
    await removeCrate(t, order.code, first.crateCode).expect(200);
    await removeCrate(t, order.code, otherLot.crateCode).expect(200);
    d = await detail(order.code);
    expect(d.lines[0]).toMatchObject({ recipeVersion: null, design: null, loadedCrates: 0 });
    await scanCrate(t, order.code, otherDesign.crateUrl).expect(200);
    const removedEvent = d.history.find((e) => e.type === 'CRATE_REMOVED')!;
    expect(removedEvent).toMatchObject({ crate: first.crateCode, reason: null });
    expect(removedEvent.actor).toBeTruthy(); // author and time kept without a reason
    await cancelOrder(t, order.code).expect(200);
    const noReason = await http()
      .post(`/api/admin/orders/${order.code}/cancel`)
      .send({ requestId: randomUUID(), reason: '' });
    expect(noReason.status).toBe(400); // cancelling always needs a reason
  });

  it('pages: every order of a tab and of a hotel is reachable beyond 200, in a stable order', async () => {
    const many = await createHotel(t, { name: 'Hotel Mnoho objednávek' });
    const day = pragueToday(40);
    const codes: string[] = [];
    for (let i = 0; i < 205; i++) {
      codes.push(
        (await createOrder(t, many.code, [{ productCode: soap.kit.productCode, crates: 1 }], day))
          .code,
      );
    }
    const seen: string[] = [];
    let total = 0;
    for (let page = 1; ; page++) {
      const res = (
        await http()
          .get(`/api/admin/orders/hotel/${many.code}`)
          .query({ page, pageSize: 100 })
          .expect(200)
      ).body as { items: { code: string }[]; total: number; pageSize: number };
      total = res.total;
      seen.push(...res.items.map((o) => o.code));
      if (page * res.pageSize >= res.total) break;
    }
    expect(total).toBe(205);
    expect(seen).toEqual([...codes].reverse()); // newest first, each exactly once, incl. the last
    const future = await allOf('future');
    const mine = future.items.map((o) => o.code).filter((c) => codes.includes(c));
    expect(mine).toEqual(codes); // ship day, then number — stable across pages
    expect(future.counts.future).toBe(future.items.length);
    const over = await http().get('/api/admin/orders').query({ pageSize: 101 });
    expect(over.status).toBe(400); // pages are bounded, never "everything"
    for (const code of codes) await cancelOrder(t, code).expect(200);
  });
});
