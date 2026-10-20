import { createHash, randomUUID } from 'node:crypto';
import type {
  AgentClaim,
  OrderDetail,
  OrderShipment,
  PrintAgentToken,
  SitePrinting,
} from '@ayvo/types';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { testCarrierControl } from '../src/carriers/test-carrier.js';
import { ShipmentCarrierFlow } from '../src/orders/shipment-carrier-flow.service.js';
import { PrintQueueService } from '../src/printing/print-queue.service.js';
import { crateFactory, createHotel, createOrder, scanCrate } from './support/order-fixtures.js';
import { INITIAL_SITE_ID } from './support/sign-in.js';
import { createTestApp, hasDatabase, type TestApp } from './support/test-app.js';

/**
 * Direct printing (doc 030, ADR 0028) against the real database, the FAKE test carrier and a
 * SIMULATED print agent (these tests call the agent API like the Raspberry Pi would — no device).
 * "Dokončit a vytisknout štítky": three crates → three PDF and three ZPL labels with the same
 * numbers → three print jobs on the printer the operator saw; the agent's protocol (claim, start,
 * result), expired claims, unknown results (never retried), re-printing one label, cancellation of
 * the shipment, a changed default printer, other sites, and no stock movement.
 */
const ENV = {
  CARRIER_PROVIDER: 'test',
  CARRIER_POLL_SECONDS: '0',
  CARRIER_SETTLE_SECONDS: '0',
  CARRIER_CALL_TIMEOUT_SECONDS: '2',
};
const OTHER_SITE = '01990000-0000-7000-8000-0000000003a1';

