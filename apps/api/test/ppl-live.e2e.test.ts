import { writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import type { OrderShipment, PplSettings, VerifyCarrierResult } from '@ayvo/types';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { CarrierRegistryService } from '../src/carriers/carrier-registry.service.js';
import type { PplClient } from '../src/carriers/ppl/ppl-client.js';
import { ShipmentCarrierFlow } from '../src/orders/shipment-carrier-flow.service.js';
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
 * ONE authorized run against the REAL PPL CPL TEST environment (owner, 2026-10-19). Never part of
 * the normal test run: only with AYVO_PPL_LIVE=1 and the TEST credentials in the environment.
 * Synthetic data only, in the per-run test database (never the live DEV database), files in a
 * temporary store. No pickup is ever ordered (the adapter has no such call). An uncertain request
 * is recorded, never re-sent. The report (AYVO_PPL_LIVE_REPORT) holds only non-secret facts: what
 * was called (method + path), states, numbers of the TEST environment, label sizes.
 */
const live =
  process.env.AYVO_PPL_LIVE === '1' &&
  !!process.env.PPL_TEST_CLIENT_ID &&
  !!process.env.PPL_TEST_CLIENT_SECRET;

const BASE_PATH = '/ecs/ppl/myapi2';
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe.skipIf(!live || !hasDatabase)('PPL CPL TEST environment — one authorized live run', () => {
  let t: TestApp;
  let factory: Awaited<ReturnType<typeof crateFactory>>;
  let hotel: string;
  const report: Record<string, unknown> = { startedAt: new Date().toISOString() };
  const calls: { method: string; path: string; status: number | null; at: string }[] = [];
  const http = () => request(t.app.getHttpServer());
  const settingsUrl = `/api/admin/sites/${INITIAL_SITE_ID}/carriers/ppl`;
  const post = (order: string, path: string, body: object = {}) =>
    http()
      .post(`/api/admin/orders/${order}/shipment/${path}`)
      .send({ requestId: randomUUID(), ...body });
  const view = async (order: string) =>
    (await http().get(`/api/admin/orders/${order}/shipment`).expect(200)).body as OrderShipment;
  const flow = () => t.app.get(ShipmentCarrierFlow);
  const batchPosts = () =>
    calls.filter((c) => c.method === 'POST' && c.path === '/shipment/batch').length;

  async function completed(crates: number) {
    const made = [];
    await factory.refill();
    for (let i = 0; i < crates; i++) made.push(await factory.make());
    const order = await createOrder(t, hotel, [{ productCode: factory.kit.productCode, crates }]);
    for (const c of made) expect((await scanCrate(t, order.code, c.crateUrl)).status).toBe(200);
    expect((await completeOrder(t, order.code)).status).toBe(200);
    return { order: order.code, crates: made.map((c) => c.crateCode) };
  }

  /** Follows an accepted request with the real poller (bounded); never re-sends anything. */
  async function settle(order: string, maxMs = 240_000) {
    const until = Date.now() + maxMs;
    let s = (await view(order)).shipment!;
    while (Date.now() < until && s.status === 'REQUESTING') {
      const r = s.request;
      if (!r || !['ACCEPTED', 'CREATED'].includes(r.status) || s.pollingStopped) break;
      if (r.status === 'CREATED' && r.errorCode && r.errorCode !== 'LABELS_NOT_DOWNLOADED') break;
      await sleep(4000);
      await t.prisma.$executeRaw`UPDATE "shipment_carrier_requests" SET "next_poll_at" = now()
        WHERE "status" IN ('ACCEPTED', 'CREATED') AND "next_poll_at" IS NOT NULL`;
      await flow().pollDue(10);
      s = (await view(order)).shipment!;
    }
    return s;
  }

  /** Width × height (mm) of the first page of a PDF, from its MediaBox. */
  function pdfSize(bytes: Buffer): string | null {
    const m = /\/MediaBox\s*\[\s*([-\d.]+)\s+([-\d.]+)\s+([-\d.]+)\s+([-\d.]+)\s*\]/.exec(
      bytes.toString('latin1'),
    );
    if (!m) return null;
    const mm = (pt: number) => Math.round((pt / 72) * 25.4 * 10) / 10;
    return `${mm(Number(m[3]) - Number(m[1]))} × ${mm(Number(m[4]) - Number(m[2]))} mm`;
  }

  async function download(path: string) {
    const res = await http()
      .get(path)
      .buffer(true)
      .parse((r, cb) => {
        const chunks: Buffer[] = [];
        r.on('data', (c: Buffer) => chunks.push(c));
        r.on('end', () => cb(null, Buffer.concat(chunks)));
      });
    const body = res.body as Buffer;
    return {
      status: res.status,
      type: res.headers['content-type'] as string,
      bytes: body.length,
      pdf: body.subarray(0, 5).toString('latin1') === '%PDF-',
      size: pdfSize(body),
      body,
    };
  }

  /** Independent check of the mapping: PPL's own record of each number and its CUST reference. */
  async function pplRecord(numbers: string[]) {
    const gateway = (await t.app.get(CarrierRegistryService).ppl('PPL_TEST'))!;
    const client = (gateway as unknown as { client: PplClient }).client;
    const res = await client.request('GET', '/shipment', {
      query: { ShipmentNumbers: numbers, Limit: 50, Offset: 0 },
      signal: AbortSignal.timeout(30_000),
    });
    return {
      status: res.status,
      shipments: Array.isArray(res.body)
        ? (
            res.body as {
              shipmentNumber?: string;
              shipmentState?: string;
              externalNumbers?: { code?: string; externalNumber?: string }[];
              shipmentSet?: unknown;
            }[]
          ).map((x) => ({
            shipmentNumber: x.shipmentNumber,
            shipmentState: x.shipmentState,
            externalNumbers: x.externalNumbers,
            shipmentSet: x.shipmentSet,
          }))
        : res.body,
    };
  }

  beforeAll(async () => {
    // Record what is called (method, path, status) — never headers or bodies.
    const real = globalThis.fetch;
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = new URL(String(input instanceof Request ? input.url : input));
      const entry = {
        method: (init?.method ?? 'GET').toUpperCase(),
        path: url.pathname.startsWith(BASE_PATH) ? url.pathname.slice(BASE_PATH.length) : url.host,
        status: null as number | null,
        at: new Date().toISOString(),
      };
      calls.push(entry);
      const res = await real(input, init);
      entry.status = res.status;
      return res;
    });
    t = await createTestApp({
      PPL_TEST_CLIENT_ID: process.env.PPL_TEST_CLIENT_ID!,
      PPL_TEST_CLIENT_SECRET: process.env.PPL_TEST_CLIENT_SECRET!,
      CARRIER_POLL_SECONDS: '0',
      CARRIER_CALL_TIMEOUT_SECONDS: '30',
    });
    factory = await crateFactory(t, { capacity: 2 });
    hotel = (
      await createHotel(t, {
        name: 'AYVO TEST Hotel (synteticky)',
        addressLine1: 'Namesti T. G. Masaryka 1',
        postalCode: '750 02',
        city: 'Prerov',
        contactName: 'Testovaci recepce',
        contactPhone: '+420 581 000 000',
        contactEmail: 'recepce@example.com',
      })
    ).code;
  }, 120_000);

  afterAll(async () => {
    report.finishedAt = new Date().toISOString();
    report.calls = calls;
    if (process.env.AYVO_PPL_LIVE_REPORT) {
      writeFileSync(process.env.AYVO_PPL_LIVE_REPORT, JSON.stringify(report, null, 2));
    }
    vi.restoreAllMocks();
    await t?.close();
  });

  it('runs the authorized scenario', async () => {
    // 1. Settings and "Ověřit připojení" (token + product code list).
    const sender = {
      name: 'AYVO TEST odesilatel',
      street: 'Prumyslova 1',
      city: 'Prerov',
      postalCode: '75002',
      country: 'CZ',
      contact: 'Testovaci expedice',
      phone: '+420 581 000 001',
      email: 'expedice@example.com',
    };
    const save = (over: object = {}) =>
      http()
        .put(settingsUrl)
        .send({
          requestId: randomUUID(),
          enabled: true,
          connection: 'PPL_TEST',
          sender,
          productCode: null,
          label: { format: 'PDF', dpi: 203, layout: 'SINGLE' },
          ...over,
        });
    await save().expect(200);
    const verified = (await http().post(`${settingsUrl}/verify`).send({ requestId: randomUUID() }))
      .body as VerifyCarrierResult;
    report.verify = {
      ok: verified.ok,
      error: verified.error,
      products: verified.settings?.verified?.products,
    };
    expect(verified.ok).toBe(true);
    const products = verified.settings.verified!.products.map((p) => p.code);
    // The test needs one domestic parcel service; BUSS is PPL's documented "PPL Parcel CZ Business".
    expect(products).toContain('BUSS');
    report.productUsed = 'BUSS';
    const settled = (await save({ productCode: 'BUSS' }).expect(200)).body as PplSettings;
    expect(settled.problems).toEqual([]);

    // 2. One crate: one shipment, its own label; re-download creates nothing.
    const one = await completed(1);
    const posts0 = batchPosts();
    let s = ((await post(one.order, 'labels').expect(200)).body as OrderShipment).shipment!;
    report.oneCrateFirstAnswer = { status: s.status, request: s.request };
    s = await settle(one.order);
    report.oneCrate = {
      order: one.order,
      crates: one.crates,
      status: s.status,
      request: s.request,
      shipmentRef: s.carrierShipmentRef,
      parcels: s.parcels.map((p) => ({
        parcelNo: p.parcelNo,
        crate: p.crate,
        number: p.carrierParcelNumber,
        label: p.label,
      })),
    };
    expect.soft(batchPosts() - posts0).toBe(1);
    if (s.status === 'LABELED') {
      const f1 = await download(`/api/admin/orders/${one.order}/shipment/parcels/1/label`);
      const f2 = await download(`/api/admin/orders/${one.order}/shipment/parcels/1/label`);
      report.oneCrateLabel = {
        status: f1.status,
        type: f1.type,
        bytes: f1.bytes,
        pdf: f1.pdf,
        size: f1.size,
        sameOnRepeat: f1.body.equals(f2.body),
      };
      if (process.env.AYVO_PPL_LIVE_FILES) {
        writeFileSync(`${process.env.AYVO_PPL_LIVE_FILES}/one-crate-parcel-1.pdf`, f1.body);
      }
      expect.soft(batchPosts() - posts0).toBe(1);
      report.oneCratePplRecord = await pplRecord([s.parcels[0]!.carrierParcelNumber!]);
    }

    // 3. Three crates, with the complete A4 document: each number mapped to its crate.
    await save({ productCode: 'BUSS', label: { format: 'PDF', dpi: 203, layout: 'A4' } }).expect(
      200,
    );
    const three = await completed(3);
    const posts1 = batchPosts();
    let s3 = ((await post(three.order, 'labels').expect(200)).body as OrderShipment).shipment!;
    report.threeCratesFirstAnswer = { status: s3.status, request: s3.request };
    s3 = await settle(three.order);
    const req3 = await t.prisma.shipmentCarrierRequest.findFirst({
      where: { shipment: { order: { code: three.order } } },
      orderBy: { attemptNo: 'desc' },
      select: { clientReference: true, result: true, status: true, errorCode: true },
    });
    report.threeCrates = {
      order: three.order,
      crates: three.crates,
      status: s3.status,
      request: s3.request,
      clientReference: req3?.clientReference,
      result: req3?.result,
      parcels: s3.parcels.map((p) => ({
        parcelNo: p.parcelNo,
        crate: p.crate,
        number: p.carrierParcelNumber,
        label: p.label,
      })),
    };
    expect.soft(batchPosts() - posts1).toBe(1);
    const numbers = ((req3?.result as { numbers?: string[] } | null)?.numbers ?? []).filter(
      Boolean,
    );
    if (numbers.length > 0) report.threeCratesPplRecord = await pplRecord(numbers);
    if (s3.status === 'LABELED') {
      const files = [];
      for (const p of s3.parcels) {
        const f = await download(
          `/api/admin/orders/${three.order}/shipment/parcels/${p.parcelNo}/label`,
        );
        files.push({
          parcelNo: p.parcelNo,
          crate: p.crate,
          type: f.type,
          bytes: f.bytes,
          pdf: f.pdf,
          size: f.size,
        });
        if (process.env.AYVO_PPL_LIVE_FILES) {
          writeFileSync(
            `${process.env.AYVO_PPL_LIVE_FILES}/three-crates-parcel-${p.parcelNo}.pdf`,
            f.body,
          );
        }
      }
      const c1 = await download(`/api/admin/orders/${three.order}/shipment/labels`);
      const c2 = await download(`/api/admin/orders/${three.order}/shipment/labels`);
      if (process.env.AYVO_PPL_LIVE_FILES) {
        writeFileSync(`${process.env.AYVO_PPL_LIVE_FILES}/three-crates-complete.pdf`, c1.body);
      }
      report.threeCratesLabels = {
        parcels: files,
        complete: { status: c1.status, type: c1.type, bytes: c1.bytes, pdf: c1.pdf, size: c1.size },
        completeSameOnRepeat: c1.body.equals(c2.body),
      };
      expect.soft(batchPosts() - posts1).toBe(1);
    }

    // 4. Cancellation of both, confirmed only by PPL's own state (bounded; never guessed).
    const cancelled: Record<string, unknown> = {};
    for (const order of [one.order, three.order]) {
      const before = (await view(order)).shipment!;
      if (!['LABELED', 'REQUESTING'].includes(before.status)) {
        cancelled[order] = { skipped: before.status };
        continue;
      }
      const first = await post(order, 'cancel', { reason: 'Syntetický test – storno' });
      let c = (first.body as OrderShipment).shipment;
      const trail = [{ at: new Date().toISOString(), status: c?.status ?? first.body.code }];
      const until = Date.now() + 240_000;
      while (c?.status === 'CANCELLING' && Date.now() < until) {
        await sleep(10_000);
        const r = await post(order, 'cancel/resolve');
        c = (r.body as OrderShipment).shipment;
        trail.push({ at: new Date().toISOString(), status: c?.status ?? r.body.code });
      }
      const ev = await t.prisma.orderEvent.findMany({
        where: { order: { code: order } },
        select: { type: true },
        orderBy: { occurredAt: 'asc' },
      });
      cancelled[order] = { trail, final: c?.status, events: ev.map((e) => e.type) };
    }
    report.cancel = cancelled;
    const all = [
      ...((report.oneCrate as { parcels: { number: string | null }[] }).parcels ?? []),
      ...((report.threeCrates as { parcels: { number: string | null }[] }).parcels ?? []),
    ]
      .map((p) => p.number)
      .filter((n): n is string => !!n);
    if (all.length > 0) report.afterCancelPplRecord = await pplRecord(all);
  }, 900_000);
});
