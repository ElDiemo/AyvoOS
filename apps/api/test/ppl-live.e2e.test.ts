import { readFileSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import type { OrderShipment, PplSettings, VerifyCarrierResult } from '@ayvo/types';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { CarrierRegistryService } from '../src/carriers/carrier-registry.service.js';
import type { PplClient } from '../src/carriers/ppl/ppl-client.js';
import { allocateSerials } from '../src/database/code-counters.js';
import { ShipmentCarrierFlow } from '../src/orders/shipment-carrier-flow.service.js';
import {
  completeOrder,
  crateFactory,
  createHotel,
  createOrder,
  scanCrate,
} from './support/order-fixtures.js';
import { INITIAL_SITE_ID } from './support/sign-in.js';
import { FakePpl } from './support/fake-ppl.js';
import { createExchangeLog } from './support/ppl-exchange-log.js';
import { createTestApp, hasDatabase, type TestApp } from './support/test-app.js';

/**
 * ONE authorized run against the REAL PPL CPL TEST environment (owner, 2026-10-19). Never part of
 * the normal test run: only with AYVO_PPL_LIVE=1 and the TEST credentials in the environment.
 * Synthetic data only, in the per-run test database (never the live DEV database), files in a
 * temporary store. No pickup is ever ordered (the adapter has no such call). An uncertain request
 * is recorded, never re-sent. The report (AYVO_PPL_LIVE_REPORT) holds only non-secret facts: what
 * was called (method + path), states, numbers of the TEST environment, label sizes. Every exchange
 * (exact body sent, response received; no token, credential, phone or e-mail) is appended to
 * AYVO_PPL_LIVE_EXCHANGES — a directory outside git, required: nothing is sent without it, and the
 * evidence survives the test database (support/ppl-exchange-log.ts).
 */
/** A rehearsal of the same scenario against the simulated PPL (nothing leaves the machine). */
const dryRun = process.env.AYVO_PPL_LIVE_DRYRUN === '1';
/** BUSS = PPL's documented "PPL Parcel CZ Business"; the simulator lists its own codes. */
const PRODUCT = dryRun ? 'SIM-A' : 'BUSS';
const live =
  dryRun ||
  (process.env.AYVO_PPL_LIVE === '1' &&
    !!process.env.PPL_TEST_CLIENT_ID &&
    !!process.env.PPL_TEST_CLIENT_SECRET);

const BASE_PATH = '/ecs/ppl/myapi2';
/**
 * `full` — the first run (2026-10-19): verify, 1 crate, 3 crates, cancel both.
 * `set` — owner-authorized 2026-10-20: ONE 3-crate set only, without the shipment-level CUST
 * (PPL support: it overrides the items' own), then its cancellation.
 */
const scenario = process.env.AYVO_PPL_LIVE_SCENARIO ?? 'full';
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe.skipIf(!live || !hasDatabase)('PPL CPL TEST environment — one authorized live run', () => {
  let t: TestApp;
  let factory: Awaited<ReturnType<typeof crateFactory>>;
  let hotel: string;
  let stopFake: (() => Promise<void>) | undefined;
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
    // Without a place for the evidence, nothing is sent at all.
    const exchanges = process.env.AYVO_PPL_LIVE_EXCHANGES;
    if (!exchanges)
      throw new Error('AYVO_PPL_LIVE_EXCHANGES (a directory outside git) is required');
    const fake = dryRun ? new FakePpl('ayvo-dry-run-client', 'ayvo-dry-run-secret') : null;
    if (fake) {
      await fake.start();
      stopFake = () => fake.stop();
    }
    const connection = fake
      ? {
          PPL_TEST_CLIENT_ID: fake.clientId,
          PPL_TEST_CLIENT_SECRET: fake.clientSecret,
          PPL_TEST_API_BASE_URL_FOR_TESTS: fake.base,
        }
      : {
          PPL_TEST_CLIENT_ID: process.env.PPL_TEST_CLIENT_ID!,
          PPL_TEST_CLIENT_SECRET: process.env.PPL_TEST_CLIENT_SECRET!,
        };
    report.dryRun = dryRun;
    const log = createExchangeLog(exchanges, [
      connection.PPL_TEST_CLIENT_ID,
      connection.PPL_TEST_CLIENT_SECRET,
    ]);
    report.exchangeLog = log.file;
    // Record what is called (method, path, status) in the report; bodies only in the exchange log.
    const real = log.wrap(globalThis.fetch.bind(globalThis));
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
      ...connection,
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
    await stopFake?.();
  });

  // Synthetic sender and settings, the same in every scenario (results stay comparable).
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
        label: { layout: 'SINGLE' },
        ...over,
      });

  /** Settings + "Ověřit připojení" (token and product list only — no shipment). */
  async function verifiedProduct() {
    await save().expect(200);
    const verified = (await http().post(`${settingsUrl}/verify`).send({ requestId: randomUUID() }))
      .body as VerifyCarrierResult;
    report.verify = { ok: verified.ok, error: verified.error };
    expect(verified.ok).toBe(true);
    expect(verified.settings.verified!.products.map((p) => p.code)).toContain(PRODUCT);
    report.productUsed = PRODUCT;
  }

  it.skipIf(scenario !== 'full')(
    'runs the authorized scenario',
    async () => {
      // 1. Settings and "Ověřit připojení" (token + product code list).
      await save().expect(200);
      const verified = (
        await http().post(`${settingsUrl}/verify`).send({ requestId: randomUUID() })
      ).body as VerifyCarrierResult;
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
      await save({ productCode: 'BUSS', label: { layout: 'A4' } }).expect(200);
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
          complete: {
            status: c1.status,
            type: c1.type,
            bytes: c1.bytes,
            pdf: c1.pdf,
            size: c1.size,
          },
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
    },
    900_000,
  );

  it.skipIf(scenario !== 'set')(
    'one 3-crate set without the shipment-level CUST',
    async () => {
      // References never sent to PPL before (the first run used SHP-000001-1 and SHP-000002-1).
      await t.prisma.$transaction(async (tx) => {
        await allocateSerials(tx, 'order', 100);
        await allocateSerials(tx, 'shipment', 100);
      });
      await verifiedProduct();
      // The same settings as the first run's set: the product, PDF, the complete A4 document.
      await save({ productCode: PRODUCT, label: { layout: 'A4' } }).expect(200);
      const three = await completed(3);
      const posts = batchPosts();
      let s = ((await post(three.order, 'labels').expect(200)).body as OrderShipment).shipment!;
      report.firstAnswer = { status: s.status, request: s.request };
      try {
        s = await settle(three.order);
        const req = await t.prisma.shipmentCarrierRequest.findFirst({
          where: { shipment: { order: { code: three.order } } },
          orderBy: { attemptNo: 'desc' },
          select: { clientReference: true, result: true, status: true, errorCode: true },
        });
        // What was really sent: the batch body from the exchange log (never rebuilt).
        const sent = readFileSync(report.exchangeLog as string, 'utf8')
          .trim()
          .split('\n')
          .map(
            (l) => JSON.parse(l) as { phase: string; method: string; path: string; body: unknown },
          )
          .filter(
            (e) => e.phase === 'sent' && e.method === 'POST' && e.path.endsWith('/shipment/batch'),
          )
          .map(
            (e) =>
              (e.body as { json: { shipments: Record<string, unknown>[] } }).json.shipments[0]!,
          );
        expect(sent).toHaveLength(1);
        const body = sent[0] as {
          referenceId: string;
          externalNumbers?: unknown;
          shipmentSet: {
            numberOfShipments: number;
            shipmentSetItems: { externalNumbers: { code: string; externalNumber: string }[] }[];
          };
        };
        const sentRefs = body.shipmentSet.shipmentSetItems.map(
          (i) => i.externalNumbers[0]!.externalNumber,
        );
        report.sent = {
          referenceId: body.referenceId,
          shipmentLevelExternalNumbers: body.externalNumbers ?? null,
          numberOfShipments: body.shipmentSet.numberOfShipments,
          itemRefs: sentRefs,
        };
        expect.soft(body.externalNumbers).toBeUndefined();
        expect.soft(new Set(sentRefs).size).toBe(3);

        const numbers = ((req?.result as { numbers?: string[] } | null)?.numbers ?? []).filter(
          Boolean,
        );
        const record = numbers.length > 0 ? await pplRecord(numbers) : null;
        const returned = new Map(
          (
            (record?.shipments ?? []) as {
              shipmentNumber?: string;
              externalNumbers?: { code?: string; externalNumber?: string }[];
            }[]
          ).map((x) => [
            x.shipmentNumber,
            (x.externalNumbers ?? []).filter((e) => e.code === 'CUST').map((e) => e.externalNumber),
          ]),
        );
        report.set = {
          order: three.order,
          status: s.status,
          request: s.request,
          clientReference: req?.clientReference,
          numbers,
          pplRecord: record,
        };
        // 1. Exactly three parcels.
        expect.soft(numbers).toHaveLength(3);
        // 2.–3. Each number returns its own CUST, which names exactly one crate.
        const rows = [];
        for (const p of s.parcels) {
          const sentRef = `${req?.clientReference}-${p.parcelNo}`;
          rows.push({
            parcelNo: p.parcelNo,
            crate: p.crate,
            sentRef,
            sentInBody: sentRefs[p.parcelNo - 1] === sentRef,
            number: p.carrierParcelNumber,
            returnedCust: p.carrierParcelNumber
              ? (returned.get(p.carrierParcelNumber) ?? null)
              : null,
            label: null as unknown,
          });
        }
        report.rows = rows;
        // Three different numbers, three different crates, each sent reference returned once.
        expect.soft(new Set(rows.map((r) => r.number)).size).toBe(3);
        expect.soft(new Set(rows.map((r) => r.crate)).size).toBe(3);
        expect.soft([...returned.values()].flat().sort()).toEqual([...sentRefs].sort());
        for (const r of rows) {
          expect.soft(r.sentInBody).toBe(true);
          expect.soft(r.returnedCust).toEqual([r.sentRef]);
        }
        // 4.–5. Individual labels, the complete document; downloads twice, nothing new created.
        if (s.status === 'LABELED') {
          for (const r of rows) {
            const f1 = await download(
              `/api/admin/orders/${three.order}/shipment/parcels/${r.parcelNo}/label`,
            );
            const f2 = await download(
              `/api/admin/orders/${three.order}/shipment/parcels/${r.parcelNo}/label`,
            );
            r.label = {
              status: f1.status,
              pdf: f1.pdf,
              bytes: f1.bytes,
              size: f1.size,
              sameOnRepeat: f1.body.equals(f2.body),
            };
            if (process.env.AYVO_PPL_LIVE_FILES) {
              writeFileSync(
                `${process.env.AYVO_PPL_LIVE_FILES}/set-parcel-${r.parcelNo}-${r.number}.pdf`,
                f1.body,
              );
            }
          }
          const c1 = await download(`/api/admin/orders/${three.order}/shipment/labels`);
          const c2 = await download(`/api/admin/orders/${three.order}/shipment/labels`);
          if (process.env.AYVO_PPL_LIVE_FILES) {
            writeFileSync(`${process.env.AYVO_PPL_LIVE_FILES}/set-complete.pdf`, c1.body);
          }
          report.complete = {
            status: c1.status,
            pdf: c1.pdf,
            bytes: c1.bytes,
            size: c1.size,
            sameOnRepeat: c1.body.equals(c2.body),
          };
        }
        report.batchPosts = batchPosts() - posts;
        expect.soft(batchPosts() - posts).toBe(1);
        expect.soft(s.status).toBe('LABELED');
      } finally {
        // Cancellation of whatever was created — bounded; an uncertain creation is never re-sent.
        const before = (await view(three.order)).shipment!;
        if (['LABELED', 'REQUESTING'].includes(before.status)) {
          const first = await post(three.order, 'cancel', { reason: 'Syntetický test – storno' });
          let c = (first.body as OrderShipment).shipment;
          const trail = [{ at: new Date().toISOString(), status: c?.status ?? first.body.code }];
          const until = Date.now() + 15 * 60_000;
          while (c?.status === 'CANCELLING' && Date.now() < until) {
            await sleep(30_000);
            const r = await post(three.order, 'cancel/resolve');
            c = (r.body as OrderShipment).shipment;
            trail.push({ at: new Date().toISOString(), status: c?.status ?? r.body.code });
          }
          // Every number PPL created (also when the parcels could not be mapped).
          const numbers = (report.set as { numbers?: string[] } | undefined)?.numbers ?? [];
          report.cancel = {
            trail,
            final: c?.status,
            pplRecord: numbers.length > 0 ? await pplRecord(numbers) : null,
          };
        } else {
          report.cancel = { skipped: before.status };
        }
      }
    },
    1_500_000,
  );
});