describe.skipIf(!hasDatabase)('direct printing: labels, print queue, print agent (doc 030)', () => {
  let t: TestApp;
  let factory: Awaited<ReturnType<typeof crateFactory>>;
  let hotel: string;
  const http = () => request(t.app.getHttpServer());
  const admin = (path: string) => `/api/admin/sites/${INITIAL_SITE_ID}/printing${path}`;
  const rid = () => randomUUID();
  let agentA: { id: string; token: string };
  let agentB: { id: string; token: string };
  let printerA: string;
  let printerB: string;

  const agent = (token: string) => ({
    post: (path: string, body: object = {}) =>
      http().post(`/api/agent/v1/${path}`).set('X-Ayvo-Print-Agent', token).send(body),
    get: (path: string) => http().get(`/api/agent/v1/${path}`).set('X-Ayvo-Print-Agent', token),
  });
  const claim = async (token: string) =>
    ((await agent(token).post('jobs/claim').expect(200)).body as AgentClaim).job;
  const view = async (order: string) =>
    (await http().get(`/api/admin/orders/${order}/shipment`).expect(200)).body as OrderShipment;
  const detail = async (order: string) =>
    (await http().get(`/api/admin/orders/${order}`).expect(200)).body as OrderDetail;
  const post = (order: string, path: string, body: object = {}) =>
    http()
      .post(`/api/admin/orders/${order}/shipment/${path}`)
      .send({ requestId: rid(), ...body });
  const queue = () => t.app.get(PrintQueueService);
  const flow = () => t.app.get(ShipmentCarrierFlow);
  const jobsOf = (order: string) =>
    t.prisma.printJob.findMany({
      where: { order: { code: order } },
      include: { parcel: { select: { parcelNo: true } } },
      orderBy: [{ createdAt: 'asc' }, { serial: 'asc' }],
    });
  const ledger = async () => ({
    movements: await t.prisma.inventoryMovement.count(),
    balances: (await t.prisma.inventoryBalance.findMany({ orderBy: { id: 'asc' } })).map((b) =>
      b.onHand.toString(),
    ),
  });
  const binary = (req: request.Test) =>
    req.buffer(true).parse((res, cb) => {
      const chunks: Buffer[] = [];
      res.on('data', (d: Buffer) => chunks.push(d));
      res.on('end', () => cb(null, Buffer.concat(chunks)));
    });

  async function picked(crates = 3) {
    await factory.refill();
    const made = [];
    for (let i = 0; i < crates; i++) made.push(await factory.make());
    const order = await createOrder(t, hotel, [{ productCode: factory.kit.productCode, crates }]);
    for (const c of made) expect((await scanCrate(t, order.code, c.crateUrl)).status).toBe(200);
    return { order: order.code, crates: made.map((c) => c.crateCode) };
  }
  const completeAndPrint = (order: string, printerId: string | null, requestId = rid()) =>
    http().post(`/api/admin/orders/${order}/complete-and-label`).send({ requestId, printerId });
  /** The simulated Raspberry Pi: claim → data → start → result. */
  async function printOne(
    token: string,
    outcome: 'SENT' | 'UNCERTAIN' | 'FAILED_BEFORE_SEND' = 'SENT',
  ) {
    const job = await claim(token);
    if (!job) return null;
    const data = await binary(
      agent(token).get(`jobs/${job.id}/data`).set('X-Ayvo-Claim', job.claimToken),
    ).expect(200);
    const bytes = data.body as Buffer;
    expect(createHash('sha256').update(bytes).digest('hex')).toBe(job.sha256);
    await agent(token).post(`jobs/${job.id}/start`, { claimToken: job.claimToken }).expect(200);
    await agent(token)
      .post(`jobs/${job.id}/result`, { claimToken: job.claimToken, outcome, detail: null })
      .expect(200);
    return { job, zpl: bytes.toString('latin1') };
  }
  const printerBody = (
    p: { id: string | null; code: string; name: string; agentId: string; usbSerial: string },
    over: object = {},
  ) => ({
    requestId: rid(),
    ...p,
    model: 'ZEBRA_ZD220_DT',
    dispatchDefault: false,
    autoPrint: true,
    enabled: true,
    ...over,
  });
  async function setDefault(printerId: string) {
    const p = await t.prisma.printer.findUniqueOrThrow({ where: { id: printerId } });
    const res = await http()
      .post(admin('/printers'))
      .send(
        printerBody(
          { id: p.id, code: p.code, name: p.name, agentId: p.agentId, usbSerial: p.usbSerial },
          { dispatchDefault: true },
        ),
      );
    expect(res.status, JSON.stringify(res.body)).toBe(200);
  }

  beforeAll(async () => {
    t = await createTestApp(ENV);
    factory = await crateFactory(t, { capacity: 2 });
    hotel = (await createHotel(t, { name: 'Hotel Tisk' })).code;
    // A second, fictional site (for "another site" checks).
    await t.prisma.$executeRawUnsafe(`
      INSERT INTO "sites" ("id", "code", "name", "country_code", "address_line1", "postal_code", "city",
                           "time_zone", "default_locale", "default_currency", "capabilities")
      VALUES ('${OTHER_SITE}', 'PRN-TEST', 'Tisk – jiná provozovna', 'CZ', 'Jinde 1', '11000',
              'Praha', 'Europe/Prague', 'cs-CZ', 'CZK', ARRAY['WAREHOUSE']::"SiteCapability"[])
      ON CONFLICT DO NOTHING`);
    const suffix = randomUUID().slice(0, 4).toUpperCase();
    const create = async (code: string) => {
      const r = (
        await http()
          .post(admin('/agents'))
          .send({ requestId: rid(), code, name: `Raspberry ${code}` })
          .expect(200)
      ).body as PrintAgentToken;
      return { id: r.agent.id, token: r.token! };
    };
    agentA = await create(`RPI-A-${suffix}`);
    agentB = await create(`RPI-B-${suffix}`);
    const save = async (code: string, agentId: string) =>
      (
        (
          await http()
            .post(admin('/printers'))
            .send(
              printerBody({
                id: null,
                code,
                name: `Zebra ${code}`,
                agentId,
                usbSerial: `S${suffix}${code.at(-1)}`,
              }),
            )
            .expect(200)
        ).body as SitePrinting
      ).printers.find((p) => p.code === code)!.id;
    printerA = await save(`ZD-A-${suffix}`, agentA.id);
    printerB = await save(`ZD-B-${suffix}`, agentB.id);
  });
  afterAll(async () => {
    testCarrierControl.reset();
    await t?.close();
  });
  beforeEach(async () => {
    testCarrierControl.reset();
    // The test carrier needs no weights here (weights are covered by the dispatch tests).
    testCarrierControl.rules.parcelWeight = 'NOT_USED';
    await setDefault(printerA);
    // Nothing left over from another test waits for these agents.
    await t.prisma.$executeRaw`UPDATE "print_jobs" SET "status" = 'CANCELLED', "finished_at" = now()
      WHERE "status" IN ('QUEUED', 'CLAIMED')`;
  });

  it('the agent token is shown once, stored only as a hash; agents act only through their own API', async () => {
    const row = await t.prisma.printAgent.findUniqueOrThrow({ where: { id: agentA.id } });
    expect(row.tokenHash).toBe(createHash('sha256').update(agentA.token).digest('hex'));
    expect(JSON.stringify(row)).not.toContain(agentA.token);
    const printing = (await http().get(admin('')).expect(200)).body as SitePrinting;
    expect(JSON.stringify(printing)).not.toContain(agentA.token);
    const audit = await t.prisma.auditEvent.findMany({ where: { type: { startsWith: 'PRINT' } } });
    expect(JSON.stringify(audit)).not.toContain(agentA.token);
    // A replay of the creation (a lost answer) never shows the token again.
    const id = rid();
    const code = `RPI-R-${id.slice(0, 4).toUpperCase()}`;
    const first = (await http().post(admin('/agents')).send({ requestId: id, code, name: 'R' }))
      .body as PrintAgentToken;
    const again = (await http().post(admin('/agents')).send({ requestId: id, code, name: 'R' }))
      .body as PrintAgentToken;
    expect(first.token).toMatch(/^ayvo_pa_/);
    expect(again.token).toBeNull();
    // The agent's API needs its token.
    await http().post('/api/agent/v1/heartbeat').send({ version: '1', printers: [] }).expect(401);
    const hb = await agent(agentA.token)
      .post('heartbeat', {
        version: '0.1.0',
        printers: [
          { printerId: printerA, state: 'READY', detail: null },
          // Another agent's printer: ignored.
          { printerId: printerB, state: 'ERROR', detail: 'cizí' },
        ],
      })
      .expect(200);
    expect(hb.body.printers.map((p: { id: string }) => p.id)).toEqual([printerA]);
    expect(
      (await t.prisma.printer.findUniqueOrThrow({ where: { id: printerB } })).reportedState,
    ).not.toBe('ERROR');
    // Rotating gives a new token; the old one stops working. A revoked agent is refused.
    const rotated = (
      await http()
        .post(admin(`/agents/${first.agent.id}/rotate`))
        .send({ requestId: rid(), reason: 'Výměna karty' })
        .expect(200)
    ).body as PrintAgentToken;
    await agent(first.token!).post('heartbeat', { version: '1', printers: [] }).expect(401);
    await agent(rotated.token!).post('heartbeat', { version: '1', printers: [] }).expect(200);
    // Detected USB printers are stored as a suggestion only — no printer is created or changed.
    const printersBefore = await t.prisma.printer.count();
    await agent(rotated.token!)
      .post('heartbeat', {
        version: '1',
        printers: [],
        devices: [{ usbSerial: 'D4J2211', product: 'ZTC ZD220-203dpi ZPL', manufacturer: 'Zebra' }],
      })
      .expect(200);
    const listed = (await http().get(admin('')).expect(200)).body as SitePrinting;
    expect(listed.agents.find((a) => a.id === first.agent.id)!.detectedDevices).toEqual([
      { usbSerial: 'D4J2211', product: 'ZTC ZD220-203dpi ZPL', manufacturer: 'Zebra' },
    ]);
    expect(await t.prisma.printer.count()).toBe(printersBefore);
    await agent(rotated.token!)
      .post('heartbeat', { version: '1', printers: [], devices: [{ usbSerial: 'x y' }] })
      .expect(400);
    await http()
      .post(admin(`/agents/${first.agent.id}/revoke`))
      .send({ requestId: rid(), reason: 'Zařízení vyřazeno' })
      .expect(200);
    await agent(rotated.token!).post('heartbeat', { version: '1', printers: [] }).expect(401);
  });

  it('three crates: one action completes, makes 3 PDF + 3 ZPL with the same numbers and prints them', async () => {
    const { order, crates } = await picked(3);
    // From the picked order on (making the crates is production, not dispatch).
    const before = await ledger();
    const res = await completeAndPrint(order, printerA);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const s = (res.body as OrderShipment).shipment!;
    expect(s.status).toBe('LABELED');
    expect((await detail(order)).status).toBe('READY_TO_DISPATCH');
    expect(testCarrierControl.calls).toHaveLength(1);
    expect(testCarrierControl.variantCalls).toBe(1);
    expect(s.zpl).toMatchObject({ status: 'DONE', dpi: 203 });
    // Each crate: its own PDF and ZPL; the ZPL names this parcel's number, reference and crate.
    expect(s.parcels.map((p) => p.crate)).toEqual(crates);
    for (const p of s.parcels) {
      expect(p.labels.map((l) => l.format)).toEqual(['PDF', 'ZPL']);
      const zpl = await binary(
        http().get(`/api/admin/orders/${order}/shipment/parcels/${p.parcelNo}/label/zpl`),
      ).expect(200);
      const text = (zpl.body as Buffer).toString('latin1');
      expect(text).toContain(p.carrierParcelNumber!);
      expect(text).toContain(`Ref.: ${s.request!.clientReference}-${p.parcelNo}`);
      expect(text).toContain(`Crate: ${p.crate}`);
      expect(p.printJobs).toHaveLength(1);
      expect(p.printJobs[0]).toMatchObject({ status: 'QUEUED', kind: 'SHIPMENT' });
    }
    const jobs = await jobsOf(order);
    expect(jobs.map((j) => [j.parcel.parcelNo, j.printerId, j.agentId, j.status])).toEqual(
      [1, 2, 3].map((n) => [n, printerA, agentA.id, 'QUEUED']),
    );
    // The agent of ANOTHER printer gets none of them.
    expect(await claim(agentB.token)).toBeNull();
    // The simulated Pi prints each from the stored ZPL of exactly its parcel.
    for (let i = 0; i < 3; i++) {
      const printed = (await printOne(agentA.token))!;
      const job = jobs.find((j) => j.id === printed.job.id)!;
      const parcel = s.parcels.find((p) => p.parcelNo === job.parcel.parcelNo)!;
      expect(printed.zpl).toContain(parcel.carrierParcelNumber!);
    }
    expect(await claim(agentA.token)).toBeNull();
    const after = await view(order);
    expect(after.shipment!.parcels.every((p) => p.printJobs[0]!.status === 'SENT')).toBe(true);
    // Sent to the printer ≠ applied: still waiting for "Připraveno k vyzvednutí".
    expect((await detail(order)).status).toBe('READY_TO_DISPATCH');
    expect((await detail(order)).history.map((h) => h.type)).toEqual(
      expect.arrayContaining([
        'COMPLETED',
        'LABELS_CREATED',
        'LABEL_VARIANT_STORED',
        'PRINT_REQUESTED',
      ]),
    );
    // Dispatch and printing move no stock.
    expect(await ledger()).toEqual(before);
  });

  it('double click and a lost answer of the combined action repeat nothing', async () => {
    const { order } = await picked(2);
    const id = rid();
    const [a, b] = await Promise.all([
      completeAndPrint(order, printerA, id),
      completeAndPrint(order, printerA, id),
    ]);
    // One of a concurrent pair may meet the other's open transaction (a conflict) — never both work.
    expect([a.status, b.status]).toContain(200);
    // The lost answer: the same request again.
    expect((await completeAndPrint(order, printerA, id)).status).toBe(200);
    expect(testCarrierControl.calls).toHaveLength(1);
    expect(await jobsOf(order)).toHaveLength(2);
    // A NEW click after it worked: the labels exist — nothing is created or printed again.
    const again = await completeAndPrint(order, printerA);
    expect([again.status, again.body.code]).toEqual([409, 'LABELS_EXIST']);
    expect(await jobsOf(order)).toHaveLength(2);
  });

  it('a default printer changed after the operator looked is refused; nothing done', async () => {
    const { order } = await picked(1);
    const res = await completeAndPrint(order, printerB);
    expect([res.status, res.body.code]).toEqual([409, 'PRINTER_CHANGED']);
    expect((await detail(order)).status).toBe('OPEN');
    expect(testCarrierControl.calls).toHaveLength(0);
    // Without a printer: completed and labelled, nothing printed.
    const plain = await completeAndPrint(order, null);
    expect(plain.status).toBe(200);
    expect(await jobsOf(order)).toHaveLength(0);
    expect((plain.body as OrderShipment).shipment!.status).toBe('LABELED');
  });

  it('carrier outage between PDF and ZPL: PDF usable, printing waits, the ZPL follows later', async () => {
    const { order } = await picked(2);
    testCarrierControl.variant = ['FAIL'];
    const s = ((await completeAndPrint(order, printerA).expect(200)).body as OrderShipment)
      .shipment!;
    expect(s.status).toBe('LABELED');
    expect(s.zpl).toMatchObject({ status: 'PENDING', errorCode: 'LABELS_NOT_DOWNLOADED' });
    expect(s.printWaiting).toEqual([
      expect.objectContaining({ kind: 'SHIPMENT', printer: expect.stringContaining('Zebra') }),
    ]);
    expect(await jobsOf(order)).toHaveLength(0);
    // The PDF preview works meanwhile; the ZPL does not exist yet.
    await http().get(`/api/admin/orders/${order}/shipment/parcels/1/label`).expect(200);
    await http().get(`/api/admin/orders/${order}/shipment/parcels/1/label/zpl`).expect(404);
    // The background round fetches it later (the same shipment, no new carrier request).
    await t.prisma.$executeRaw`UPDATE "shipment_label_fetches" SET "next_at" = now()`;
    await flow().variantsDue(20);
    const later = await view(order);
    expect(later.shipment!.zpl).toMatchObject({ status: 'DONE' });
    expect(later.shipment!.printWaiting).toEqual([]);
    expect(await jobsOf(order)).toHaveLength(2);
    expect(testCarrierControl.calls).toHaveLength(1);
  });

  it('a ZPL that does not prove its parcel is refused; a person fetches it again', async () => {
    const { order } = await picked(3);
    testCarrierControl.variant = ['WRONG_POSITION'];
    const s = ((await completeAndPrint(order, printerA).expect(200)).body as OrderShipment)
      .shipment!;
    expect(s.zpl).toMatchObject({ status: 'FAILED', errorCode: 'LABEL_VARIANT_MISMATCH' });
    expect(s.zpl!.errorMessage).toContain('position 3/3');
    expect(await jobsOf(order)).toHaveLength(0);
    expect((await detail(order)).history.map((h) => h.type)).toContain('LABEL_VARIANT_FAILED');
    // "Získat ZPL znovu": the carrier answers correctly now → stored, the waiting print goes on.
    const again = ((await post(order, 'zpl/retry').expect(200)).body as OrderShipment).shipment!;
    expect(again.zpl).toMatchObject({ status: 'DONE' });
    expect(await jobsOf(order)).toHaveLength(3);
  });

  it('agent offline, printer unplugged, restart: jobs wait; an expired claim returns to the queue', async () => {
    const { order } = await picked(1);
    await completeAndPrint(order, printerA).expect(200);
    // The printer reported as missing: shown truthfully, the job still waits.
    await agent(agentA.token)
      .post('heartbeat', {
        version: '0.1.0',
        printers: [{ printerId: printerA, state: 'NOT_FOUND', detail: 'USB nenalezena' }],
      })
      .expect(200);
    expect((await view(order)).printer).toMatchObject({ reportedState: 'NOT_FOUND' });
    // The agent claims, then restarts before starting: nothing was written.
    const job = (await claim(agentA.token))!;
    await t.prisma
      .$executeRaw`UPDATE "print_jobs" SET "lease_until" = now() - interval '1 second' WHERE "id" = ${job.id}::uuid`;
    await queue().sweep();
    expect((await t.prisma.printJob.findUniqueOrThrow({ where: { id: job.id } })).status).toBe(
      'QUEUED',
    );
    // Its old claim cannot start the job any more; the next claim can.
    await agent(agentA.token)
      .post(`jobs/${job.id}/start`, { claimToken: job.claimToken })
      .expect(404);
    const again = (await claim(agentA.token))!;
    expect(again.id).toBe(job.id);
    await agent(agentA.token)
      .post(`jobs/${again.id}/start`, { claimToken: again.claimToken })
      .expect(200);
    await agent(agentA.token)
      .post(`jobs/${again.id}/result`, {
        claimToken: again.claimToken,
        outcome: 'SENT',
        detail: null,
      })
      .expect(200);
    const events = await t.prisma.printJobEvent.findMany({
      where: { jobId: job.id },
      orderBy: { occurredAt: 'asc' },
    });
    expect(events.map((e) => e.status)).toEqual([
      'QUEUED',
      'CLAIMED',
      'CLAIM_EXPIRED',
      'CLAIMED',
      'SENDING',
      'SENT',
    ]);
  });

  it('a failure proven before sending is final for that job; the operator prints it again', async () => {
    const { order } = await picked(1);
    await completeAndPrint(order, printerA).expect(200);
    const job = (await claim(agentA.token))!;
    await agent(agentA.token)
      .post(`jobs/${job.id}/result`, {
        claimToken: job.claimToken,
        outcome: 'FAILED_BEFORE_SEND',
        detail: 'Tiskárna odpojená',
      })
      .expect(200);
    expect(await claim(agentA.token)).toBeNull(); // never retried by itself
    // Nothing may physically exist: a reprint needs no duplicate acknowledgement.
    await post(order, 'parcels/1/reprint', {
      printerId: printerA,
      reason: 'Tiskárna znovu připojena',
      acknowledgeDuplicate: false,
    }).expect(200);
    expect(await printOne(agentA.token)).not.toBeNull();
  });

  it('two claims at once never take the same job', async () => {
    const { order } = await picked(1);
    await completeAndPrint(order, printerA).expect(200);
    const all = await Promise.all([claim(agentA.token), claim(agentA.token), claim(agentA.token)]);
    expect(all.filter((j) => j !== null)).toHaveLength(1);
  });

  it('a lost result after a possible write is UNCERTAIN, never retried; one label reprinted alone', async () => {
    const { order } = await picked(3);
    await completeAndPrint(order, printerA).expect(200);
    await printOne(agentA.token); // parcel 1: sent
    const second = (await claim(agentA.token))!; // parcel 2: started, then no result
    await agent(agentA.token)
      .post(`jobs/${second.id}/start`, { claimToken: second.claimToken })
      .expect(200);
    await t.prisma
      .$executeRaw`UPDATE "print_jobs" SET "lease_until" = now() - interval '1 second' WHERE "id" = ${second.id}::uuid`;
    await queue().sweep();
    await printOne(agentA.token); // parcel 3: sent
    expect(await claim(agentA.token)).toBeNull(); // the uncertain one is NOT retried
    const s = await view(order);
    const uncertain = s.shipment!.parcels.find((p) => p.printJobs[0]!.status === 'UNCERTAIN')!;
    expect(uncertain).toBeDefined();
    // Re-printing it: the risk of a physical duplicate must be acknowledged.
    const refused = await post(order, `parcels/${uncertain.parcelNo}/reprint`, {
      printerId: printerA,
      reason: 'Štítek nevyjel',
      acknowledgeDuplicate: false,
    });
    expect([refused.status, refused.body.code]).toEqual([409, 'DUPLICATE_RISK']);
    await post(order, `parcels/${uncertain.parcelNo}/reprint`, {
      printerId: printerA,
      reason: 'Štítek nevyjel',
      acknowledgeDuplicate: true,
    }).expect(200);
    // Only that parcel got a new job — the others are untouched, nothing new at the carrier.
    const jobs = await jobsOf(order);
    expect(jobs.filter((j) => j.parcel.parcelNo === uncertain.parcelNo)).toHaveLength(2);
    expect(jobs.filter((j) => j.parcel.parcelNo !== uncertain.parcelNo)).toHaveLength(2);
    expect(testCarrierControl.calls).toHaveLength(1);
    const reprint = (await printOne(agentA.token))!;
    expect(reprint.job.id).not.toBe(second.id);
    // A truthful late report of the first attempt is recorded too.
    await agent(agentA.token)
      .post(`jobs/${second.id}/result`, {
        claimToken: second.claimToken,
        outcome: 'SENT',
        detail: 'pozdě',
      })
      .expect(200);
    const events = await t.prisma.printJobEvent.findMany({ where: { jobId: second.id } });
    expect(events.map((e) => e.status)).toContain('LATE_REPORT');
    // A second reprint while one is on its way is refused.
    const other = s.shipment!.parcels.find((p) => p.parcelNo !== uncertain.parcelNo)!;
    const body = {
      printerId: printerA,
      reason: 'Poškozený štítek',
      acknowledgeDuplicate: true,
    };
    await post(order, `parcels/${other.parcelNo}/reprint`, body).expect(200);
    const busy = await post(order, `parcels/${other.parcelNo}/reprint`, body);
    expect([busy.status, busy.body.code]).toEqual([409, 'PRINT_IN_PROGRESS']);
  });

  it('cancelling the shipment stops waiting jobs; printed labels must be destroyed; new labels later', async () => {
    const { order } = await picked(3);
    await completeAndPrint(order, printerA).expect(200);
    await printOne(agentA.token); // one label physically out
    const claimed = (await claim(agentA.token))!; // one taken, not started
    const s = (await view(order)).shipment!;
    const oldLabels = await t.prisma.shipmentLabel.findMany({
      where: { shipment: { code: s.code } },
    });
    await post(order, 'cancel', { reason: 'Hotel změnil termín' }).expect(200);
    // The claimed job may not start any more; the waiting one is cancelled.
    const start = await agent(agentA.token).post(`jobs/${claimed.id}/start`, {
      claimToken: claimed.claimToken,
    });
    expect([start.status, start.body.code]).toEqual([409, 'JOB_NOT_STARTABLE']);
    expect(await claim(agentA.token)).toBeNull();
    expect((await jobsOf(order)).map((j) => j.status).sort()).toEqual([
      'CANCELLED',
      'CANCELLED',
      'SENT',
    ]);
    expect((await detail(order)).history.map((h) => h.type)).toContain('PRINT_JOBS_CANCELLED');
    const done = (await view(order)).cancelled.find((c) => c.code === s.code)!;
    expect(done.labelsToDestroy).toHaveLength(1);
    // A new preparation: new labels, new jobs — never the cancelled shipment's files.
    const next = ((await completeAndPrint(order, printerA).expect(200)).body as OrderShipment)
      .shipment!;
    expect(next.code).not.toBe(s.code);
    const newJobs = (await jobsOf(order)).filter((j) => j.shipmentId !== oldLabels[0]!.shipmentId);
    expect(newJobs).toHaveLength(3);
    expect(newJobs.every((j) => !oldLabels.some((l) => l.id === j.labelId))).toBe(true);
  });

  it('changing the default printer never redirects jobs already created', async () => {
    const { order } = await picked(2);
    await completeAndPrint(order, printerA).expect(200);
    await setDefault(printerB);
    expect((await view(order)).printer!.id).toBe(printerB);
    expect((await jobsOf(order)).every((j) => j.printerId === printerA)).toBe(true);
    expect(await claim(agentB.token)).toBeNull();
    expect(await printOne(agentA.token)).not.toBeNull();
    // The database itself keeps a job's printer.
    const job = (await jobsOf(order))[1]!;
    await expect(
      t.prisma
        .$executeRaw`UPDATE "print_jobs" SET "printer_id" = ${printerB}::uuid WHERE "id" = ${job.id}::uuid`,
    ).rejects.toThrow(/fixed at creation/);
  });

  it('another site: its printer and its agent are never used here', async () => {
    const other = (
      await http()
        .post(`/api/admin/sites/${OTHER_SITE}/printing/agents`)
        .send({ requestId: rid(), code: `RPI-X-${rid().slice(0, 4).toUpperCase()}`, name: 'Jinde' })
        .expect(200)
    ).body as PrintAgentToken;
    const saved = (
      await http()
        .post(`/api/admin/sites/${OTHER_SITE}/printing/printers`)
        .send(
          printerBody(
            {
              id: null,
              code: `ZD-X-${rid().slice(0, 4).toUpperCase()}`,
              name: 'Zebra jinde',
              agentId: other.agent.id,
              usbSerial: 'SERX1',
            },
            { dispatchDefault: true },
          ),
        )
        .expect(200)
    ).body as SitePrinting;
    const foreign = saved.printers[0]!.id;
    // A printer of this site cannot be attached to the other site's agent.
    const mixed = await http()
      .post(admin('/printers'))
      .send(
        printerBody({
          id: null,
          code: `ZD-M-${rid().slice(0, 4).toUpperCase()}`,
          name: 'Smíšená',
          agentId: other.agent.id,
          usbSerial: 'SERM1',
        }),
      );
    expect([mixed.status, mixed.body.code]).toEqual([422, 'AGENT_NOT_FOUND']);
    const { order } = await picked(1);
    await completeAndPrint(order, null).expect(200);
    const res = await post(order, 'print', { printerId: foreign });
    expect([res.status, res.body.code]).toEqual([404, 'PRINTER_NOT_FOUND']);
    expect(await claim(other.token!)).toBeNull();
    // Printing on this site's printer works; the other site's agent still sees nothing of it.
    await post(order, 'print', { printerId: printerA }).expect(200);
    expect(await claim(other.token!)).toBeNull();
    const again = await post(order, 'print', { printerId: printerA });
    expect([again.status, again.body.code]).toEqual([409, 'PRINT_EXISTS']);
  });

  it('review: a reprint never races a waiting print; exhausted ZPL fetches stop; no auto-print off', async () => {
    const { order } = await picked(2);
    testCarrierControl.variant = ['FAIL'];
    await completeAndPrint(order, printerA).expect(200);
    // The shipment's print waits for its ZPL: a re-print of a parcel would print it twice.
    const reprint = await post(order, 'parcels/1/reprint', {
      printerId: printerA,
      reason: 'Druhý štítek',
      acknowledgeDuplicate: true,
    });
    expect([reprint.status, reprint.body.code]).toEqual([409, 'PRINT_IN_PROGRESS']);
    // A fetch whose attempts ran out ends for a person — no endless format changes at the carrier.
    const calls = testCarrierControl.variantCalls;
    await t.prisma
      .$executeRaw`UPDATE "shipment_label_fetches" SET "attempts" = 10, "next_at" = now() WHERE "shipment_id" = (SELECT "id" FROM "shipments" WHERE "order_id" = (SELECT "id" FROM "orders" WHERE "code" = ${order}) AND "status" = 'LABELED')`;
    await flow().variantsDue(20);
    expect(testCarrierControl.variantCalls).toBe(calls);
    expect((await view(order)).shipment!.zpl).toMatchObject({ status: 'FAILED' });
    // "Získat ZPL znovu" starts a fresh, bounded round; the waiting print then goes on.
    await post(order, 'zpl/retry').expect(200);
    expect(await jobsOf(order)).toHaveLength(2);
    // Automatic printing switched off: the combined action never prints on that printer.
    const p = await t.prisma.printer.findUniqueOrThrow({ where: { id: printerA } });
    await http()
      .post(admin('/printers'))
      .send(
        printerBody(
          { id: p.id, code: p.code, name: p.name, agentId: p.agentId, usbSerial: p.usbSerial },
          { dispatchDefault: true, autoPrint: false },
        ),
      )
      .expect(200);
    const second = await picked(1);
    const off = await completeAndPrint(second.order, printerA);
    expect([off.status, off.body.code]).toEqual([409, 'PRINTER_CHANGED']);
  });

  it('review: a printer disabled or an agent revoked cancels its waiting jobs; printing again is possible', async () => {
    const { order } = await picked(2);
    await completeAndPrint(order, printerA).expect(200);
    const p = await t.prisma.printer.findUniqueOrThrow({ where: { id: printerA } });
    await http()
      .post(admin('/printers'))
      .send(
        printerBody(
          { id: p.id, code: p.code, name: p.name, agentId: p.agentId, usbSerial: p.usbSerial },
          { dispatchDefault: false, enabled: false },
        ),
      )
      .expect(200);
    expect((await jobsOf(order)).map((j) => j.status)).toEqual(['CANCELLED', 'CANCELLED']);
    expect(await claim(agentA.token)).toBeNull();
    // Cancelled jobs do not block printing on another printer.
    await post(order, 'print', { printerId: printerB }).expect(200);
    expect((await jobsOf(order)).filter((j) => j.status === 'QUEUED')).toHaveLength(2);
    // The other agent revoked: its printer disabled, its waiting jobs cancelled.
    const extra = (
      await http()
        .post(admin('/agents'))
        .send({
          requestId: rid(),
          code: `RPI-V-${rid().slice(0, 4).toUpperCase()}`,
          name: 'Zrušený',
        })
        .expect(200)
    ).body as PrintAgentToken;
    const moved = await t.prisma.printer.findUniqueOrThrow({ where: { id: printerB } });
    await http()
      .post(admin('/printers'))
      .send(
        printerBody(
          {
            id: moved.id,
            code: moved.code,
            name: moved.name,
            agentId: extra.agent.id,
            usbSerial: moved.usbSerial,
          },
          { dispatchDefault: false },
        ),
      )
      .expect(200);
    // Moving the printer to another agent never hands it the old agent's jobs.
    expect((await jobsOf(order)).every((j) => j.status === 'CANCELLED')).toBe(true);
    await http()
      .post(admin(`/agents/${extra.agent.id}/revoke`))
      .send({ requestId: rid(), reason: 'Zařízení vyřazeno' })
      .expect(200);
    expect((await t.prisma.printer.findUniqueOrThrow({ where: { id: printerB } })).enabled).toBe(
      false,
    );
    // Restore for the other tests (printer B back on its own agent).
    await http()
      .post(admin('/printers'))
      .send(
        printerBody(
          {
            id: moved.id,
            code: moved.code,
            name: moved.name,
            agentId: agentB.id,
            usbSerial: moved.usbSerial,
          },
          { dispatchDefault: false },
        ),
      )
      .expect(200);
    await setDefault(printerA);
  });

  it('PRINT38-R2: a shipment labelled before doc 030 (PDF only, no ZPL fetch) prints after fetching its ZPL', async () => {
    const { order } = await picked(2);
    testCarrierControl.variant = ['FAIL'];
    await completeAndPrint(order, null).expect(200);
    // The legacy state: labelled with PDF, no ZPL and no fetch at all (test-only removal).
    await t.prisma.$transaction([
      t.prisma.$executeRawUnsafe(
        'ALTER TABLE "shipment_label_fetches" DISABLE TRIGGER "shipment_label_fetches_no_delete"',
      ),
      t.prisma
        .$executeRaw`DELETE FROM "shipment_label_fetches" WHERE "shipment_id" IN (SELECT s."id" FROM "shipments" s JOIN "orders" o ON o."id" = s."order_id" WHERE o."code" = ${order})`,
      t.prisma.$executeRawUnsafe(
        'ALTER TABLE "shipment_label_fetches" ENABLE TRIGGER "shipment_label_fetches_no_delete"',
      ),
    ]);
    const legacy = (await view(order)).shipment!;
    expect([legacy.status, legacy.zpl]).toEqual(['LABELED', null]);
    expect(legacy.parcels.every((p) => p.labels.map((l) => l.format).join() === 'PDF')).toBe(true);
    const calls = testCarrierControl.calls.length;
    // "Tisknout": the missing ZPL is fetched from the SAME shipment, then the jobs follow.
    const id = rid();
    const printed = (
      (await post(order, 'print', { printerId: printerA, requestId: id }).expect(200))
        .body as OrderShipment
    ).shipment!;
    expect(printed.zpl).toMatchObject({ status: 'DONE', dpi: 203 });
    expect(printed.printWaiting).toEqual([]);
    expect(await jobsOf(order)).toHaveLength(2);
    expect(testCarrierControl.calls).toHaveLength(calls); // no new shipment
    // The same click again (a lost answer): nothing more.
    await post(order, 'print', { printerId: printerA, requestId: id }).expect(200);
    expect(await jobsOf(order)).toHaveLength(2);
    expect(
      await t.prisma.shipmentLabelFetch.count({ where: { shipment: { order: { code: order } } } }),
    ).toBe(1);
    // A reload shows the same truth.
    expect((await view(order)).shipment!.zpl).toMatchObject({ status: 'DONE' });
  });

  it('PRINT38-R3: another USB device for the printer cancels unsent work (audited); a new print goes to it', async () => {
    const { order } = await picked(3);
    await completeAndPrint(order, printerA).expect(200);
    await printOne(agentA.token); // parcel 1: SENT
    const claimed = (await claim(agentA.token))!; // parcel 2: CLAIMED (not started)
    const sending = (await claim(agentA.token))!; // parcel 3: SENDING
    await agent(agentA.token)
      .post(`jobs/${sending.id}/start`, { claimToken: sending.claimToken })
      .expect(200);
    const p = await t.prisma.printer.findUniqueOrThrow({ where: { id: printerA } });
    const newSerial = `NEW${rid().slice(0, 6).toUpperCase()}`;
    await http()
      .post(admin('/printers'))
      .send(
        printerBody(
          { id: p.id, code: p.code, name: p.name, agentId: p.agentId, usbSerial: newSerial },
          { dispatchDefault: true },
        ),
      )
      .expect(200);
    const byId = new Map((await jobsOf(order)).map((j) => [j.id, j.status]));
    expect(byId.get(claimed.id)).toBe('CANCELLED'); // never sent to the other device
    expect(byId.get(sending.id)).toBe('SENDING'); // already on its way: not called safe
    // The claimed job may not start any more.
    const start = await agent(agentA.token).post(`jobs/${claimed.id}/start`, {
      claimToken: claimed.claimToken,
    });
    expect([start.status, start.body.code]).toEqual([409, 'JOB_NOT_STARTABLE']);
    const audit = await t.prisma.auditEvent.findFirstOrThrow({
      where: { type: 'PRINTER_SAVED' },
      orderBy: { occurredAt: 'desc' },
    });
    expect(audit.payload).toMatchObject({ usbSerialChanged: true, cancelledJobs: 1 });
    // The cancelled parcel is printed again explicitly — now on the new device.
    await post(order, 'parcels/2/reprint', {
      printerId: printerA,
      reason: 'Tiskárna vyměněna',
      acknowledgeDuplicate: false,
    }).expect(200);
    const job = (await claim(agentA.token))!;
    expect(job.usbSerial).toBe(newSerial);
    // Restore the serial for the other tests.
    await http()
      .post(admin('/printers'))
      .send(
        printerBody(
          { id: p.id, code: p.code, name: p.name, agentId: p.agentId, usbSerial: p.usbSerial },
          { dispatchDefault: true },
        ),
      )
      .expect(200);
  });

  it('the database keeps the queue honest even without the API', async () => {
    const { order } = await picked(1);
    await completeAndPrint(order, printerA).expect(200);
    const job = (await jobsOf(order))[0]!;
    // No skipping states.
    await expect(
      t.prisma
        .$executeRaw`UPDATE "print_jobs" SET "status" = 'SENT', "finished_at" = now(), "started_at" = now() WHERE "id" = ${job.id}::uuid`,
    ).rejects.toThrow(/not allowed/);
    const copy = (over: object) => {
      const rest: Record<string, unknown> = { ...job };
      delete rest.parcel;
      delete rest.id;
      return t.prisma.printJob.create({
        data: {
          ...(rest as Omit<typeof job, 'parcel' | 'id'>),
          serial: job.serial + 1_000_000n,
          code: `PRJ-${job.serial + 1_000_000n}`,
          ...over,
        },
      });
    };
    // No second active job of the same parcel.
    await expect(copy({})).rejects.toThrow();
    // A job prints only the stored ZPL of its own parcel — never the PDF.
    const pdf = await t.prisma.shipmentLabel.findFirstOrThrow({
      where: { parcelId: job.parcelId, format: 'PDF' },
    });
    await queue().cancelJob(
      t.prisma as never,
      job.id,
      (await t.prisma.user.findFirstOrThrow()).id,
      'test',
      new Date(),
    );
    await expect(
      copy({ labelId: pdf.id, fileKey: pdf.fileKey, sha256: pdf.sha256, sizeBytes: pdf.sizeBytes }),
    ).rejects.toThrow(/stored ZPL of its own parcel/);
    // A finished job never changes; its history is append-only.
    await expect(
      t.prisma.$executeRaw`UPDATE "print_jobs" SET "detail" = 'x' WHERE "id" = ${job.id}::uuid`,
    ).rejects.toThrow(/never changes/);
    await expect(
      t.prisma.$executeRaw`DELETE FROM "print_job_events" WHERE "job_id" = ${job.id}::uuid`,
    ).rejects.toThrow();
  });
});
