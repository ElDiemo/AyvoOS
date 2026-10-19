import { randomBytes, randomUUID } from 'node:crypto';
import type {
  CarrierConnectionAdmin,
  OrderShipment,
  PplSettings,
  VerifyCarrierResult,
} from '@ayvo/types';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { CarrierRegistryService } from '../src/carriers/carrier-registry.service.js';
import { ShipmentCarrierFlow } from '../src/orders/shipment-carrier-flow.service.js';
import { FakePpl } from './support/fake-ppl.js';
import {
  completeOrder,
  crateFactory,
  createHotel,
  createOrder,
  scanCrate,
} from './support/order-fixtures.js';
import { INITIAL_SITE_ID } from './support/sign-in.js';
import { createTestApp, hasDatabase, type TestApp } from './support/test-app.js';

/**
 * PPL CPL adapter and the site's PPL settings (doc 029 §5, §9) against a SIMULATED PPL server — no
 * real PPL access is needed or contacted. Covers: settings saved incomplete and explained,
 * "Ověřit připojení" (token + product list, nothing created), one and three crates (a shipment
 * set mapped per parcel by its own CUST reference, never by position), unproven mapping, a partly
 * created set cancelled at PPL, a lost Location, PPL unavailable, validation refusal, asynchronous
 * processing with the poller, labels only from the API origin (no redirects, size-limited), ZPL at
 * 203 dpi, settings changed during a shipment (snapshot), token reuse, no secret in any answer or
 * audit, and sites kept apart. Synthetic data only.
 */
const KEY = randomBytes(32).toString('base64');

