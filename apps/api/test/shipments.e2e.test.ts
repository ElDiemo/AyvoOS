import { randomUUID } from 'node:crypto';
import type { OrderDetail, OrderShipment } from '@ayvo/types';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { testCarrierControl } from '../src/orders/carriers/test-carrier.js';
import {
  cancelOrder,
  completeOrder,
  crateFactory,
  createHotel,
  createOrder,
  removeCrate,
  scanCrate,
} from './support/order-fixtures.js';
import { createTestApp, hasDatabase, type TestApp } from './support/test-app.js';

/**
 * Dispatch to a carrier (doc 029) against the real database with the FAKE test carrier (only
 * APP_ENV=test): one shipment per completed order, one parcel per crate (= one label), calculated
 * references vs. actual weighings, at most one carrier request sent per attempt (double click,
 * concurrency, lost answers before and after the carrier), re-printing without a new shipment,
 * ready for pickup / handed over, cancellation through the carrier only, no stock movement and
 * nothing that means "delivered". Synthetic data only.
 */
describe.skipIf(!hasDatabase)('dispatch: shipment, parcels, carrier labels (doc 029)', () => {
  let t: TestApp;
  let soap: Awaited<ReturnType<typeof crateFactory>>;
  let gel: Awaited<ReturnType<typeof crateFactory>>;
  let hotel: string;
  const http = () => request(t.app.getHttpServer());
  const base = (extra: Record<string, unknown> = {}) => ({
    requestId: randomUUID(),
    measuredOn: '2026-10-15',
    method: 'Plošinová váha, 1 bedna',
    correctionOf: null,
    correctionReason: null,
    ...extra,
  });

  beforeAll(async () => {
    t = await createTestApp({ CARRIER_PROVIDER: 'test' });
    soap = await crateFactory(t);
    gel = await crateFactory(t);
    // Soap: W1 references measured before Hotovo → the Hotovo snapshot knows the package.
    await http()
      .post(`/api/admin/catalog/products/${soap.kit.productCode}/weights`)
      .send(base({ recipeVersion: 1, massG: '372.5', bottlesWeighed: 10 }))
      .expect(201);
    await http()
      .post(`/api/admin/catalog/crate-types/${soap.kit.crateTypeCode}/tare`)
      .send(base({ massG: '1850', configuration: 'Bedna s přepážkami' }))
      .expect(201);
    await http()
      .post(`/api/admin/catalog/crate-types/${soap.kit.crateTypeCode}/dimensions`)
      .send(
        base({
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
      )
      .expect(201);
    hotel = (await createHotel(t, { name: 'Hotel Expedice' })).code;
  });
  afterAll(async () => {
    testCarrierControl.reset();
    await t?.close();
  });
  beforeEach(() => testCarrierControl.reset());

  /** 1 crate of soap + 2 crates of gel, picked and completed (the owner's example). */
  async function completedOrder(onPicked?: () => Promise<void>) {
    const s = await soap.make();
    const g1 = await gel.make();
    const g2 = await gel.make();
    const order = await createOrder(t, hotel, [
      { productCode: soap.kit.productCode, crates: 1 },
      { productCode: gel.kit.productCode, crates: 2 },
    ]);
    for (const c of [s, g1, g2])
      expect((await scanCrate(t, order.code, c.crateUrl)).status).toBe(200);
    await onPicked?.();
    const done = await completeOrder(t, order.code);
    expect(done.status, JSON.stringify(done.body)).toBe(200);
    return { order: order.code, crates: [s, g1, g2] };
  }
  const view = async (order: string) =>
    (await http().get(`/api/admin/orders/${order}/shipment`).expect(200)).body as OrderShipment;
  const detail = async (order: string) =>
    (await http().get(`/api/admin/orders/${order}`).expect(200)).body as OrderDetail;
  const labels = (order: string, requestId = randomUUID()) =>
    http().post(`/api/admin/orders/${order}/shipment/labels`).send({ requestId });
  const resolve = (order: string) =>
    http().post(`/api/admin/orders/${order}/shipment/resolve`).send({ requestId: randomUUID() });
  const weigh = (
    order: string,
    parcelNo: number,
    massG: string,
    correction?: { of: string; reason: string },
  ) =>
    http()
      .post(`/api/admin/orders/${order}/shipment/parcels/${parcelNo}/weighings`)
      .send({
        requestId: randomUUID(),
        massG,
        correctionOf: correction?.of ?? null,
        correctionReason: correction?.reason ?? null,
      });
  /** Weighs the gel parcels (no W1 reference) so the carrier's required weight is known. */
  async function weighUnknown(order: string) {
    for (const p of (await view(order)).shipment!.parcels) {
      if (!p.reference.massG) expect((await weigh(order, p.parcelNo, '2410.5')).status).toBe(200);
    }
  }
  const ledger = async () => ({
    movements: await t.prisma.inventoryMovement.count(),
    balances: (await t.prisma.inventoryBalance.findMany({ orderBy: { id: 'asc' } })).map((b) =>
      b.onHand.toString(),
    ),
  });

  it('3 crates → exactly 3 parcels of those crates and their bottles; references vs. unknown', async () => {
    let before = await ledger();
    const { order, crates } = await completedOrder(async () => {
      before = await ledger();
    });
    const v = await view(order);
    const s = v.shipment!;
    expect(s.status).toBe('DRAFT');
    expect(s.carrier).toMatchObject({ configured: true, code: 'TEST', parcelWeight: 'REQUIRED' });
    expect(s.parcels.map((p) => p.crate)).toEqual(crates.map((c) => c.crateCode));
    expect(s.parcels.map((p) => p.parcelNo)).toEqual([1, 2, 3]);
    // Soap: the Hotovo snapshot (2 × 372.5 + 1850, no extra packaging) — a calculated reference.
    expect(s.parcels[0]).toMatchObject({
      reference: { massG: '2595', source: 'HOTOVO_SNAPSHOT' },
      actual: null,
      dimensions: { lengthMm: 600, widthMm: 400, heightMm: 300 },
      carrierParcelNumber: null,
    });
    // Gel: nothing measured → unknown (never 0) and reported as missing for this carrier.
    expect(s.parcels[1]!.reference).toEqual({ massG: null, source: null });
    expect(s.missing).toEqual([
      { field: 'PARCEL_WEIGHT', parcelNo: 2 },
      { field: 'PARCEL_WEIGHT', parcelNo: 3 },
    ]);
    // Each parcel is the crate's allocation: its bottles are those loaded at picking.
    const rows = await t.prisma.shipmentParcel.findMany({
      where: { shipment: { code: s.code } },
      include: { allocation: { include: { bottles: true } } },
      orderBy: { parcelNo: 'asc' },
    });
    expect(rows.map((r) => r.allocation.bottles.map((b) => b.bottleId).sort())).toEqual(
      crates.map((c) => [...c.bottleIds].sort()),
    );
    expect((await detail(order)).history.map((e) => e.type).slice(-2)).toEqual([
      'COMPLETED',
      'SHIPMENT_CREATED',
    ]);
    expect(await ledger()).toEqual(before);
  });

  it('missing required data refuses the request (nothing sent); weighing makes it complete', async () => {
    const { order } = await completedOrder();
    const refused = await labels(order);
    expect([refused.status, refused.body.code]).toEqual([422, 'SHIPMENT_DATA_MISSING']);
    expect(testCarrierControl.calls).toHaveLength(0);
    expect((await view(order)).shipment!.status).toBe('DRAFT');
    await weighUnknown(order);
    const v = await view(order);
    expect(v.shipment!.missing).toEqual([]);
    // The actual weighing is kept apart from the reference (which stays unknown).
    expect(v.shipment!.parcels[1]).toMatchObject({
      reference: { massG: null },
      actual: { massG: '2410.5' },
    });
    // A second weighing without correcting the first is refused; a correction keeps the first.
    const first = v.shipment!.parcels[1]!.actual!;
    expect((await weigh(order, 2, '2400')).body.code).toBe('WEIGHING_EXISTS');
    expect((await weigh(order, 2, '2400', { of: first.id, reason: 'Převážení' })).status).toBe(200);
    expect((await view(order)).shipment!.parcels[1]!.actual!.massG).toBe('2400');
    expect(
      await t.prisma.shipmentParcelWeighing.count({
        where: { parcel: { parcelNo: 2, shipment: { order: { code: order } } } },
      }),
    ).toBe(2);
  });

  it('success: one carrier request with 3 parcels → 3 numbers and stored labels; re-print sends nothing', async () => {
    let before = await ledger();
    const { order, crates } = await completedOrder(async () => {
      before = await ledger();
    });
    await weighUnknown(order);
    const res = await labels(order);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const s = (res.body as OrderShipment).shipment!;
    expect(s.status).toBe('LABELED');
    expect(s.parcels.every((p) => p.carrierParcelNumber)).toBe(true);
    expect(new Set(s.parcels.map((p) => p.carrierParcelNumber)).size).toBe(3);
    expect(testCarrierControl.calls).toHaveLength(1);
    const sent = testCarrierControl.calls[0]!;
    expect(sent.parcels.map((p) => [p.reference, p.weightG])).toEqual([
      [crates[0]!.crateCode, '2595'],
      [crates[1]!.crateCode, '2410.5'],
      [crates[2]!.crateCode, '2410.5'],
    ]);
    // The recipient is the order's snapshot, not the hotel as it is now.
    expect(sent.recipient).toMatchObject({ name: 'Hotel Expedice', postalCode: '750 02' });
    const pdf1 = await http().get(`/api/admin/orders/${order}/shipment/labels.pdf`).expect(200);
    const pdf2 = await http().get(`/api/admin/orders/${order}/shipment/labels.pdf`).expect(200);
    expect(pdf1.headers['content-type']).toContain('application/pdf');
    expect(Buffer.compare(pdf1.body as Buffer, pdf2.body as Buffer)).toBe(0);
    expect(testCarrierControl.calls).toHaveLength(1);
    // A second request (new click) creates nothing new.
    expect((await labels(order)).body.code).toBe('LABELS_EXIST');
    expect(testCarrierControl.calls).toHaveLength(1);
    // Labels exist ≠ printed ≠ ready: the order stays "Kompletace dokončena".
    expect((await detail(order)).status).toBe('READY_TO_DISPATCH');
    expect(await ledger()).toEqual(before);
  });

  it('double click and concurrent requests send exactly one carrier request', async () => {
    const { order } = await completedOrder();
    await weighUnknown(order);
    const same = randomUUID();
    const answers = await Promise.all([
      labels(order),
      labels(order),
      labels(order, same),
      labels(order, same),
    ]);
    expect(answers.map((a) => a.status).filter((s) => s >= 500)).toEqual([]);
    expect(testCarrierControl.calls).toHaveLength(1);
    expect(
      await t.prisma.shipmentCarrierRequest.count({
        where: { shipment: { order: { code: order } } },
      }),
    ).toBe(1);
    expect((await view(order)).shipment!.status).toBe('LABELED');
  });

  it('answer lost BEFORE the carrier: uncertain, never re-sent; the lookup says not created; a new attempt succeeds', async () => {
    const { order } = await completedOrder();
    await weighUnknown(order);
    testCarrierControl.next = ['LOSE_BEFORE'];
    const first = await labels(order);
    expect(first.status).toBe(200);
    let s = (first.body as OrderShipment).shipment!;
    expect(s.status).toBe('REQUESTING');
    expect(s.request).toMatchObject({ status: 'SENT', errorCode: 'NO_ANSWER' });
    // Another click and a replay find the unresolved request: nothing is sent again.
    await labels(order);
    expect(testCarrierControl.calls).toHaveLength(1);
    // Nor can the order be cancelled or its crates released meanwhile.
    expect((await cancelOrder(t, order)).body.code).toBe('SHIPMENT_AT_CARRIER');
    s = ((await resolve(order)).body as OrderShipment).shipment!;
    expect(s.status).toBe('DRAFT');
    expect(s.request).toMatchObject({ status: 'NOT_CREATED' });
    const again = await labels(order);
    expect((again.body as OrderShipment).shipment).toMatchObject({
      status: 'LABELED',
      request: { attemptNo: 2, status: 'SUCCEEDED' },
    });
    expect(testCarrierControl.calls.map((c) => c.clientReference)).toEqual([
      `${s.code}-1`,
      `${s.code}-2`,
    ]);
    expect((await detail(order)).history.map((e) => e.type)).toEqual(
      expect.arrayContaining(['LABELS_UNCERTAIN', 'LABELS_NOT_CREATED', 'LABELS_CREATED']),
    );
  });

  it('answer lost AFTER the carrier created it: the lookup finds it — no second shipment', async () => {
    const { order } = await completedOrder();
    await weighUnknown(order);
    testCarrierControl.next = ['LOSE_AFTER'];
    expect(((await labels(order)).body as OrderShipment).shipment!.status).toBe('REQUESTING');
    const s = ((await resolve(order)).body as OrderShipment).shipment!;
    expect(s).toMatchObject({ status: 'LABELED', request: { attemptNo: 1, status: 'SUCCEEDED' } });
    expect(testCarrierControl.calls).toHaveLength(1);
    expect(testCarrierControl.created.size).toBe(1);
  });

  it('a request that may still be in flight is not looked up', async () => {
    const { order } = await completedOrder();
    await weighUnknown(order);
    testCarrierControl.next = ['LOSE_BEFORE'];
    await labels(order);
    // As if the sending process were still waiting for the carrier (no finished call recorded).
    await t.prisma
      .$executeRaw`UPDATE "shipment_carrier_requests" SET "error_code" = NULL, "error_message" = NULL
      WHERE "shipment_id" = (SELECT s."id" FROM "shipments" s JOIN "orders" o ON o."id" = s."order_id" WHERE o."code" = ${order})`;
    expect((await resolve(order)).body.code).toBe('REQUEST_IN_FLIGHT');
    expect(testCarrierControl.calls).toHaveLength(1);
  });

  it('refused by the carrier: back to draft with the reason; asynchronous acceptance; labels downloaded later', async () => {
    const a = await completedOrder();
    await weighUnknown(a.order);
    testCarrierControl.next = ['REJECT'];
    const refused = ((await labels(a.order)).body as OrderShipment).shipment!;
    expect(refused).toMatchObject({
      status: 'DRAFT',
      request: { status: 'REJECTED', errorCode: 'TEST_REJECTED' },
    });
    expect((await detail(a.order)).history.at(-1)).toMatchObject({ type: 'LABELS_REJECTED' });

    const b = await completedOrder();
    await weighUnknown(b.order);
    testCarrierControl.next = ['ACCEPT'];
    expect(((await labels(b.order)).body as OrderShipment).shipment!.status).toBe('LABELED');

    const c = await completedOrder();
    await weighUnknown(c.order);
    testCarrierControl.next = ['LABELS_FAIL_ONCE'];
    expect(((await labels(c.order)).body as OrderShipment).shipment).toMatchObject({
      status: 'REQUESTING',
      request: { status: 'CREATED' },
    });
    expect(((await resolve(c.order)).body as OrderShipment).shipment!.status).toBe('LABELED');
    expect(testCarrierControl.calls).toHaveLength(3);
  });

  it('content is frozen during preparation; ready for pickup and hand-over are explicit; crates DISPATCHED', async () => {
    let before = await ledger();
    const { order, crates } = await completedOrder(async () => {
      before = await ledger();
    });
    // No crate leaves a completed order, and no second shipment can be made.
    expect((await removeCrate(t, order, crates[0]!.crateCode)).body.code).toBe('ORDER_NOT_OPEN');
    const ready = (body: Record<string, unknown>) =>
      http()
        .post(`/api/admin/orders/${order}/shipment/ready`)
        .send({ requestId: randomUUID(), ...body });
    const handOver = () =>
      http()
        .post(`/api/admin/orders/${order}/shipment/hand-over`)
        .send({ requestId: randomUUID(), handedOver: true });
    expect((await ready({ labelsApplied: true })).body.code).toBe('LABELS_NOT_READY');
    await weighUnknown(order);
    await labels(order).expect(200);
    expect((await cancelOrder(t, order)).body.code).toBe('SHIPMENT_AT_CARRIER');
    expect((await ready({ labelsApplied: false })).status).toBe(400);
    expect((await handOver()).body.code).toBe('ORDER_NOT_READY_FOR_PICKUP');
    expect((await ready({ labelsApplied: true })).status).toBe(200);
    expect((await detail(order)).status).toBe('READY_FOR_PICKUP');
    expect((await cancelOrder(t, order)).body.code).toBe('ORDER_NOT_CANCELLABLE');
    // The crates are still only loaded until the real hand-over.
    for (const c of crates) {
      const cycle = await t.prisma.crateCycle.findFirstOrThrow({
        where: { crate: { code: c.crateCode } },
      });
      expect(cycle.status).toBe('ALLOCATED');
    }
    expect((await handOver()).status).toBe(200);
    const final = await detail(order);
    expect(final.status).toBe('HANDED_TO_CARRIER');
    expect(final.history.slice(-2).map((e) => e.type)).toEqual([
      'READY_FOR_PICKUP',
      'HANDED_TO_CARRIER',
    ]);
    for (const c of crates) {
      const cycle = await t.prisma.crateCycle.findFirstOrThrow({
        where: { crate: { code: c.crateCode } },
        include: { events: { orderBy: { occurredAt: 'desc' }, take: 1 } },
      });
      expect(cycle.status).toBe('DISPATCHED');
      expect(cycle.events[0]!.type).toBe('DISPATCHED');
      // Bottles keep their status (FILLED): nothing here is "at the hotel" or "delivered".
      const bottles = await t.prisma.bottle.findMany({ where: { id: { in: c.bottleIds } } });
      expect(bottles.map((b) => b.status)).toEqual(c.bottleIds.map(() => 'FILLED'));
    }
    expect((await handOver()).body.code).toBe('ORDER_NOT_READY_FOR_PICKUP');
    expect((await cancelOrder(t, order)).body.code).toBe('ORDER_NOT_CANCELLABLE');
    // A dispatched crate can be neither loaded into another order nor relabelled/refilled.
    const other = await createOrder(t, hotel, [{ productCode: soap.kit.productCode, crates: 1 }]);
    expect((await scanCrate(t, other.code, crates[0]!.crateUrl)).body.code).toBe(
      'CRATE_DISPATCHED',
    );
    expect(await ledger()).toEqual(before);
  });

  it('cancelling the preparation goes through the carrier; the order and its crates stay', async () => {
    const { order } = await completedOrder();
    await weighUnknown(order);
    await labels(order).expect(200);
    await http()
      .post(`/api/admin/orders/${order}/shipment/ready`)
      .send({ requestId: randomUUID(), labelsApplied: true })
      .expect(200);
    const cancel = () =>
      http()
        .post(`/api/admin/orders/${order}/shipment/cancel`)
        .send({ requestId: randomUUID(), reason: 'Chybný štítek' });
    testCarrierControl.rules = { ...testCarrierControl.rules, canCancel: false };
    expect((await cancel()).body.code).toBe('CARRIER_CANCEL_UNSUPPORTED');
    expect((await view(order)).shipment!.status).toBe('LABELED');
    testCarrierControl.rules = { ...testCarrierControl.rules, canCancel: true };
    const first = (await view(order)).shipment!.code;
    const res = await cancel();
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const v = res.body as OrderShipment;
    expect(v.cancelled.map((c) => c.code)).toEqual([first]);
    expect(v.shipment).toMatchObject({ status: 'DRAFT', parcels: [{}, {}, {}] });
    expect(v.shipment!.code).not.toBe(first);
    expect([...testCarrierControl.created.values()][0]!.cancelled).toBe(true);
    const d = await detail(order);
    expect(d.status).toBe('READY_TO_DISPATCH');
    expect(d.crates).toHaveLength(3);
    expect(await t.prisma.shipment.findFirstOrThrow({ where: { code: first } })).toMatchObject({
      status: 'CANCELLED',
      carrierCancelledAt: expect.any(Date),
    });
  });

  it('an order not completed has no shipment and cannot request labels', async () => {
    const s = await soap.make();
    const order = await createOrder(t, hotel, [{ productCode: soap.kit.productCode, crates: 2 }]);
    await scanCrate(t, order.code, s.crateUrl).expect(200);
    expect((await completeOrder(t, order.code)).body.code).toBe('ORDER_INCOMPLETE');
    expect((await view(order.code)).shipment).toBeNull();
    expect((await labels(order.code)).body.code).toBe('ORDER_NOT_READY_TO_DISPATCH');
    // Cancelling a completed order whose shipment never reached a carrier cancels the draft too.
    const c = await completedOrder();
    expect((await cancelOrder(t, c.order)).status).toBe(200);
    expect((await view(c.order)).shipment).toBeNull();
  });

  it('the database keeps the rules even without the API', async () => {
    const { order } = await completedOrder();
    const s = await t.prisma.shipment.findFirstOrThrow({ where: { order: { code: order } } });
    const sql = (q: Promise<unknown>) =>
      q.then(
        () => 'ok',
        (e: Error) => e.message,
      );
    // A second live shipment of the same order.
    expect(
      await sql(t.prisma
        .$executeRaw`INSERT INTO "shipments" ("serial","code","order_id","site_id","created_at","created_by","operation_request_id")
        SELECT 999999, 'SHP-999999', "order_id", "site_id", now(), "created_by", "operation_request_id" FROM "shipments" WHERE "id" = ${s.id}::uuid`),
    ).toMatch(/shipments_one_live_per_order|duplicate/);
    // A draft never jumps to LABELED, a labelled one is never cancelled locally.
    expect(
      await sql(
        t.prisma
          .$executeRaw`UPDATE "shipments" SET "status" = 'LABELED' WHERE "id" = ${s.id}::uuid`,
      ),
    ).toMatch(/not allowed|AYVO/);
    // Parcels cannot be deleted or re-pointed.
    expect(
      await sql(
        t.prisma.$executeRaw`DELETE FROM "shipment_parcels" WHERE "shipment_id" = ${s.id}::uuid`,
      ),
    ).toMatch(/never deleted/);
    // The order cannot be handed over without its labelled shipment.
    expect(
      await sql(
        t.prisma
          .$executeRaw`UPDATE "orders" SET "status" = 'READY_FOR_PICKUP' WHERE "code" = ${order}`,
      ),
    ).toMatch(/labelled shipment/);
    await weighUnknown(order);
    await labels(order).expect(200);
    expect(
      await sql(
        t.prisma
          .$executeRaw`UPDATE "shipments" SET "status" = 'CANCELLED', "cancelled_at" = now(), "cancelled_by" = "created_by", "cancel_reason" = 'x y z' WHERE "id" = ${s.id}::uuid`,
      ),
    ).toMatch(/only through the carrier/);
    expect(
      await sql(
        t.prisma
          .$executeRaw`UPDATE "shipment_parcels" SET "carrier_parcel_number" = 'X' WHERE "shipment_id" = ${s.id}::uuid`,
      ),
    ).toMatch(/once/);
    // No weighing after the labels exist.
    expect((await weigh(order, 1, '2600')).body.code).toBe('SHIPMENT_NOT_EDITABLE');
    // The historical W1 snapshot was not rewritten by the shipment.
    const snapshots = await t.prisma.crateCycleWeightSnapshot.count({
      where: { cycle: { crate: { code: (await view(order)).shipment!.parcels[0]!.crate } } },
    });
    expect(snapshots).toBe(1);
  });
});

describe.skipIf(!hasDatabase)('dispatch without a configured carrier (DEV today)', () => {
  let t: TestApp;
  beforeAll(async () => {
    t = await createTestApp();
  });
  afterAll(async () => {
    await t?.close();
  });

  it('shows the truth: no carrier, no labels, no pretended numbers', async () => {
    const f = await crateFactory(t);
    const hotel = (await createHotel(t)).code;
    const c = await f.make();
    const order = await createOrder(t, hotel, [{ productCode: f.kit.productCode, crates: 1 }]);
    await scanCrate(t, order.code, c.crateUrl).expect(200);
    await completeOrder(t, order.code).expect(200);
    const http = () => request(t.app.getHttpServer());
    const v = (await http().get(`/api/admin/orders/${order.code}/shipment`).expect(200))
      .body as OrderShipment;
    expect(v.shipment!.carrier).toEqual({
      configured: false,
      code: null,
      name: null,
      parcelWeight: null,
      parcelDimensions: null,
      canCancel: false,
    });
    expect(v.shipment!.parcels).toHaveLength(1);
    const res = await http()
      .post(`/api/admin/orders/${order.code}/shipment/labels`)
      .send({ requestId: randomUUID() });
    expect([res.status, res.body.code]).toEqual([409, 'CARRIER_NOT_CONFIGURED']);
    expect(
      await t.prisma.shipmentCarrierRequest.count({
        where: { shipment: { order: { code: order.code } } },
      }),
    ).toBe(0);
    await http().get(`/api/admin/orders/${order.code}/shipment/labels.pdf`).expect(404);
  });
});
