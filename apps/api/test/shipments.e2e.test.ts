import { randomUUID } from 'node:crypto';
import type { OrderDetail, OrderShipment } from '@ayvo/types';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { testCarrierControl } from '../src/orders/carriers/test-carrier.js';
import { ShipmentCarrierFlow } from '../src/orders/shipment-carrier-flow.service.js';
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
 * APP_ENV=test): one shipment per completed order, one parcel per crate (= its own label, mapped
 * by the carrier's per-parcel answer, never by position), calculated references vs. actual
 * weighings, at most one carrier request sent per attempt (double click, concurrency, answers
 * lost before and after the carrier, a hanging carrier cut off by the time limit), asynchronous
 * acceptance with bounded polling that survives a restart, re-printing without a new shipment,
 * ready for pickup / handed over, cancellation recorded first and confirmed only by the carrier,
 * no stock movement and nothing that means "delivered". Synthetic data only.
 */
const ENV = {
  CARRIER_PROVIDER: 'test',
  // Tests drive polling themselves and look up uncertain requests at once (see the in-flight test).
  CARRIER_POLL_SECONDS: '0',
  CARRIER_SETTLE_SECONDS: '0',
  CARRIER_CALL_TIMEOUT_SECONDS: '1',
};

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
    t = await createTestApp(ENV);
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

  /** 1 crate of soap + 2 crates of gel (the owner's example); `soapOnly` = a one-crate order. */
  async function completedOrder(opts: { onPicked?: () => Promise<void>; soapOnly?: boolean } = {}) {
    const crates = opts.soapOnly
      ? [await soap.make()]
      : [await soap.make(), await gel.make(), await gel.make()];
    const order = await createOrder(
      t,
      hotel,
      opts.soapOnly
        ? [{ productCode: soap.kit.productCode, crates: 1 }]
        : [
            { productCode: soap.kit.productCode, crates: 1 },
            { productCode: gel.kit.productCode, crates: 2 },
          ],
    );
    for (const c of crates) expect((await scanCrate(t, order.code, c.crateUrl)).status).toBe(200);
    await opts.onPicked?.();
    const done = await completeOrder(t, order.code);
    expect(done.status, JSON.stringify(done.body)).toBe(200);
    return { order: order.code, crates };
  }
  const view = async (order: string) =>
    (await http().get(`/api/admin/orders/${order}/shipment`).expect(200)).body as OrderShipment;
  const detail = async (order: string) =>
    (await http().get(`/api/admin/orders/${order}`).expect(200)).body as OrderDetail;
  const labels = (order: string, requestId = randomUUID()) =>
    http().post(`/api/admin/orders/${order}/shipment/labels`).send({ requestId });
  const post = (order: string, path: string, body: object = {}) =>
    http()
      .post(`/api/admin/orders/${order}/shipment/${path}`)
      .send({ requestId: randomUUID(), ...body });
  const resolve = (order: string) => post(order, 'resolve');
  const weigh = (
    order: string,
    parcelNo: number,
    massG: string,
    correction?: { of: string; reason: string },
  ) =>
    post(order, `parcels/${parcelNo}/weighings`, {
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
  async function labelled(opts: { soapOnly?: boolean } = {}) {
    const made = await completedOrder(opts);
    await weighUnknown(made.order);
    const res = await labels(made.order);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect((res.body as OrderShipment).shipment!.status).toBe('LABELED');
    return made;
  }
  const ledger = async () => ({
    movements: await t.prisma.inventoryMovement.count(),
    balances: (await t.prisma.inventoryBalance.findMany({ orderBy: { id: 'asc' } })).map((b) =>
      b.onHand.toString(),
    ),
  });
  const flow = () => t.app.get(ShipmentCarrierFlow);
  /** Makes every scheduled poll due now and runs one background round. */
  async function pollNow() {
    await t.prisma.$executeRaw`UPDATE "shipment_carrier_requests" SET "next_poll_at" = now()
      WHERE "status" IN ('ACCEPTED', 'CREATED') AND "next_poll_at" IS NOT NULL`;
    return flow().pollDue(50);
  }

  it('3 crates → exactly 3 parcels of those crates and their bottles; references vs. unknown', async () => {
    let before = await ledger();
    const { order, crates } = await completedOrder({
      onPicked: async () => {
        before = await ledger();
      },
    });
    const s = (await view(order)).shipment!;
    expect(s.status).toBe('DRAFT');
    expect(s.carrier).toMatchObject({
      configured: true,
      code: 'TEST',
      environment: 'TEST',
      parcelWeight: 'REQUIRED',
    });
    expect(s.parcels.map((p) => p.crate)).toEqual(crates.map((c) => c.crateCode));
    expect(s.parcels.map((p) => p.parcelNo)).toEqual([1, 2, 3]);
    expect(s.parcels[0]).toMatchObject({
      reference: { massG: '2595', source: 'HOTOVO_SNAPSHOT' },
      actual: null,
      dimensions: { lengthMm: 600, widthMm: 400, heightMm: 300 },
      carrierParcelNumber: null,
      label: null,
    });
    expect(s.parcels[1]!.reference).toEqual({ massG: null, source: null });
    expect(s.missing).toEqual([
      { field: 'PARCEL_WEIGHT', parcelNo: 2 },
      { field: 'PARCEL_WEIGHT', parcelNo: 3 },
    ]);
    const rows = await t.prisma.shipmentParcel.findMany({
      where: { shipment: { code: s.code } },
      include: { allocation: { include: { bottles: true } } },
      orderBy: { parcelNo: 'asc' },
    });
    expect(rows.map((r) => r.allocation.bottles.map((b) => b.bottleId).sort())).toEqual(
      crates.map((c) => [...c.bottleIds].sort()),
    );
    expect((await detail(order)).shipment).toEqual({ code: s.code, status: 'DRAFT' });
    expect(await ledger()).toEqual(before);
  });

  it('missing required data refuses the request (nothing sent); weighing makes it complete', async () => {
    const { order } = await completedOrder();
    const refused = await labels(order);
    expect([refused.status, refused.body.code]).toEqual([422, 'SHIPMENT_DATA_MISSING']);
    expect(testCarrierControl.calls).toHaveLength(0);
    await weighUnknown(order);
    const v = await view(order);
    expect(v.shipment!.missing).toEqual([]);
    expect(v.shipment!.parcels[1]).toMatchObject({
      reference: { massG: null },
      actual: { massG: '2410.5' },
    });
    const first = v.shipment!.parcels[1]!.actual!;
    expect((await weigh(order, 2, '2400')).body.code).toBe('WEIGHING_EXISTS');
    expect((await weigh(order, 2, '2400', { of: first.id, reason: 'Převážení' })).status).toBe(200);
    expect((await view(order)).shipment!.parcels[1]!.actual!.massG).toBe('2400');
  });

  it('one crate → one parcel, one label; three crates → three own labels mapped per parcel', async () => {
    const one = await labelled({ soapOnly: true });
    const s1 = (await view(one.order)).shipment!;
    expect(s1.parcels).toHaveLength(1);
    expect(s1.parcels[0]!.label).toEqual({ format: 'PDF', dpi: 203 });

    const three = await labelled();
    const s = (await view(three.order)).shipment!;
    // The test carrier answers the parcels in REVERSE order: numbers follow each parcel.
    expect(s.parcels.map((p) => p.carrierParcelNumber!.slice(-2))).toEqual(['01', '02', '03']);
    expect(s.label).toMatchObject({ format: 'PDF' });
    const sent = testCarrierControl.calls.at(-1)!;
    expect(sent.parcels.map((p) => [p.crate, p.weightG])).toEqual([
      [three.crates[0]!.crateCode, '2595'],
      [three.crates[1]!.crateCode, '2410.5'],
      [three.crates[2]!.crateCode, '2410.5'],
    ]);
    expect(sent.recipient).toMatchObject({ name: 'Hotel Expedice', postalCode: '750 02' });
    expect(sent.settings).toMatchObject({ label: { format: 'PDF', dpi: 203 } });
    // Each parcel's own label shows its crate; the complete document has all three.
    for (const [i, c] of three.crates.entries()) {
      const pdf = await http()
        .get(`/api/admin/orders/${three.order}/shipment/parcels/${i + 1}/label`)
        .buffer(true)
        .parse((res, cb) => {
          const chunks: Buffer[] = [];
          res.on('data', (d: Buffer) => chunks.push(d));
          res.on('end', () => cb(null, Buffer.concat(chunks)));
        })
        .expect(200);
      expect((pdf.body as Buffer).subarray(0, 5).toString()).toBe('%PDF-');
      expect(pdf.headers['content-type']).toContain('application/pdf');
      expect(c.crateCode).toMatch(/^AYV-C-/);
    }
    const calls = testCarrierControl.calls.length;
    await http().get(`/api/admin/orders/${three.order}/shipment/labels`).expect(200);
    await http().get(`/api/admin/orders/${three.order}/shipment/labels`).expect(200);
    expect(testCarrierControl.calls).toHaveLength(calls);
    expect((await labels(three.order)).body.code).toBe('LABELS_EXIST');
    expect(testCarrierControl.calls).toHaveLength(calls);
    expect((await detail(three.order)).status).toBe('READY_TO_DISPATCH');
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

  it('answer lost BEFORE the carrier: uncertain, never re-sent; only the carrier’s answer settles it', async () => {
    const { order } = await completedOrder();
    await weighUnknown(order);
    testCarrierControl.next = ['LOSE_BEFORE'];
    let s = ((await labels(order)).body as OrderShipment).shipment!;
    expect(s.status).toBe('REQUESTING');
    expect(s.request).toMatchObject({ status: 'SENT', errorCode: 'NO_ANSWER' });
    await labels(order);
    expect(testCarrierControl.calls).toHaveLength(1);
    expect((await cancelOrder(t, order)).body.code).toBe('SHIPMENT_AT_CARRIER');
    s = ((await resolve(order)).body as OrderShipment).shipment!;
    expect(s).toMatchObject({ status: 'DRAFT', request: { status: 'NOT_CREATED' } });
    const again = ((await labels(order)).body as OrderShipment).shipment!;
    expect(again).toMatchObject({ status: 'LABELED', request: { attemptNo: 2 } });
    expect(testCarrierControl.calls.map((c) => c.clientReference)).toEqual([
      `${s.code}-1`,
      `${s.code}-2`,
    ]);
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

  it('a hanging carrier is cut off by the time limit: unknown, not failed, not re-sent', async () => {
    const { order } = await completedOrder({ soapOnly: true });
    testCarrierControl.next = ['HANG'];
    const started = Date.now();
    const s = ((await labels(order)).body as OrderShipment).shipment!;
    expect(Date.now() - started).toBeLessThan(5000);
    expect(s).toMatchObject({
      status: 'REQUESTING',
      request: { status: 'SENT', errorCode: 'NO_ANSWER' },
    });
    expect(testCarrierControl.calls).toHaveLength(1);
  });

  it('asynchronous acceptance: bounded polling continues after a restart; a failed batch is refused', async () => {
    const a = await completedOrder({ soapOnly: true });
    testCarrierControl.next = ['ACCEPT'];
    testCarrierControl.pendingPolls = 3;
    const s = ((await labels(a.order)).body as OrderShipment).shipment!;
    expect(s).toMatchObject({ status: 'REQUESTING', request: { status: 'ACCEPTED' } });
    const req = await t.prisma.shipmentCarrierRequest.findFirstOrThrow({
      where: { shipment: { order: { code: a.order } } },
    });
    expect(req.carrierRef).toBe(`BATCH-${s.request!.clientReference}`);
    expect(req.nextPollAt).not.toBeNull();
    // "Restart": a second app instance continues from the stored state alone.
    const restarted = await createTestApp(ENV);
    try {
      for (let i = 0; i < 4; i++) {
        await t.prisma.$executeRaw`UPDATE "shipment_carrier_requests" SET "next_poll_at" = now()
          WHERE "id" = ${req.id}::uuid AND "next_poll_at" IS NOT NULL`;
        await restarted.app.get(ShipmentCarrierFlow).pollDue(50);
      }
    } finally {
      await restarted.close();
    }
    expect((await view(a.order)).shipment!.status).toBe('LABELED');
    expect(testCarrierControl.calls).toHaveLength(1);

    const b = await completedOrder({ soapOnly: true });
    testCarrierControl.next = ['ACCEPT_THEN_FAIL'];
    testCarrierControl.pendingPolls = 1;
    await labels(b.order);
    await pollNow();
    const refused = (await view(b.order)).shipment!;
    expect(refused).toMatchObject({ status: 'DRAFT', request: { status: 'REJECTED' } });

    // Polling stops after its limit: then a person checks ("Ověřit").
    const c = await completedOrder({ soapOnly: true });
    testCarrierControl.next = ['ACCEPT'];
    testCarrierControl.pendingPolls = 1000;
    await labels(c.order);
    for (let i = 0; i < 31; i++) await pollNow();
    expect((await view(c.order)).shipment!.pollingStopped).toBe(true);
  });

  it('labels downloaded later; a carrier answer that does not prove each parcel is not accepted', async () => {
    const c = await completedOrder({ soapOnly: true });
    testCarrierControl.next = ['LABELS_FAIL_ONCE'];
    expect(((await labels(c.order)).body as OrderShipment).shipment).toMatchObject({
      status: 'REQUESTING',
      request: { status: 'CREATED', errorCode: 'LABELS_NOT_DOWNLOADED' },
    });
    await pollNow();
    expect((await view(c.order)).shipment!.status).toBe('LABELED');
    expect(testCarrierControl.calls).toHaveLength(1);
    // Files are stored only after the checks: nothing orphaned by the failed download.
    expect(
      await t.prisma.shipmentLabel.count({ where: { shipment: { order: { code: c.order } } } }),
    ).toBe(2);
  });

  it('in-flight window in database time: no lookup and no manual closing before it', async () => {
    const strict = await createTestApp({ ...ENV, CARRIER_SETTLE_SECONDS: '120' });
    try {
      const { order } = await completedOrder({ soapOnly: true });
      testCarrierControl.next = ['LOSE_BEFORE'];
      await labels(order);
      const h = () => request(strict.app.getHttpServer());
      const r = await h()
        .post(`/api/admin/orders/${order}/shipment/resolve`)
        .send({ requestId: randomUUID() });
      expect(r.body.code).toBe('REQUEST_IN_FLIGHT');
      expect(r.body.details.resolvableAt).toEqual(expect.any(String));
      const a = await h()
        .post(`/api/admin/orders/${order}/shipment/abandon`)
        .send({ requestId: randomUUID(), reason: 'Ověřeno u PPL, nic nevzniklo' });
      expect(a.body.code).toBe('REQUEST_IN_FLIGHT');
      expect(testCarrierControl.polls).toBe(0);
    } finally {
      await strict.close();
    }
  });

  it('exceptional manual closing of an uncertain request is audited; never for a created one', async () => {
    const { order } = await completedOrder({ soapOnly: true });
    testCarrierControl.next = ['LOSE_BEFORE'];
    await labels(order);
    const closed = await post(order, 'abandon', { reason: 'Ověřeno v portálu PPL: nic nevzniklo' });
    expect(closed.status, JSON.stringify(closed.body)).toBe(200);
    expect((closed.body as OrderShipment).shipment).toMatchObject({
      status: 'DRAFT',
      request: { status: 'NOT_CREATED', errorCode: 'CLOSED_BY_PERSON' },
    });
    const last = (await detail(order)).history.at(-1)!;
    expect(last).toMatchObject({
      type: 'LABELS_NOT_CREATED',
      reason: 'Ověřeno v portálu PPL: nic nevzniklo',
    });
    expect(testCarrierControl.calls).toHaveLength(1);

    const created = await completedOrder({ soapOnly: true });
    testCarrierControl.next = ['LABELS_FAIL_ONCE'];
    await labels(created.order);
    expect((await post(created.order, 'abandon', { reason: 'pokus o uzavření' })).body.code).toBe(
      'REQUEST_NOT_ABANDONABLE',
    );
  });

  it('cancellation is recorded first, blocks hand-over, and only the carrier’s answer cancels', async () => {
    const { order, crates } = await labelled();
    await post(order, 'ready', { labelsApplied: true }).expect(200);
    // Asynchronous carrier: accepted → CANCELLING; the order is no longer ready for pickup.
    testCarrierControl.cancel = ['PENDING'];
    testCarrierControl.cancelStatus = ['PENDING'];
    let s = ((await post(order, 'cancel', { reason: 'Chybný štítek' })).body as OrderShipment)
      .shipment!;
    expect(s).toMatchObject({ status: 'CANCELLING', cancelRequest: { reason: 'Chybný štítek' } });
    expect((await detail(order)).status).toBe('READY_TO_DISPATCH');
    expect((await post(order, 'hand-over', { handedOver: true })).body.code).toBe(
      'ORDER_NOT_READY_FOR_PICKUP',
    );
    expect((await post(order, 'ready', { labelsApplied: true })).body.code).toBe(
      'LABELS_NOT_READY',
    );
    expect((await cancelOrder(t, order)).body.code).toBe('SHIPMENT_AT_CARRIER');
    s = ((await post(order, 'cancel/resolve')).body as OrderShipment).shipment!;
    expect(s.status).toBe('CANCELLING');
    // Confirmed: cancelled with the carrier, a fresh draft of the same crates.
    s = ((await post(order, 'cancel/resolve')).body as OrderShipment).shipment!;
    expect(s.status).toBe('DRAFT');
    const v = await view(order);
    expect(v.cancelled).toHaveLength(1);
    const d = await detail(order);
    expect(d.status).toBe('READY_TO_DISPATCH');
    expect(d.crates.map((c) => c.crate)).toEqual(crates.map((c) => c.crateCode));
  });

  it('a refused or lost cancellation never cancels locally', async () => {
    const a = await labelled({ soapOnly: true });
    testCarrierControl.cancel = ['REFUSE'];
    const refused = ((await post(a.order, 'cancel', { reason: 'Omyl' })).body as OrderShipment)
      .shipment!;
    expect(refused.status).toBe('LABELED');
    expect((await detail(a.order)).history.at(-1)).toMatchObject({
      type: 'SHIPMENT_CANCEL_REFUSED',
    });

    const b = await labelled({ soapOnly: true });
    testCarrierControl.cancel = ['LOSE'];
    expect(
      ((await post(b.order, 'cancel', { reason: 'Omyl' })).body as OrderShipment).shipment!.status,
    ).toBe('CANCELLING');
    // The check finds it cancelled (the lost answer was a success).
    expect(((await post(b.order, 'cancel/resolve')).body as OrderShipment).shipment!.status).toBe(
      'DRAFT',
    );

    testCarrierControl.rules = { ...testCarrierControl.rules, canCancel: false };
    const c = await labelled({ soapOnly: true });
    expect((await post(c.order, 'cancel', { reason: 'Omyl' })).body.code).toBe(
      'CARRIER_CANCEL_UNSUPPORTED',
    );
  });

  it('concurrent cancel and hand-over: exactly one wins, never both', async () => {
    const { order } = await labelled({ soapOnly: true });
    await post(order, 'ready', { labelsApplied: true }).expect(200);
    const [c, h] = await Promise.all([
      post(order, 'cancel', { reason: 'Souběh' }),
      post(order, 'hand-over', { handedOver: true }),
    ]);
    const final = await detail(order);
    if (final.status === 'HANDED_TO_CARRIER') {
      expect(h.status).toBe(200);
      expect(c.body.code).toBe('SHIPMENT_NOT_CANCELLABLE');
      expect(testCarrierControl.cancelCalls).toBe(0);
    } else {
      expect(c.status).toBe(200);
      expect(h.body.code).toBe('ORDER_NOT_READY_FOR_PICKUP');
    }
  });

  it('content frozen; ready and hand-over explicit; crates DISPATCHED; no stock moved', async () => {
    let before = await ledger();
    const { order, crates } = await completedOrder({
      onPicked: async () => {
        before = await ledger();
      },
    });
    expect((await removeCrate(t, order, crates[0]!.crateCode)).body.code).toBe('ORDER_NOT_OPEN');
    expect((await post(order, 'ready', { labelsApplied: true })).body.code).toBe(
      'LABELS_NOT_READY',
    );
    await weighUnknown(order);
    await labels(order).expect(200);
    expect((await cancelOrder(t, order)).body.code).toBe('SHIPMENT_AT_CARRIER');
    expect((await post(order, 'ready', { labelsApplied: false })).status).toBe(400);
    expect((await post(order, 'ready', { labelsApplied: true })).status).toBe(200);
    expect((await cancelOrder(t, order)).body.code).toBe('ORDER_NOT_CANCELLABLE');
    expect((await post(order, 'hand-over', { handedOver: true })).status).toBe(200);
    const final = await detail(order);
    expect(final.status).toBe('HANDED_TO_CARRIER');
    for (const c of crates) {
      const cycle = await t.prisma.crateCycle.findFirstOrThrow({
        where: { crate: { code: c.crateCode } },
        include: { events: { orderBy: { occurredAt: 'desc' }, take: 1 } },
      });
      expect(cycle.status).toBe('DISPATCHED');
      expect(cycle.events[0]!.type).toBe('DISPATCHED');
      const bottles = await t.prisma.bottle.findMany({ where: { id: { in: c.bottleIds } } });
      expect(bottles.map((b) => b.status)).toEqual(c.bottleIds.map(() => 'FILLED'));
    }
    const other = await createOrder(t, hotel, [{ productCode: soap.kit.productCode, crates: 1 }]);
    expect((await scanCrate(t, other.code, crates[0]!.crateUrl)).body.code).toBe(
      'CRATE_DISPATCHED',
    );
    expect(await ledger()).toEqual(before);
  });

  it('an order not completed has no shipment; a draft is cancelled with the order', async () => {
    const s = await soap.make();
    const order = await createOrder(t, hotel, [{ productCode: soap.kit.productCode, crates: 2 }]);
    await scanCrate(t, order.code, s.crateUrl).expect(200);
    expect((await completeOrder(t, order.code)).body.code).toBe('ORDER_INCOMPLETE');
    expect((await view(order.code)).shipment).toBeNull();
    expect((await labels(order.code)).body.code).toBe('ORDER_NOT_READY_TO_DISPATCH');
    const c = await completedOrder({ soapOnly: true });
    expect((await cancelOrder(t, c.order)).status).toBe(200);
    expect((await view(c.order)).shipment).toBeNull();
  });

  it('the database keeps the rules even without the API', async () => {
    const { order } = await completedOrder({ soapOnly: true });
    const s = await t.prisma.shipment.findFirstOrThrow({ where: { order: { code: order } } });
    const sql = (q: Promise<unknown>) =>
      q.then(
        () => 'ok',
        (e: Error) => e.message,
      );
    expect(
      await sql(t.prisma
        .$executeRaw`INSERT INTO "shipments" ("serial","code","order_id","site_id","created_at","created_by","operation_request_id")
        SELECT 999999, 'SHP-999999', "order_id", "site_id", now(), "created_by", "operation_request_id" FROM "shipments" WHERE "id" = ${s.id}::uuid`),
    ).toMatch(/shipments_one_live_per_order|duplicate/);
    expect(
      await sql(
        t.prisma
          .$executeRaw`UPDATE "shipments" SET "status" = 'LABELED' WHERE "id" = ${s.id}::uuid`,
      ),
    ).toMatch(/not allowed|AYVO/);
    expect(
      await sql(
        t.prisma.$executeRaw`DELETE FROM "shipment_parcels" WHERE "shipment_id" = ${s.id}::uuid`,
      ),
    ).toMatch(/never deleted/);
    expect(
      await sql(
        t.prisma
          .$executeRaw`UPDATE "orders" SET "status" = 'READY_FOR_PICKUP' WHERE "code" = ${order}`,
      ),
    ).toMatch(/labelled shipment/);
    await labels(order).expect(200);
    // A labelled shipment is never cancelled locally, not even through CANCELLING.
    expect(
      await sql(
        t.prisma
          .$executeRaw`UPDATE "shipments" SET "status" = 'CANCELLED', "cancelled_at" = now(), "cancelled_by" = "created_by", "cancel_reason" = 'x y z' WHERE "id" = ${s.id}::uuid`,
      ),
    ).toMatch(/not allowed/);
    expect(
      await sql(
        t.prisma
          .$executeRaw`UPDATE "shipment_parcels" SET "carrier_parcel_number" = 'X' WHERE "shipment_id" = ${s.id}::uuid`,
      ),
    ).toMatch(/once/);
    expect((await weigh(order, 1, '2600')).body.code).toBe('SHIPMENT_NOT_EDITABLE');
    // Ready for pickup is withdrawn only together with a started cancellation.
    await post(order, 'ready', { labelsApplied: true }).expect(200);
    expect(
      await sql(
        t.prisma
          .$executeRaw`UPDATE "orders" SET "status" = 'READY_TO_DISPATCH' WHERE "code" = ${order}`,
      ),
    ).toMatch(/withdrawn only by cancelling/);
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
    expect(v.carrier).toMatchObject({ configured: false, unavailable: 'NOT_CONFIGURED' });
    expect(v.shipment!.carrier).toMatchObject({ configured: false, code: null });
    const res = await http()
      .post(`/api/admin/orders/${order.code}/shipment/labels`)
      .send({ requestId: randomUUID() });
    expect([res.status, res.body.code, res.body.details]).toEqual([
      409,
      'CARRIER_NOT_CONFIGURED',
      { reason: 'NOT_CONFIGURED' },
    ]);
    expect(
      await t.prisma.shipmentCarrierRequest.count({
        where: { shipment: { order: { code: order.code } } },
      }),
    ).toBe(0);
    await http().get(`/api/admin/orders/${order.code}/shipment/labels`).expect(404);
  });
});