describe.skipIf(!hasDatabase)('PPL adapter and site settings (simulated PPL)', () => {
  const ppl = new FakePpl('ayvo-test-client', 'ayvo-test-secret-value');
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
        label: { format: 'PDF', dpi: 203, layout: 'SINGLE' },
        ...over,
      });
  /** Complete, verified settings (each test stands on its own). */
  async function ready(over: Record<string, unknown> = {}) {
    await save({ productCode: null }).expect(200);
    expect(((await verify().expect(200)).body as VerifyCarrierResult).ok).toBe(true);
    await save(over).expect(200);
  }
  const verify = () => http().post(`${settingsUrl}/verify`).send({ requestId: randomUUID() });
  const post = (order: string, path: string, body: object = {}) =>
    http()
      .post(`/api/admin/orders/${order}/shipment/${path}`)
      .send({ requestId: randomUUID(), ...body });
  const view = async (order: string) =>
    (await http().get(`/api/admin/orders/${order}/shipment`).expect(200)).body as OrderShipment;
  async function completed(crates = 1) {
    const made = [];
    // One order line never mixes label designs: a multi-crate order starts a fresh series.
    if (crates > 1) await factory.refill();
    for (let i = 0; i < crates; i++) made.push(await factory.make());
    const order = await createOrder(t, hotel, [{ productCode: factory.kit.productCode, crates }]);
    for (const c of made) {
      const r = await scanCrate(t, order.code, c.crateUrl);
      expect(r.status, JSON.stringify(r.body)).toBe(200);
    }
    expect((await completeOrder(t, order.code)).status).toBe(200);
    return { order: order.code, crates: made };
  }
  const flow = () => t.app.get(ShipmentCarrierFlow);
  async function pollNow() {
    await t.prisma.$executeRaw`UPDATE "shipment_carrier_requests" SET "next_poll_at" = now()
      WHERE "status" IN ('ACCEPTED', 'CREATED') AND "next_poll_at" IS NOT NULL`;
    await flow().pollDue(50);
  }
  const lastBatch = () => [...ppl.batches.values()].at(-1)!;

  beforeAll(async () => {
    await ppl.start();
    t = await createTestApp({
      PPL_TEST_CLIENT_ID: ppl.clientId,
      PPL_TEST_CLIENT_SECRET: ppl.clientSecret,
      PPL_TEST_API_BASE_URL_FOR_TESTS: ppl.base,
      CARRIER_POLL_SECONDS: '0',
      CARRIER_SETTLE_SECONDS: '0',
      CARRIER_CALL_TIMEOUT_SECONDS: '5',
      CARRIER_CREDENTIALS_KEY: KEY,
    });
    factory = await crateFactory(t, { capacity: 2 });
    hotel = (await createHotel(t, { name: 'Hotel Bečva', city: 'Přerov' })).code;
  });
  afterAll(async () => {
    await t?.close();
    await ppl.stop();
  });
  beforeEach(() => ppl.reset());

  it('settings: saved incomplete and explained; verified (nothing created); then complete', async () => {
    let v = (await http().get(settingsUrl).expect(200)).body as PplSettings;
    expect(v).toMatchObject({ saved: false, enabled: false, label: { format: 'PDF', dpi: 203 } });
    expect(v.connections).toEqual([
      { code: 'PPL_TEST', environment: 'TEST', credentials: 'SET', source: 'SERVER' },
    ]);
    // A product is chosen only from the verified list; an unknown connection is refused.
    expect((await save()).body.code).toBe('PRODUCT_NOT_VERIFIED');
    expect((await save({ connection: 'PPL_PRODUCTION', productCode: null })).body.code).toBe(
      'UNKNOWN_CONNECTION',
    );
    v = (await save({ productCode: null, enabled: false }).expect(200)).body as PplSettings;
    expect(v.problems).toEqual(expect.arrayContaining(['NOT_VERIFIED', 'NO_PRODUCT', 'DISABLED']));
    const tokens = ppl.tokens;
    const r = (await verify().expect(200)).body as VerifyCarrierResult;
    expect(r.ok).toBe(true);
    expect(r.settings.verified!.products.map((p) => p.code)).toEqual(['SIM-A', 'SIM-B']);
    // Verification reads only: no batch, no pickup order.
    expect(
      ppl.seen.filter((s) => s.method === 'POST' && s.path !== '/login/getAccessToken'),
    ).toEqual([]);
    v = (await save().expect(200)).body as PplSettings;
    expect(v.problems).toEqual([]);
    expect(ppl.tokens - tokens).toBeLessThanOrEqual(1);
    // No secret anywhere: settings, audit.
    const audits = await t.prisma.auditEvent.findMany({
      where: { siteId: INITIAL_SITE_ID, type: { startsWith: 'CARRIER_' } },
    });
    expect(audits.map((a) => a.type)).toEqual(
      expect.arrayContaining(['CARRIER_SETTINGS_UPDATED', 'CARRIER_CONNECTION_VERIFIED']),
    );
    const everything = JSON.stringify([v, r, audits]);
    expect(everything).not.toContain(ppl.clientSecret);
    expect(everything).not.toContain(ppl.validToken);
    expect(everything).not.toContain(ppl.base);
  });

  it('one crate: one PPL shipment, its own label; what is sent follows the documented model', async () => {
    await ready();
    const { order } = await completed(1);
    const s = ((await post(order, 'labels').expect(200)).body as OrderShipment).shipment!;
    expect(s).toMatchObject({
      status: 'LABELED',
      carrier: { code: 'PPL', environment: 'TEST' },
      parcels: [{ parcelNo: 1, label: { format: 'PDF' } }],
    });
    const sent = lastBatch().body.shipments[0]!;
    expect(sent).toMatchObject({
      referenceId: s.request!.clientReference,
      productType: 'SIM-A',
      sender: {
        name: 'AYVO Prerov (test)',
        street: 'Prumyslova 1',
        zipCode: '75002',
        country: 'CZ',
      },
      recipient: { name: 'Hotel Becva', city: 'Prerov', country: 'CZ' },
      externalNumbers: [{ code: 'CUST', externalNumber: s.request!.clientReference }],
    });
    expect(sent.shipmentSet).toBeUndefined();
    // The printer resolution is sent only for ZPL.
    expect(lastBatch().body.labelSettings).toEqual({ format: 'Pdf' });
    // No weight is sent while PPL does not document its unit; no depot, no pickup order.
    expect(JSON.stringify(lastBatch().body)).not.toMatch(/weight|depot|order\/batch/i);
    expect(s.parcels[0]!.carrierParcelNumber).toBe(lastBatch().numbers[0]!.number);
  });

  it('three crates: a set, each number mapped to its crate by its own CUST — never by position', async () => {
    await ready();
    const { order, crates } = await completed(3);
    const s = ((await post(order, 'labels').expect(200)).body as OrderShipment).shipment!;
    expect(s.status).toBe('LABELED');
    const b = lastBatch();
    expect(b.body.shipments[0]!.shipmentSet).toMatchObject({ numberOfShipments: 3 });
    for (const [i, p] of s.parcels.entries()) {
      expect(p.crate).toBe(crates[i]!.crateCode);
      const expected = b.numbers.find(
        (n) => n.ref === `${s.request!.clientReference}-${p.parcelNo}`,
      )!;
      expect(p.carrierParcelNumber).toBe(expected.number);
      expect(p.label).toEqual({ format: 'PDF', dpi: null });
    }
    // Every label download carried the token only to the PPL API itself.
    expect(ppl.seen.filter((x) => x.path.startsWith('/data/')).every((x) => x.bearer)).toBe(true);
  });

  it('an unproven mapping keeps the labels out; a later lookup with proof completes it', async () => {
    await ready();
    const { order } = await completed(3);
    ppl.mode.hideExternals = true;
    let s = ((await post(order, 'labels').expect(200)).body as OrderShipment).shipment!;
    expect(s).toMatchObject({
      status: 'REQUESTING',
      request: { status: 'CREATED', errorCode: 'CARRIER_PARCEL_MISMATCH' },
    });
    expect(s.parcels.every((p) => p.label === null && p.carrierParcelNumber === null)).toBe(true);
    ppl.mode.hideExternals = false;
    s = ((await post(order, 'resolve').expect(200)).body as OrderShipment).shipment!;
    expect(s.status).toBe('LABELED');
    expect(ppl.batches.size).toBeGreaterThan(0);
  });

  it('a partly created set stays open and is cancelled at PPL (202, confirmed as Canceled)', async () => {
    await ready();
    const { order } = await completed(3);
    ppl.mode.partial = true;
    const s = ((await post(order, 'labels').expect(200)).body as OrderShipment).shipment!;
    expect(s.request).toMatchObject({ status: 'CREATED', errorCode: 'CARRIER_PARTIAL' });
    const created = lastBatch()
      .numbers.slice(0, 2)
      .map((n) => n.number);
    let c = (
      (await post(order, 'cancel', { reason: 'Neúplná sada' }).expect(200)).body as OrderShipment
    ).shipment!;
    expect(c.status).toBe('CANCELLING');
    for (const n of created) expect(ppl.cancelled.has(n)).toBe(true);
    c = ((await post(order, 'cancel/resolve').expect(200)).body as OrderShipment).shipment!;
    expect(c.status).toBe('DRAFT');
  });

  it('a lost Location or PPL unavailable: uncertain, never re-sent, never "not created" by itself', async () => {
    await ready();
    const a = await completed(1);
    ppl.mode.noLocation = true;
    let s = ((await post(a.order, 'labels').expect(200)).body as OrderShipment).shipment!;
    expect(s.request).toMatchObject({ status: 'SENT', errorCode: 'NO_ANSWER' });
    s = ((await post(a.order, 'resolve').expect(200)).body as OrderShipment).shipment!;
    // PPL documents no lookup without the batch id: it stays uncertain for a person.
    expect(s).toMatchObject({ status: 'REQUESTING', request: { status: 'SENT' } });
    expect(s.request!.errorMessage).toContain('batch id is unknown');
    const batches = ppl.batches.size;
    await post(a.order, 'labels').expect(200);
    expect(ppl.batches.size).toBe(batches);

    const b = await completed(1);
    ppl.mode.noLocation = false;
    ppl.mode.batchError = true;
    s = ((await post(b.order, 'labels').expect(200)).body as OrderShipment).shipment!;
    expect(s.request).toMatchObject({ status: 'SENT', errorCode: 'NO_ANSWER' });
  });

  it('a validation refusal returns the draft with PPL’s reason', async () => {
    await ready();
    const { order } = await completed(1);
    ppl.mode.reject = true;
    const s = ((await post(order, 'labels').expect(200)).body as OrderShipment).shipment!;
    expect(s).toMatchObject({
      status: 'DRAFT',
      request: { status: 'REJECTED', errorCode: 'PPL_400' },
    });
    expect(s.request!.errorMessage).toContain('ProductType');
  });

  it('asynchronous processing is followed by the poller; settings changed meanwhile do not apply', async () => {
    await ready();
    const { order } = await completed(1);
    ppl.mode.processingPolls = 2;
    let s = ((await post(order, 'labels').expect(200)).body as OrderShipment).shipment!;
    expect(s).toMatchObject({ status: 'REQUESTING', request: { status: 'ACCEPTED' } });
    // The site switches to ZPL meanwhile: this shipment keeps what it was created with.
    await save({ label: { format: 'ZPL', dpi: 203, layout: 'SINGLE' } }).expect(200);
    await pollNow();
    await pollNow();
    s = await view(order).then((v) => v.shipment!);
    expect(s.status).toBe('LABELED');
    expect(s.parcels[0]!.label).toEqual({ format: 'PDF', dpi: null });
    const req = await t.prisma.shipmentCarrierRequest.findFirstOrThrow({
      where: { shipment: { order: { code: order } } },
    });
    expect((req.payload as { settings: { label: { format: string } } }).settings.label.format).toBe(
      'PDF',
    );
  });

  it('ZPL at 203 dpi for the Zebra ZD220: requested and stored as ZPL', async () => {
    await ready({ label: { format: 'ZPL', dpi: 203, layout: 'SINGLE' } });
    const { order } = await completed(1);
    const s = ((await post(order, 'labels').expect(200)).body as OrderShipment).shipment!;
    expect(lastBatch().body.labelSettings).toEqual({ format: 'Zpl', dpi: 203 });
    expect(s.parcels[0]!.label).toEqual({ format: 'ZPL', dpi: 203 });
    const file = await http()
      .get(`/api/admin/orders/${order}/shipment/parcels/1/label`)
      .expect(200);
    expect(file.headers['content-type']).toContain('application/zpl');
  });

  it('labels only from the PPL API origin: a foreign host, a redirect or an oversized file is refused', async () => {
    await ready();
    for (const fault of ['labelForeignHost', 'labelRedirect', 'labelHuge'] as const) {
      ppl.reset();
      ppl.mode[fault] = true;
      const { order } = await completed(1);
      const s = ((await post(order, 'labels').expect(200)).body as OrderShipment).shipment!;
      // A broken contract goes to a person: not retried automatically.
      expect(s, fault).toMatchObject({
        status: 'REQUESTING',
        request: { status: 'CREATED', errorCode: 'LABELS_INVALID' },
      });
      expect(s.parcels[0]!.label).toBeNull();
      const req = await t.prisma.shipmentCarrierRequest.findFirstOrThrow({
        where: { shipment: { order: { code: order } } },
      });
      expect(req.nextPollAt, fault).toBeNull();
    }
    // Never a token to another host.
    expect(ppl.seen.some((x) => x.host.includes('evil'))).toBe(false);
  });

  it('a label URL relative to the API host is accepted (same origin, /data/ only)', async () => {
    await ready();
    ppl.mode.labelRelative = true;
    const { order } = await completed(1);
    const s = ((await post(order, 'labels').expect(200)).body as OrderShipment).shipment!;
    expect(s.status).toBe('LABELED');
  });

  it('the token cannot be had: nothing was sent — refused, back to the draft, not uncertain', async () => {
    await ready();
    const { order } = await completed(1);
    const batches = ppl.batches.size;
    ppl.mode.tokenDown = true;
    // A fresh client (no cached token), as after a restart.
    (
      t.app.get(CarrierRegistryService) as unknown as { gateways: Map<string, unknown> }
    ).gateways.clear();
    const s = ((await post(order, 'labels').expect(200)).body as OrderShipment).shipment!;
    expect(s).toMatchObject({
      status: 'DRAFT',
      request: { status: 'REJECTED', errorCode: 'PPL_UNAVAILABLE' },
    });
    expect(ppl.batches.size).toBe(batches);
  });

  it('a number left over or claiming an already claimed parcel: never accepted', async () => {
    await ready();
    const { order } = await completed(3);
    ppl.mode.extraNumber = true;
    const s = ((await post(order, 'labels').expect(200)).body as OrderShipment).shipment!;
    expect(s).toMatchObject({
      status: 'REQUESTING',
      request: { status: 'CREATED', errorCode: 'CARRIER_PARCEL_MISMATCH' },
    });
    expect(s.parcels.every((p) => p.label === null)).toBe(true);
  });

  it('a lost cancel answer: asked again on "Ověřit zrušení" — never stuck, never doubled', async () => {
    await ready();
    const { order } = await completed(3);
    await post(order, 'labels').expect(200);
    const numbers = lastBatch().numbers.map((n) => n.number);
    ppl.mode.cancelFailures = 1;
    let c = ((await post(order, 'cancel', { reason: 'Omyl' }).expect(200)).body as OrderShipment)
      .shipment!;
    expect(c.status).toBe('CANCELLING');
    expect(numbers.some((n) => ppl.cancelled.has(n))).toBe(false);
    c = ((await post(order, 'cancel/resolve').expect(200)).body as OrderShipment).shipment!;
    expect(c.status).toBe('CANCELLING');
    expect(numbers.every((n) => ppl.cancelled.has(n))).toBe(true);
    const asked = ppl.seen.filter((x) => x.path.endsWith('/cancel')).length;
    c = ((await post(order, 'cancel/resolve').expect(200)).body as OrderShipment).shipment!;
    expect(c.status).toBe('DRAFT');
    expect(ppl.seen.filter((x) => x.path.endsWith('/cancel')).length).toBe(asked);
  });

  it('a set PPL cancels only partly is never returned as if nothing was cancelled', async () => {
    await ready();
    const { order } = await completed(3);
    await post(order, 'labels').expect(200);
    const numbers = lastBatch().numbers.map((n) => n.number);
    ppl.mode.cancelRefuse = [numbers[1]!];
    let c = ((await post(order, 'cancel', { reason: 'Omyl' }).expect(200)).body as OrderShipment)
      .shipment!;
    expect(c.status).toBe('CANCELLING');
    c = ((await post(order, 'cancel/resolve').expect(200)).body as OrderShipment).shipment!;
    expect(c.status).toBe('CANCELLING');
  });

  it('a shipment already picked up: PPL refuses every number — the labels stay', async () => {
    await ready();
    const { order } = await completed(1);
    await post(order, 'labels').expect(200);
    ppl.mode.pickedUp = lastBatch().numbers.map((n) => n.number);
    const c = ((await post(order, 'cancel', { reason: 'Omyl' }).expect(200)).body as OrderShipment)
      .shipment!;
    expect(c.status).toBe('LABELED');
  });

  it('no secret or token in anything stored for a shipment', async () => {
    await ready();
    const { order } = await completed(3);
    await post(order, 'labels').expect(200);
    const stored = JSON.stringify(
      [
        await t.prisma.shipmentCarrierRequest.findMany({
          where: { shipment: { order: { code: order } } },
        }),
        await t.prisma.orderEvent.findMany({ where: { order: { code: order } } }),
        await t.prisma.shipment.findMany({ where: { order: { code: order } } }),
      ],
      (_, v: unknown) => (typeof v === 'bigint' ? v.toString() : v),
    );
    expect(stored).not.toContain(ppl.clientSecret);
    expect(stored).not.toContain(ppl.validToken);
    expect(stored).not.toContain(ppl.clientId);
  });

  it('the complete A4 document comes from shipment/batch/{batchId}/label (as documented)', async () => {
    await ready({ label: { format: 'PDF', dpi: 203, layout: 'A4' } });
    const { order } = await completed(3);
    const s = ((await post(order, 'labels').expect(200)).body as OrderShipment).shipment!;
    expect(s.status).toBe('LABELED');
    expect(s.parcels.every((p) => p.label?.format === 'PDF')).toBe(true);
    const id = lastBatch().id;
    expect(ppl.seen.some((x) => x.path === `/shipment/batch/${id}/label` && x.bearer)).toBe(true);
    const complete = await http().get(`/api/admin/orders/${order}/shipment/labels`).expect(200);
    expect(complete.headers['content-type']).toContain('application/pdf');
    expect(complete.body.toString()).toContain(`complete A4 document of batch ${id}`);
  });

  it('A4 complete document only as PDF', async () => {
    await ready();
    const r = await save({ label: { format: 'ZPL', dpi: 203, layout: 'A4' } });
    expect([r.status, r.body.code]).toEqual([422, 'A4_NEEDS_PDF']);
  });

  it('disabled or incomplete settings and other sites: no new PPL shipment', async () => {
    await ready({ enabled: false });
    const { order } = await completed(1);
    expect((await view(order)).carrier).toMatchObject({
      configured: false,
      unavailable: 'DISABLED',
    });
    const res = await post(order, 'labels');
    expect([res.body.code, res.body.details]).toEqual([
      'CARRIER_NOT_CONFIGURED',
      { reason: 'DISABLED' },
    ]);
    await ready();
    const registry = t.app.get(CarrierRegistryService);
    const other = await t.prisma.site.findFirst({
      where: { id: { not: INITIAL_SITE_ID }, carrierSetting: null },
      select: { id: true },
    });
    if (other)
      expect(await registry.forSite(other.id)).toEqual({ gateway: null, reason: 'NOT_CONFIGURED' });
    // An existing request keeps its own connection, environment and account; anything else: none.
    const account = (await registry.ppl('PPL_TEST'))!.account;
    const ref = { carrierCode: 'PPL', connection: 'PPL_TEST', environment: 'TEST', account };
    expect(await registry.forConnection(ref)).not.toBeNull();
    expect(await registry.forConnection({ ...ref, environment: 'PRODUCTION' })).toBeNull();
    expect(await registry.forConnection({ ...ref, account: 'someotheraccount' })).toBeNull();
    expect(await registry.forConnection({ ...ref, account: null })).toBeNull();
  });

  it('the token is reused until it expires (not one per request)', async () => {
    await ready();
    const before = ppl.tokens;
    const { order } = await completed(3);
    const res = await post(order, 'labels');
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(ppl.tokens - before).toBeLessThanOrEqual(1);
  });

  // --- Credentials managed in the administration (ADR 0027). Last: they replace the server's
  // credentials of PPL_TEST in this test database.

  const connectionsUrl = '/api/admin/carrier-connections';
  const replace = (clientId: string, clientSecret: string, requestId = randomUUID()) =>
    http()
      .post(`${connectionsUrl}/PPL_TEST/credentials`)
      .send({ requestId, clientId, clientSecret, reason: 'Synthetic test credentials' });
  const pplTest = async () =>
    ((await http().get(connectionsUrl).expect(200)).body as CarrierConnectionAdmin[]).find(
      (c) => c.code === 'PPL_TEST',
    )!;

  it('credentials entered in the administration: encrypted, write-only, audited without values', async () => {
    await ready();
    expect(await pplTest()).toMatchObject({
      credentials: 'SET',
      source: 'SERVER',
      environment: 'TEST',
      keyAvailable: true,
    });
    // The same account entered in the administration; a repeat of the request is the same request.
    const id = randomUUID();
    const res = await replace(ppl.clientId, ppl.clientSecret, id).expect(200);
    await replace(ppl.clientId, ppl.clientSecret, id).expect(200);
    expect(await pplTest()).toMatchObject({ credentials: 'SET', source: 'ADMIN' });
    // Same account: the earlier verification stays valid.
    expect(((await http().get(settingsUrl).expect(200)).body as PplSettings).problems).toEqual([]);
    const row = await t.prisma.carrierConnection.findUniqueOrThrow({ where: { code: 'PPL_TEST' } });
    const stored = JSON.stringify(
      [
        res.body,
        await pplTest(),
        Buffer.from(row.secretCiphertext).toString('latin1'),
        await t.prisma.operationRequest.findMany({ where: { requestId: id } }),
        await t.prisma.auditEvent.findMany({ where: { type: 'CARRIER_CREDENTIALS_REPLACED' } }),
      ],
      (_, v: unknown) => (typeof v === 'bigint' ? v.toString() : v),
    );
    expect(stored).not.toContain(ppl.clientSecret);
    expect(stored).not.toContain(KEY);
    expect(stored).not.toContain('clientSecret":"');
    // Incomplete or foreign input is refused; nothing echoes the value.
    const bad = await http()
      .post(`${connectionsUrl}/PPL_TEST/credentials`)
      .send({ requestId: randomUUID(), clientId: 'x', clientSecret: '', reason: 'short secret' });
    expect(bad.status).toBe(400);
    expect((await replace('a', 'b').expect(200)) && true).toBe(true);
    await replace(ppl.clientId, ppl.clientSecret).expect(200);
    expect(
      (
        await http().post(`${connectionsUrl}/PPL_PROD/credentials`).send({
          requestId: randomUUID(),
          clientId: 'a',
          clientSecret: 'b',
          reason: 'no such connection',
        })
      ).status,
    ).toBe(404);
  });

  it('another account never takes over existing shipments; switching back restores them', async () => {
    await ready();
    const { order } = await completed(1);
    await post(order, 'labels').expect(200);
    const number = lastBatch().numbers[0]!.number;
    // Credentials of ANOTHER (synthetic) account.
    ppl.clients.set('ayvo-other-account', 'synthetic-other-secret');
    await replace('ayvo-other-account', 'synthetic-other-secret').expect(200);
    const v = await view(order);
    expect(v.shipment!.status, JSON.stringify(v)).toBe('LABELED');
    // The shipment's own carrier (its account) is not available; nothing switches to the new one.
    expect(v.shipment!.carrier.unavailable).toBe('CONNECTION_UNAVAILABLE');
    const cancels = ppl.seen.filter((x) => x.path.endsWith('/cancel')).length;
    expect((await post(order, 'cancel', { reason: 'Omyl' })).body.code).toBe(
      'CARRIER_CANCEL_UNSUPPORTED',
    );
    expect(ppl.seen.filter((x) => x.path.endsWith('/cancel')).length).toBe(cancels);
    // The site's verification was made with the previous account: new shipments wait for a new one.
    expect(((await http().get(settingsUrl).expect(200)).body as PplSettings).problems).toContain(
      'VERIFIED_WITH_ANOTHER_CONNECTION',
    );
    // Back to the original account: the shipment is cancelled with ITS account only.
    await replace(ppl.clientId, ppl.clientSecret).expect(200);
    const c = ((await post(order, 'cancel', { reason: 'Omyl' }).expect(200)).body as OrderShipment)
      .shipment!;
    expect(c.status).toBe('CANCELLING');
    const asked = ppl.seen.filter((x) => x.path === `/shipment/${number}/cancel`);
    expect(asked.map((x) => x.client)).toEqual([ppl.clientId]);
  });

  it('stored credentials unreadable with another key: never replaced by the server file', async () => {
    const other = await createTestApp({
      PPL_TEST_CLIENT_ID: ppl.clientId,
      PPL_TEST_CLIENT_SECRET: ppl.clientSecret,
      PPL_TEST_API_BASE_URL_FOR_TESTS: ppl.base,
      CARRIER_POLL_SECONDS: '0',
      CARRIER_CREDENTIALS_KEY: randomBytes(32).toString('base64'),
    });
    const noKey = await createTestApp({
      PPL_TEST_CLIENT_ID: ppl.clientId,
      PPL_TEST_CLIENT_SECRET: ppl.clientSecret,
      PPL_TEST_API_BASE_URL_FOR_TESTS: ppl.base,
      CARRIER_POLL_SECONDS: '0',
    });
    try {
      for (const app of [other, noKey]) {
        const list = (await request(app.app.getHttpServer()).get(connectionsUrl).expect(200))
          .body as CarrierConnectionAdmin[];
        expect(list.find((c) => c.code === 'PPL_TEST')).toMatchObject({
          credentials: 'UNREADABLE',
          source: 'ADMIN',
        });
        expect(await app.app.get(CarrierRegistryService).ppl('PPL_TEST')).toBeNull();
      }
      const refused = await request(noKey.app.getHttpServer())
        .post(`${connectionsUrl}/PPL_TEST/credentials`)
        .send({ requestId: randomUUID(), clientId: 'a', clientSecret: 'b', reason: 'no key' });
      expect([refused.status, refused.body.code]).toEqual([409, 'CREDENTIALS_KEY_MISSING']);
    } finally {
      await other.close();
      await noKey.close();
    }
  });
});
