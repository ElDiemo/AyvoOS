import { randomUUID } from 'node:crypto';
import type {
  BottleDetail,
  OrderDetail,
  ReturnBottleScanResult,
  ReturnCrateScanResult,
  ReturnReceiptDetail,
} from '@ayvo/types';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { testCarrierControl } from '../src/carriers/test-carrier.js';
import { fillingSession, fillLoadCrate } from './support/labeling-fixtures.js';
import { crateFactory, createHotel, type MadeCrate } from './support/order-fixtures.js';
import {
  deliver,
  pickUp,
  RETURN_ENV,
  returnsApi,
  shipCrates,
  type ShippedOrder,
} from './support/return-fixtures.js';
import { createTestApp, hasDatabase, type TestApp, withPrivileged } from './support/test-app.js';

type Factory = Awaited<ReturnType<typeof crateFactory>>;

/**
 * Return intake R1 (doc 047 §4) against the real database: crates delivered by the FAKE test
 * carrier, then scanned back, bottles identified one by one, issues committed with their
 * refusals, Vyprázdněno, the crate's next circulation, the order's history — and the database
 * guards, also by direct SQL that commits.
 */
describe.skipIf(!hasDatabase)('return intake R1 (doc 047)', () => {
  let t: TestApp;
  let factory: Factory;
  let hotel: string;
  let api: ReturnType<typeof returnsApi>;
  const http = () => request(t.app.getHttpServer());

  const delivered = async (n = 1): Promise<{ crates: MadeCrate[]; shipped: ShippedOrder }> => {
    const crates: MadeCrate[] = [];
    for (let i = 0; i < n; i++) crates.push(await factory.make());
    const shipped = await shipCrates(t, hotel, factory.kit.productCode, crates);
    await deliver(t, shipped);
    return { crates, shipped };
  };
  const cycleOf = (crateCode: string, status?: string) =>
    t.prisma.crateCycle.findFirstOrThrow({
      where: { crate: { code: crateCode }, ...(status ? { status: status as never } : {}) },
      orderBy: { openedAt: 'desc' },
    });
  const bottle = (id: string) => t.prisma.bottle.findUniqueOrThrow({ where: { id } });
  const sortedOf = (bottleId: string) =>
    t.prisma.bottleEvent.findMany({ where: { bottleId, type: 'SORTED' }, orderBy: { id: 'asc' } });
  const reuse = async (code: string) =>
    ((await http().get(`/api/admin/bottles/${code}`).expect(200)).body as BottleDetail).reuseCycles;
  const lineOf = (d: ReturnReceiptDetail, crateCode: string | null) =>
    d.lineDetails.find((l) => l.crateCode === crateCode)!;
  const scanned = async (code: string, crateUrl: string) => {
    const r = await api.scanCrate(code, crateUrl);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    return r.body as ReturnCrateScanResult;
  };
  const ok = (r: request.Response) => {
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    return r.body as ReturnBottleScanResult;
  };
  const refused = (r: request.Response, status: number, code: string) =>
    expect([r.status, r.body.code], JSON.stringify(r.body)).toEqual([status, code]);

  beforeAll(async () => {
    t = await createTestApp(RETURN_ENV);
    factory = await crateFactory(t, { capacity: 2 });
    hotel = (await createHotel(t, { name: 'Hotel Vratky' })).code;
    api = returnsApi(t);
  });
  afterAll(async () => {
    testCarrierControl.reset();
    await t?.close();
  });
  beforeEach(() => {
    testCarrierControl.reset();
    testCarrierControl.rules.parcelWeight = 'NOT_USED';
  });

  it('a crate scan completes the delivered allocation; the order and its contents stay', async () => {
    const { crates, shipped } = await delivered();
    const [k] = crates as [MadeCrate];
    const before = (await http().get(`/api/admin/orders/${shipped.order}`).expect(200))
      .body as OrderDetail;
    const receipt = await api.open(hotel);
    const crate = await scanned(receipt.code, k.crateUrl);
    expect(crate).toMatchObject({ outcome: 'CRATE_RETURNED', crateCode: k.crateCode });

    const cycle = await cycleOf(k.crateCode);
    expect(cycle.status).toBe('RETURNED');
    expect(cycle.filledAt).not.toBeNull();
    expect([cycle.memberCount, cycle.filledCount]).toEqual([2, 2]);
    const allocation = await t.prisma.orderCrateAllocation.findFirstOrThrow({
      where: { cycleId: cycle.id },
      include: { bottles: true },
    });
    expect(allocation.releasedAt).toBeNull();
    expect(allocation.completedAt).not.toBeNull();
    expect(allocation.bottles.map((b) => b.bottleId).sort()).toEqual([...k.bottleIds].sort());
    // No bottle changes at the crate scan: the contents are never assumed.
    for (const id of k.bottleIds) {
      expect((await bottle(id)).status).toBe('FILLED');
      expect(await sortedOf(id)).toEqual([]);
    }
    const after = (await http().get(`/api/admin/orders/${shipped.order}`).expect(200))
      .body as OrderDetail;
    expect(after.status).toBe('DELIVERED');
    expect(after.lines).toEqual(before.lines);

    // A repeated crate scan in the same receipt is the first result; another receipt is refused.
    expect((await scanned(receipt.code, k.crateUrl)).outcome).toBe('ALREADY_SCANNED');
    const other = await api.open();
    refused(await api.scanCrate(other.code, k.crateUrl), 409, 'CRATE_ALREADY_RETURNED');
    // A returned, not yet emptied crate is refused at labelling (no new cycle, no production).
    const fs = await fillingSession(t, 'HAND_SOAP');
    refused(await fillLoadCrate(t, fs, k.crateUrl), 409, 'CRATE_RETURNED');
  });

  it('a mixed return: crate L still DELIVERED, its bottle identified in K; counts; Vyprázdněno; K again to O2; O1 unchanged', async () => {
    const { crates, shipped: o1 } = await delivered(2);
    const [k, l] = crates as [MadeCrate, MadeCrate];
    const receipt = await api.open(hotel);
    const kLine = (await scanned(receipt.code, k.crateUrl)).lineId;

    // K's first bottle good, L's first bottle defective — found in K's container.
    expect(ok(await api.scanBottle(receipt.code, kLine, k.bottleUrls[0]!))).toMatchObject({
      outcome: 'IDENTIFIED',
      repeated: false,
      result: 'RETURNED',
    });
    expect(
      ok(await api.scanBottle(receipt.code, kLine, l.bottleUrls[0]!, 'DEFECTIVE')),
    ).toMatchObject({ outcome: 'IDENTIFIED', result: 'RETIRED' });
    expect((await bottle(k.bottleIds[0]!)).status).toBe('RETURNED');
    expect((await bottle(l.bottleIds[0]!)).status).toBe('RETIRED');
    const lCycle = await cycleOf(l.crateCode);
    expect(lCycle.status).toBe('DELIVERED');
    expect([lCycle.memberCount, lCycle.filledCount]).toEqual([2, 2]);
    const lMembers = await t.prisma.crateAssignment.findMany({ where: { cycleId: lCycle.id } });
    expect(lMembers.filter((a) => a.releasedAt === null)).toHaveLength(1);
    expect(lMembers.filter((a) => a.releaseReason === 'RETURN_IDENTIFIED')).toHaveLength(1);
    // The SORTED names the bottle's delivered cycle and the line it was found in.
    const [lSorted] = await sortedOf(l.bottleIds[0]!);
    expect([lSorted!.crateCycleId, lSorted!.returnLineId]).toEqual([lCycle.id, kLine]);
    expect(await reuse((await bottle(k.bottleIds[0]!)).code)).toBe(1);

    const kCode = (await bottle(k.bottleIds[0]!)).code;
    expect(
      ((await http().get(`/api/admin/bottles/${kCode}`).expect(200)).body as BottleDetail)
        .returnReceipt,
    ).toBe(receipt.code);
    // An unreadable piece and a defective pump.
    expect((await api.unreadable(receipt.code, kLine)).status).toBe(200);
    expect((await api.pumps(receipt.code, 1)).status).toBe(200);

    let d = await api.detail(receipt.code);
    const line = lineOf(d, k.crateCode);
    expect(line.recordedCount).toBe(3);
    expect(line.history).toEqual({ shipped: 2, identified: 1, withoutConfirmedReturn: 1 });
    expect(d.defectivePumps).toBe(1);

    // Vyprázdněno with a physical count that differs: COUNT_MISMATCH, the crate still closes.
    d = (await api.empty(receipt.code, kLine, 4)).body as ReturnReceiptDetail;
    const emptied = lineOf(d, k.crateCode);
    expect(emptied.physicalCount).toBe(4);
    expect(emptied.issues.find((i) => i.kind === 'COUNT_MISMATCH')?.details).toEqual({
      physical: 4,
      recorded: 3,
    });
    const closed = await cycleOf(k.crateCode);
    expect(closed.status).toBe('CLOSED');
    expect(closed.filledAt).not.toBeNull();
    // After Vyprázdněno no scan goes into that line.
    refused(await api.scanBottle(receipt.code, kLine, k.bottleUrls[1]!), 409, 'LINE_EMPTIED');
    // K's never-identified bottle keeps its assignment of the closed cycle ("bez potvrzeného návratu").
    expect((await bottle(k.bottleIds[1]!)).status).toBe('FILLED');

    // The same crate K: a new cycle 2, filled, Hotovo, picked into O2, dispatched and delivered.
    const again = await factory.make('FILLED', undefined, k.crateUrl);
    expect(again.crateCode).toBe(k.crateCode);
    const cycles = await t.prisma.crateCycle.findMany({
      where: { crate: { code: k.crateCode } },
      orderBy: { openedAt: 'asc' },
    });
    expect(cycles.map((c) => c.status)).toEqual(['CLOSED', 'FILLED']);
    const o2 = await shipCrates(t, hotel, factory.kit.productCode, [again]);
    await deliver(t, o2);
    expect((await cycleOf(k.crateCode)).status).toBe('DELIVERED');

    // O1 still shows its original contents, its parcel and its delivery.
    const first = await t.prisma.orderCrateAllocation.findMany({
      where: { order: { code: o1.order } },
      include: {
        bottles: true,
        parcels: { include: { progress: true } },
        cycle: { select: { status: true } },
      },
      orderBy: { allocatedAt: 'asc' },
    });
    expect(first.map((a) => a.cycle.status)).toEqual(['CLOSED', 'DELIVERED']);
    expect(first.map((a) => a.bottles.length)).toEqual([2, 2]);
    expect(first.every((a) => a.parcels[0]!.progress!.deliveredAt !== null)).toBe(true);
    expect(first[0]!.bottles.map((b) => b.bottleId).sort()).toEqual([...k.bottleIds].sort());
    const o1Detail = (await http().get(`/api/admin/orders/${o1.order}`).expect(200))
      .body as OrderDetail;
    expect(o1Detail.status).toBe('DELIVERED');
  });

  it('repeated, late, duplicate, foreign and replayed scans', async () => {
    const { crates } = await delivered();
    const [k] = crates as [MadeCrate];
    const receipt = await api.open();
    const kLine = (await scanned(receipt.code, k.crateUrl)).lineId;
    const box = ((await api.container(receipt.code)).body as { lineId: string }).lineId;
    const rid = randomUUID();
    const first = ok(await api.scanBottle(receipt.code, kLine, k.bottleUrls[0]!, 'GOOD', rid));
    // The same request again: the stored response.
    expect(ok(await api.scanBottle(receipt.code, kLine, k.bottleUrls[0]!, 'GOOD', rid))).toEqual(
      first,
    );
    // The same requestId with another line or outcome: a conflict, nothing written.
    refused(
      await api.scanBottle(receipt.code, box, k.bottleUrls[0]!, 'GOOD', rid),
      409,
      'IDEMPOTENCY_CONFLICT',
    );
    // A new scan of the same bottle on the same line: the first result, no second event.
    expect(ok(await api.scanBottle(receipt.code, kLine, k.bottleUrls[0]!))).toMatchObject({
      outcome: 'IDENTIFIED',
      repeated: true,
    });
    refused(
      await api.scanBottle(receipt.code, kLine, k.bottleUrls[0]!, 'DEFECTIVE'),
      409,
      'ALREADY_RECEIVED',
    );
    // On another line it is a refusal for that line, never a success, nothing counted there.
    refused(
      await api.scanBottle(receipt.code, box, k.bottleUrls[0]!),
      409,
      'ALREADY_RECEIVED_ELSEWHERE',
    );
    expect(await sortedOf(k.bottleIds[0]!)).toHaveLength(1);
    expect(lineOf(await api.detail(receipt.code), null).recordedCount).toBe(0);
    // Foreign values and wrong kinds write nothing.
    refused(await api.scanBottle(receipt.code, kLine, 'https://example.com/x'), 422, 'NOT_AYVO_QR');
    refused(await api.scanBottle(receipt.code, kLine, k.crateUrl), 422, 'NOT_A_BOTTLE');
    // A late scan after the close goes nowhere.
    await api.empty(receipt.code, kLine, 1).expect(200);
    await api.empty(receipt.code, box, 0).expect(200);
    await api.close(receipt.code).expect(200);
    refused(await api.scanBottle(receipt.code, box, k.bottleUrls[1]!), 409, 'RECEIPT_CLOSED');
    refused(await api.unreadable(receipt.code, box), 409, 'RECEIPT_CLOSED');
    expect(await sortedOf(k.bottleIds[1]!)).toEqual([]);
    expect(await reuse((await bottle(k.bottleIds[0]!)).code)).toBe(1);
  });

  it('NOT_DELIVERED commits its issue with the refusal; a retry adds no second piece; resolved after the close', async () => {
    const m = await factory.make();
    const shipped = await shipCrates(t, hotel, factory.kit.productCode, [m]);
    await pickUp(t, shipped);
    expect((await cycleOf(m.crateCode)).status).toBe('DISPATCHED');
    const receipt = await api.open();
    const box = ((await api.container(receipt.code)).body as { lineId: string }).lineId;
    const rid = randomUUID();
    const first = ok(await api.scanBottle(receipt.code, box, m.bottleUrls[0]!, 'GOOD', rid));
    expect(first).toMatchObject({ outcome: 'ISSUE_RECORDED', code: 'NOT_DELIVERED' });
    expect(ok(await api.scanBottle(receipt.code, box, m.bottleUrls[0]!, 'GOOD', rid))).toEqual(
      first,
    );
    expect(ok(await api.scanBottle(receipt.code, box, m.bottleUrls[0]!))).toMatchObject({
      outcome: 'ISSUE_RECORDED',
      issue: first.issue,
    });
    const issues = await t.prisma.returnReceiptIssue.findMany({ where: { lineId: box } });
    expect(issues.map((i) => i.kind)).toEqual(['NOT_DELIVERED']);
    expect((await bottle(m.bottleIds[0]!)).status).toBe('FILLED');

    await api.empty(receipt.code, box, 1).expect(200);
    await api.close(receipt.code).expect(200);
    // Still not delivered: the resolution is refused and the issue stays open.
    refused(await api.identify(first.issue!.code, m.bottleUrls[0]!), 409, 'NOT_DELIVERED');
    await deliver(t, shipped);
    // The wrong bottle is refused; the right one resolves the issue on its (closed) line.
    refused(await api.identify(first.issue!.code, m.bottleUrls[1]!), 409, 'WRONG_BOTTLE');
    expect(ok(await api.identify(first.issue!.code, m.bottleUrls[0]!))).toMatchObject({
      outcome: 'IDENTIFIED',
      repeated: false,
      issue: first.issue,
    });
    const [sorted] = await sortedOf(m.bottleIds[0]!);
    expect(sorted!.returnLineId).toBe(box);
    const d = await api.detail(receipt.code);
    expect(d.state).toBe('CLOSED');
    expect(lineOf(d, null).recordedCount).toBe(1);
    expect(lineOf(d, null).issues.map((i) => i.resolution)).toEqual(['IDENTIFIED']);
    expect(await reuse((await bottle(m.bottleIds[0]!)).code)).toBe(1);
  });

  it('an unreadable piece resolved after the close by two operators at once: one SORTED', async () => {
    const { crates } = await delivered();
    const [k] = crates as [MadeCrate];
    const receipt = await api.open();
    const kLine = (await scanned(receipt.code, k.crateUrl)).lineId;
    const issue = ((await api.unreadable(receipt.code, kLine)).body as { issue: { code: string } })
      .issue.code;
    await api.empty(receipt.code, kLine, 1).expect(200);
    await api.close(receipt.code).expect(200);
    const [a, b] = await Promise.all([
      api.identify(issue, k.bottleUrls[0]!),
      api.identify(issue, k.bottleUrls[0]!),
    ]);
    const results = [a, b].map((r) => [r.status, r.body.repeated ?? r.body.code]);
    expect(results).toEqual(expect.arrayContaining([[200, false]]));
    expect(results.filter(([s, x]) => s === 200 && x === false)).toHaveLength(1);
    expect(await sortedOf(k.bottleIds[0]!)).toHaveLength(1);
    expect(lineOf(await api.detail(receipt.code), k.crateCode).recordedCount).toBe(1);
  });

  it('on the same line: a rescan and IDENTIFIED of the same issue at once — no deadlock, one SORTED (both orders)', async () => {
    for (const order of ['scan-first', 'identify-first'] as const) {
      const m = await factory.make();
      const shipped = await shipCrates(t, hotel, factory.kit.productCode, [m]);
      await pickUp(t, shipped);
      const receipt = await api.open();
      const box = ((await api.container(receipt.code)).body as { lineId: string }).lineId;
      const issue = ok(await api.scanBottle(receipt.code, box, m.bottleUrls[0]!)).issue!.code;
      await deliver(t, shipped);
      // Hold the bottle row so both requests are inside their transactions before either runs on.
      const [res] = await withPrivileged((db) =>
        db.$transaction(async (tx) => {
          await tx.$executeRaw`SELECT 1 FROM "bottles" WHERE "id" = ${m.bottleIds[0]!}::uuid FOR UPDATE`;
          const scan = () => api.scanBottle(receipt.code, box, m.bottleUrls[0]!);
          const identify = () => api.identify(issue, m.bottleUrls[0]!);
          const pending =
            order === 'scan-first'
              ? [scan().then((r) => r), identify().then((r) => r)]
              : [identify().then((r) => r), scan().then((r) => r)];
          await new Promise((r) => setTimeout(r, 400));
          return [pending] as const;
        }),
      );
      const done = await Promise.all(res);
      for (const r of done) {
        expect([200, 409], JSON.stringify(r.body)).toContain(r.status);
        if (r.status === 409) expect(r.body.code).toBe('ISSUE_RESOLVED');
      }
      // The second gets the result already written for the same issue, bottle and outcome.
      expect(done.map((r) => [r.status, r.body.repeated]).sort()).toEqual([
        [200, false],
        [200, true],
      ]);
      const sorted = await sortedOf(m.bottleIds[0]!);
      expect(sorted).toHaveLength(1);
      expect(sorted[0]!.resolvesIssueId).not.toBeNull();
    }
  });

  it('two operators scan the same bottle on two lines at once: one identification', async () => {
    const { crates } = await delivered();
    const [k] = crates as [MadeCrate];
    const receipt = await api.open();
    const kLine = (await scanned(receipt.code, k.crateUrl)).lineId;
    const box = ((await api.container(receipt.code)).body as { lineId: string }).lineId;
    const [a, b] = await Promise.all([
      api.scanBottle(receipt.code, kLine, k.bottleUrls[0]!),
      api.scanBottle(receipt.code, box, k.bottleUrls[0]!),
    ]);
    const answers = [a, b].map((r) => (r.status === 200 ? 'OK' : r.body.code));
    expect(answers.filter((x) => x === 'OK')).toHaveLength(1);
    expect(['ALREADY_RECEIVED_ELSEWHERE', 'CONCURRENT_CHANGE']).toContain(
      answers.find((x) => x !== 'OK'),
    );
    expect(await sortedOf(k.bottleIds[0]!)).toHaveLength(1);
  });

  it('a scan racing Vyprázdněno and the close: either counted on the line or refused', async () => {
    const { crates } = await delivered();
    const [k] = crates as [MadeCrate];
    const receipt = await api.open();
    const kLine = (await scanned(receipt.code, k.crateUrl)).lineId;
    const [scan, empty] = await Promise.all([
      api.scanBottle(receipt.code, kLine, k.bottleUrls[0]!),
      api.empty(receipt.code, kLine, 1),
    ]);
    expect(empty.status).toBe(200);
    const d = await api.detail(receipt.code);
    const line = lineOf(d, k.crateCode);
    if (scan.status === 200) {
      expect(line.bottles).toHaveLength(1);
    } else {
      expect(scan.body.code).toBe('LINE_EMPTIED');
      expect(line.bottles).toHaveLength(0);
      expect(line.issues.map((i) => i.kind)).toEqual(['COUNT_MISMATCH']);
    }
    const [scan2, close] = await Promise.all([
      api.scanBottle(receipt.code, kLine, k.bottleUrls[1]!),
      api.close(receipt.code),
    ]);
    expect(close.status).toBe(200);
    expect(scan2.body.code).toMatch(/^(LINE_EMPTIED|RECEIPT_CLOSED)$/);
    expect(await sortedOf(k.bottleIds[1]!)).toEqual([]);
  });

  it('a bottle assigned after the line was opened cannot be in it; not in circulation is an issue', async () => {
    const receipt = await api.open();
    const box = ((await api.container(receipt.code)).body as { lineId: string }).lineId;
    const fresh = await factory.make();
    refused(await api.scanBottle(receipt.code, box, fresh.bottleUrls[0]!), 409, 'NOT_IN_THIS_LINE');
    // A filled bottle in a FILLED (not yet ordered) crate is assigned before a newer line: not in
    // circulation at a hotel → the issue is committed with the answer.
    const later = ((await api.container(receipt.code)).body as { lineId: string }).lineId;
    expect(ok(await api.scanBottle(receipt.code, later, fresh.bottleUrls[0]!))).toMatchObject({
      outcome: 'ISSUE_RECORDED',
      code: 'NOT_IN_CIRCULATION',
    });
    expect((await bottle(fresh.bottleIds[0]!)).status).toBe('FILLED');
  });

  describe('database guards (direct SQL that commits)', () => {
    const fails = (p: Promise<unknown>, message: RegExp) => expect(p).rejects.toThrow(message);

    it('a delivered cycle never jumps to CLOSED or RETURNED by SQL alone, and keeps its filling date', async () => {
      const { crates } = await delivered();
      const cycle = await cycleOf(crates[0]!.crateCode);
      await withPrivileged(async (db) => {
        await fails(
          db.$executeRaw`UPDATE "crate_cycles" SET "status" = 'CLOSED' WHERE "id" = ${cycle.id}::uuid`,
          /changes only DELIVERED → RETURNED → CLOSED/,
        );
        await fails(
          db.$executeRaw`UPDATE "crate_cycles" SET "filled_at" = now() WHERE "id" = ${cycle.id}::uuid`,
          /changes only DELIVERED → RETURNED → CLOSED/,
        );
        // RETURNED without a crate line and a completed allocation fails at commit.
        await fails(
          db.$executeRaw`UPDATE "crate_cycles" SET "status" = 'RETURNED' WHERE "id" = ${cycle.id}::uuid`,
          /RETURNED or CLOSED exactly when its allocation is completed|ALLOCATED exactly while an order holds it/,
        );
        // A completion without its own line, or of an undelivered allocation, is refused.
        await fails(
          db.$executeRaw`UPDATE "order_crate_allocations" SET "completed_at" = now(),
            "completed_by" = "allocated_by", "completed_line_id" = uuidv7()
            WHERE "cycle_id" = ${cycle.id}::uuid`,
          /completed, by its own crate line|foreign key/,
        );
        // A bottle never leaves a shipped crate except by its SORTED.
        await fails(
          db.$executeRaw`UPDATE "crate_assignments" SET "released_at" = now(), "released_by" = "assigned_by",
            "release_reason" = 'RETURN_IDENTIFIED', "release_operation_id" = "operation_request_id"
            WHERE "cycle_id" = ${cycle.id}::uuid AND "released_at" IS NULL`,
          /only by its SORTED/,
        );
        await fails(
          db.$executeRaw`UPDATE "crate_assignments" SET "released_at" = now(), "released_by" = "assigned_by",
            "release_reason" = 'REMOVED', "release_operation_id" = "operation_request_id"
            WHERE "cycle_id" = ${cycle.id}::uuid AND "released_at" IS NULL`,
          /only by its SORTED/,
        );
      });
      expect((await cycleOf(crates[0]!.crateCode)).status).toBe('DELIVERED');
    });

    it('RETURNED → CLOSED needs the emptied line; an emptied line needs CLOSED; a RETURNED crate opens no new cycle', async () => {
      const { crates } = await delivered();
      const [k] = crates as [MadeCrate];
      const receipt = await api.open();
      const kLine = (await scanned(receipt.code, k.crateUrl)).lineId;
      const cycle = await cycleOf(k.crateCode);
      await withPrivileged(async (db) => {
        await fails(
          db.$executeRaw`UPDATE "crate_cycles" SET "status" = 'CLOSED' WHERE "id" = ${cycle.id}::uuid`,
          /CLOSED cycle needs its emptied line|CLOSED exactly when the line is emptied/,
        );
        await fails(
          db.$executeRaw`UPDATE "return_receipt_lines" SET "emptied_at" = now(), "emptied_by" = "scanned_by",
            "empty_operation_id" = "scan_operation_id", "physical_count" = 0 WHERE "id" = ${kLine}::uuid`,
          /CLOSED exactly when the line is emptied/,
        );
        await fails(
          db.$executeRaw`INSERT INTO "crate_cycles" ("crate_id", "site_id", "status", "crate_type_id", "capacity",
              "product_id", "category_code", "recipe_version_id", "label_template_version_id", "opened_by", "open_operation_id")
            SELECT "crate_id", "site_id", 'OPEN_ASSEMBLY', "crate_type_id", "capacity", "product_id", "category_code",
              "recipe_version_id", "label_template_version_id", "opened_by", "open_operation_id"
            FROM "crate_cycles" WHERE "id" = ${cycle.id}::uuid`,
          /crate_cycles_one_open_per_crate/,
        );
      });
      // The API path closes it; then the closed cycle never changes again.
      await api.empty(receipt.code, kLine, 0).expect(200);
      await withPrivileged(async (db) => {
        await fails(
          db.$executeRaw`UPDATE "crate_cycles" SET "status" = 'RETURNED' WHERE "id" = ${cycle.id}::uuid`,
          /closed crate cycle never changes/,
        );
      });
      const closed = await cycleOf(k.crateCode);
      expect([closed.status, closed.filledAt?.getTime()]).toEqual([
        'CLOSED',
        cycle.filledAt?.getTime(),
      ]);
      const events = await t.prisma.crateEvent.findMany({
        where: { cycleId: cycle.id, type: { in: ['RETURNED', 'EMPTIED'] } },
        orderBy: { occurredAt: 'asc' },
      });
      expect(events.map((e) => e.type)).toEqual(['RETURNED', 'EMPTIED']);
    });

    it('SORTED once per cycle; a disposed bottle never changes; a correction only for a retirement at the return', async () => {
      const { crates } = await delivered();
      const [k] = crates as [MadeCrate];
      const receipt = await api.open();
      const kLine = (await scanned(receipt.code, k.crateUrl)).lineId;
      ok(await api.scanBottle(receipt.code, kLine, k.bottleUrls[0]!, 'DEFECTIVE'));
      ok(await api.scanBottle(receipt.code, kLine, k.bottleUrls[1]!, 'GOOD'));
      const [sorted] = await sortedOf(k.bottleIds[0]!);
      await withPrivileged(async (db) => {
        await fails(
          db.$executeRaw`INSERT INTO "bottle_events" ("bottle_id", "type", "occurred_at", "actor_id", "crate_cycle_id",
              "return_line_id", "operation_request_id", "payload")
            SELECT "bottle_id", 'SORTED', now(), "actor_id", "crate_cycle_id", "return_line_id", "operation_request_id", "payload"
            FROM "bottle_events" WHERE "id" = ${sorted!.id}::uuid`,
          /SORTED identifies a delivered member|bottle_events_one_sorted_per_cycle/,
        );
        // RETIRED → RETURNED by a CORRECTION of the retirement documented at the return.
        await db.$transaction(async (tx) => {
          await tx.$executeRaw`INSERT INTO "bottle_events" ("bottle_id", "type", "occurred_at", "actor_id", "operation_request_id", "payload")
            VALUES (${k.bottleIds[0]!}::uuid, 'CORRECTION', now(), ${sorted!.actorId}::uuid, ${sorted!.operationRequestId}::uuid,
              '{"reason":"vada se nepotvrdila"}')`;
          await tx.$executeRaw`UPDATE "bottles" SET "status" = 'RETURNED' WHERE "id" = ${k.bottleIds[0]!}::uuid`;
        });
        // A good bottle cannot be "corrected" (it was never retired at the return).
        await fails(
          db.$executeRaw`INSERT INTO "bottle_events" ("bottle_id", "type", "occurred_at", "actor_id", "operation_request_id", "payload")
            VALUES (${k.bottleIds[1]!}::uuid, 'CORRECTION', now(), ${sorted!.actorId}::uuid, ${sorted!.operationRequestId}::uuid,
              '{"reason":"x"}')`,
          /reverses only a retirement documented at the return/,
        );
        // RETURNED → RETIRED → DISPOSED; then nothing changes the bottle, no later event.
        await db.$transaction(async (tx) => {
          await tx.$executeRaw`INSERT INTO "bottle_events" ("bottle_id", "type", "occurred_at", "actor_id", "operation_request_id", "payload")
            VALUES (${k.bottleIds[1]!}::uuid, 'RETIRED', now(), ${sorted!.actorId}::uuid, ${sorted!.operationRequestId}::uuid,
              '{"reason":"prasklina"}')`;
          await tx.$executeRaw`UPDATE "bottles" SET "status" = 'RETIRED' WHERE "id" = ${k.bottleIds[1]!}::uuid`;
        });
        await db.$transaction(async (tx) => {
          await tx.$executeRaw`INSERT INTO "bottle_events" ("bottle_id", "type", "occurred_at", "actor_id", "operation_request_id")
            VALUES (${k.bottleIds[1]!}::uuid, 'DISPOSED', now(), ${sorted!.actorId}::uuid, ${sorted!.operationRequestId}::uuid)`;
          await tx.$executeRaw`UPDATE "bottles" SET "status" = 'DISPOSED' WHERE "id" = ${k.bottleIds[1]!}::uuid`;
        });
        await fails(
          db.$executeRaw`UPDATE "bottles" SET "status" = 'RETURNED' WHERE "id" = ${k.bottleIds[1]!}::uuid`,
          /DISPOSED → RETURNED is not allowed/,
        );
        await fails(
          db.$executeRaw`INSERT INTO "bottle_events" ("bottle_id", "type", "occurred_at", "actor_id", "operation_request_id", "payload")
            VALUES (${k.bottleIds[1]!}::uuid, 'CORRECTION', now(), ${sorted!.actorId}::uuid, ${sorted!.operationRequestId}::uuid, '{"reason":"x"}')`,
          /disposed bottle has no later event/,
        );
        // A status without its event fails at commit.
        await fails(
          db.$executeRaw`UPDATE "bottles" SET "status" = 'RETIRED' WHERE "id" = ${k.bottleIds[0]!}::uuid`,
          /needs its event/,
        );
      });
      expect((await bottle(k.bottleIds[1]!)).status).toBe('DISPOSED');
    });
  });
});
