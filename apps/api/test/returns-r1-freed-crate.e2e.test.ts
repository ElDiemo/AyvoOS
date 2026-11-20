import { randomUUID } from 'node:crypto';
import type { BottleDetail, ReturnBottleScanResult } from '@ayvo/types';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { testCarrierControl } from '../src/carriers/test-carrier.js';
import {
  correctCrate,
  fillingSession,
  fillLoadCrate,
  finishCrate,
} from './support/labeling-fixtures.js';
import {
  scanCrate as allocateCrate,
  cancelOrder,
  crateFactory,
  createHotel,
  createOrder,
  type MadeCrate,
} from './support/order-fixtures.js';
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
type Db = { $executeRaw: TestApp['prisma']['$executeRaw'] };

/**
 * An R1 NOT_DELIVERED after its crate was freed by a later R1.1 receipt (doc 047 §6.3 6,
 * doc 070 §4.1). A receipt of the previous image is still open: its container line holds an
 * unanchored NOT_DELIVERED of F1, recorded while F was only picked up. F is delivered; a new
 * receipt scans crate F (frees it, F1 released CRATE_RETURNED). Before this fix F1 was stuck: the
 * new receipt refused it (OPEN_ISSUE) and "Dořešit" on the old line answered NOT_IN_CIRCULATION.
 *
 * Expected: the new receipt still refuses F1 and names the open issue; "Dořešit" of that issue
 * identifies F1 in exactly the circulation it was recorded in (F's delivered cycle), on the old
 * line, and resolves the issue; afterwards the new receipt answers ALREADY_RECEIVED_ELSEWHERE.
 * One SORTED per circulation — also when the scan, the crate scan and "Dořešit" race. Any other
 * issue (recorded after the crate was freed, another kind) keeps R1's answer, also by direct SQL.
 */
describe.skipIf(!hasDatabase)('an R1 NOT_DELIVERED whose crate a later receipt freed', () => {
  let t: TestApp;
  let factory: Factory;
  let hotel: string;
  let api: ReturnType<typeof returnsApi>;
  let serial = 998_100;

  const ok = (r: request.Response) => {
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    return r.body as ReturnBottleScanResult;
  };
  const refused = (r: request.Response, status: number, code: string) =>
    expect([r.status, r.body.code], JSON.stringify(r.body)).toEqual([status, code]);
  const sortedOf = (bottleId: string) =>
    t.prisma.bottleEvent.findMany({ where: { bottleId, type: 'SORTED' }, orderBy: { id: 'asc' } });
  const cycleOf = (crateCode: string) =>
    t.prisma.crateCycle.findFirstOrThrow({
      where: { crate: { code: crateCode } },
      orderBy: { openedAt: 'desc' },
    });
  const issue = (code: string) => t.prisma.returnReceiptIssue.findFirstOrThrow({ where: { code } });

  /**
   * F only picked up, then what the previous image writes into its open receipt: a container
   * line ("Krabice bez kódu") and an unanchored NOT_DELIVERED of F1 on it — committed as the core.
   */
  const oldReceiptWithIssue = async () => {
    const f = await factory.make();
    const transit = await shipCrates(t, hotel, factory.kit.productCode, [f]);
    await pickUp(t, transit);
    const { old, box } = await oldContainer();
    const code = await r1Issue(box.id, f.bottleIds[0]!, 'NOT_DELIVERED');
    return { f, transit, old, box, code };
  };
  /** An open receipt of the previous image with its container line. */
  const oldContainer = async () => {
    const old = await api.open();
    await api.unreadable(old.code).expect(200);
    const seed = (await api.detail(old.code)).lineDetails.find((l) => l.kind === 'BOTTLES')!;
    await t.prisma
      .$executeRaw`INSERT INTO "return_receipt_lines" ("receipt_id", "kind", "scanned_by", "scan_operation_id")
      SELECT "receipt_id", 'CONTAINER', "scanned_by", "scan_operation_id" FROM "return_receipt_lines" WHERE "id" = ${seed.id}::uuid`;
    const box = (await api.detail(old.code)).lineDetails.find((l) => l.kind === 'CONTAINER')!;
    return { old, box };
  };
  const r1Issue = async (lineId: string, bottleId: string, kind: string) => {
    const s = ++serial;
    const line = await t.prisma.returnReceiptLine.findUniqueOrThrow({ where: { id: lineId } });
    await t.prisma
      .$executeRaw`INSERT INTO "return_receipt_issues" ("serial", "code", "receipt_id", "line_id", "kind",
        "bottle_id", "recorded_by", "record_operation_id")
      VALUES (${s}, ${`RI-${s}`}, ${line.receiptId}::uuid, ${line.id}::uuid, ${kind}::"ReturnIssueKind",
        ${bottleId}::uuid, ${line.scannedBy}::uuid, ${line.scanOperationId}::uuid)`;
    return `RI-${s}`;
  };
  /** F delivered, then a new receipt frees crate F. */
  const freedInNewReceipt = async (f: MadeCrate, transit: ShippedOrder) => {
    await deliver(t, transit);
    const fresh = await api.open();
    const r = await api.scanCrate(fresh.code, f.crateUrl);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body).toMatchObject({ outcome: 'CRATE_RETURNED', freed: 2 });
    return fresh;
  };
  /** The complete identification on the old line: SORTED, status, the issue resolved. */
  const identifyBySql = async (
    tx: Db,
    input: { bottleId: string; cycleId: string; lineId: string; issueId: string | null },
  ) => {
    const line = await t.prisma.returnReceiptLine.findUniqueOrThrow({
      where: { id: input.lineId },
    });
    const id = randomUUID();
    await tx.$executeRaw`INSERT INTO "bottle_events" ("id", "bottle_id", "type", "occurred_at", "actor_id", "crate_cycle_id",
        "return_line_id", "resolves_issue_id", "operation_request_id", "payload")
      VALUES (${id}::uuid, ${input.bottleId}::uuid, 'SORTED', now(), ${line.scannedBy}::uuid, ${input.cycleId}::uuid,
        ${input.lineId}::uuid, ${input.issueId}::uuid, ${line.scanOperationId}::uuid, '{"outcome":"RETURNED","crate":"x"}'::jsonb)`;
    await tx.$executeRaw`UPDATE "bottles" SET "status" = 'RETURNED' WHERE "id" = ${input.bottleId}::uuid`;
    if (input.issueId) {
      await tx.$executeRaw`UPDATE "return_receipt_issues" SET "resolved_at" = now(), "resolved_by" = ${line.scannedBy}::uuid,
          "resolution" = 'IDENTIFIED', "resolve_operation_id" = ${line.scanOperationId}::uuid, "resolving_event_id" = ${id}::uuid
        WHERE "id" = ${input.issueId}::uuid`;
    }
  };

  beforeAll(async () => {
    t = await createTestApp(RETURN_ENV);
    factory = await crateFactory(t, { capacity: 2 });
    hotel = (await createHotel(t, { name: 'Hotel Stará vratka' })).code;
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

  it('the new receipt names the open issue; "Dořešit" identifies F1 in its recorded circulation on the old line; then the new receipt refuses it; one SORTED', async () => {
    const { f, transit, old, box, code } = await oldReceiptWithIssue();
    // Before the delivery R1's rule holds.
    refused(await api.identify(code, f.bottleUrls[0]!), 409, 'NOT_DELIVERED');
    const fresh = await freedInNewReceipt(f, transit);
    const cycle = await cycleOf(f.crateCode);
    expect(cycle.status).toBe('CLOSED');

    // The new receipt: refused, the open issue named, nothing written.
    const scan = await api.scanBottle(fresh.code, f.bottleUrls[0]!);
    refused(scan, 409, 'OPEN_ISSUE');
    expect(scan.body.details).toEqual({ issue: code });
    expect(await sortedOf(f.bottleIds[0]!)).toEqual([]);

    // "Dořešit" on the old line: identified in F's delivered cycle, the issue resolved by it.
    const requestId = randomUUID();
    expect(ok(await api.identify(code, f.bottleUrls[0]!, 'GOOD', requestId))).toMatchObject({
      outcome: 'IDENTIFIED',
      repeated: false,
      bottleCode: expect.any(String),
    });
    const [sorted] = await sortedOf(f.bottleIds[0]!);
    expect(sorted).toMatchObject({
      crateCycleId: cycle.id,
      returnLineId: box.id,
      payload: { outcome: 'RETURNED', receipt: old.code, crate: f.crateCode },
    });
    expect(await issue(code)).toMatchObject({
      resolution: 'IDENTIFIED',
      resolvingEventId: sorted!.id,
    });
    expect(
      await t.prisma.bottle.findUniqueOrThrow({ where: { id: f.bottleIds[0]! } }),
    ).toMatchObject({ status: 'RETURNED' });
    // Its membership stays freed by the new receipt's crate line (no second release).
    const membership = await t.prisma.crateAssignment.findFirstOrThrow({
      where: { bottleId: f.bottleIds[0]!, cycleId: cycle.id },
    });
    expect(membership).toMatchObject({ releaseReason: 'CRATE_RETURNED', releasedEventId: null });

    // Replays and rescans: the first result; another outcome is a correction.
    expect(ok(await api.identify(code, f.bottleUrls[0]!, 'GOOD', requestId))).toMatchObject({
      outcome: 'IDENTIFIED',
      repeated: false,
    });
    expect(ok(await api.identify(code, f.bottleUrls[0]!))).toMatchObject({
      outcome: 'IDENTIFIED',
      repeated: true,
    });
    refused(await api.identify(code, f.bottleUrls[0]!, 'DEFECTIVE'), 409, 'ISSUE_RESOLVED');
    // The new receipt now: received elsewhere — the old receipt.
    const again = await api.scanBottle(fresh.code, f.bottleUrls[0]!);
    refused(again, 409, 'ALREADY_RECEIVED_ELSEWHERE');
    expect(again.body.details).toEqual({ receipt: old.code });
    // F2 (no old issue) is received in the new receipt as usual.
    expect(ok(await api.scanBottle(fresh.code, f.bottleUrls[1]!))).toMatchObject({
      outcome: 'IDENTIFIED',
    });
    expect(await sortedOf(f.bottleIds[0]!)).toHaveLength(1);
    expect(await sortedOf(f.bottleIds[1]!)).toHaveLength(1);

    // The old receipt: its container emptied with its count (the one piece), then closed.
    const counted = (await api.detail(old.code)).lineDetails.find((l) => l.id === box.id)!;
    expect(counted.recordedCount).toBe(1);
    await api.empty(old.code, box.id, 1).expect(200);
    await api.close(old.code).expect(200);
    await api.close(fresh.code).expect(200);
    // One completed reuse cycle for F1.
    const f1 = await t.prisma.bottle.findUniqueOrThrow({ where: { id: f.bottleIds[0]! } });
    const passport = await request(t.app.getHttpServer())
      .get(`/api/admin/bottles/${f1.code}`)
      .expect(200);
    expect((passport.body as BottleDetail).reuseCycles).toBe(1);
  });

  it('other issues keep R1: recorded after the crate was freed, or NOT_IN_CIRCULATION — NOT_IN_CIRCULATION, nothing written', async () => {
    const { f, transit, box, code } = await oldReceiptWithIssue();
    // F2 gets an R1 NOT_IN_CIRCULATION (a misread at the time) on the same container line.
    const nic = await r1Issue(box.id, f.bottleIds[1]!, 'NOT_IN_CIRCULATION');
    await freedInNewReceipt(f, transit);
    refused(await api.identify(nic, f.bottleUrls[1]!), 409, 'NOT_IN_CIRCULATION');
    // The R1 NOT_DELIVERED of F1 closed out, then one recorded only after the crate was freed.
    await api.closeOut(code, 'WRITTEN_OFF', 'zkouška').expect(200);
    const late = await r1Issue(box.id, f.bottleIds[0]!, 'NOT_DELIVERED');
    refused(await api.identify(late, f.bottleUrls[0]!), 409, 'NOT_IN_CIRCULATION');
    expect([await sortedOf(f.bottleIds[0]!), await sortedOf(f.bottleIds[1]!)]).toEqual([[], []]);
  });

  describe('the bottle provably started another circulation: the old issue never takes it over', () => {
    /** M allocated to order 1 (not picked up), the R1 NOT_DELIVERED of M1, then order 1 cancelled. */
    const recordedThenCancelled = async () => {
      const m = await factory.make();
      const first = await createOrder(t, hotel, [
        { productCode: factory.kit.productCode, crates: 1 },
      ]);
      expect((await allocateCrate(t, first.code, m.crateUrl)).status).toBe(200);
      const { old, box } = await oldContainer();
      const code = await r1Issue(box.id, m.bottleIds[0]!, 'NOT_DELIVERED');
      expect((await cancelOrder(t, first.code)).status).toBe(200);
      return { m, old, box, code };
    };
    /** The old issue closed out by a supervisor, then the new receipt counts the new circulation. */
    const closedOutThenCounted = async (receipt: string, url: string, code: string) => {
      const scan = await api.scanBottle(receipt, url);
      refused(scan, 409, 'OPEN_ISSUE');
      expect(scan.body.details).toEqual({ issue: code });
      await api.closeOut(code, 'WRITTEN_OFF', 'jiný oběh, stará neshoda nedoložena').expect(200);
      expect(ok(await api.scanBottle(receipt, url))).toMatchObject({ outcome: 'IDENTIFIED' });
      refused(await api.scanBottle(receipt, url, 'DEFECTIVE'), 409, 'ALREADY_RECEIVED');
    };

    it('the same cycle delivered by a later order: CIRCULATION_CHANGED before and after its crate is freed, nothing written (also by SQL)', async () => {
      const { m, box, code } = await recordedThenCancelled();
      // The same crate and cycle go out with order 2, allocated after the issue was recorded.
      const second = await shipCrates(t, hotel, factory.kit.productCode, [m]);
      await deliver(t, second);
      refused(await api.identify(code, m.bottleUrls[0]!), 409, 'CIRCULATION_CHANGED');
      const fresh = await api.open();
      expect(ok(await api.scanCrate(fresh.code, m.crateUrl))).toMatchObject({
        outcome: 'CRATE_RETURNED',
      });
      refused(await api.identify(code, m.bottleUrls[0]!), 409, 'CIRCULATION_CHANGED');
      expect(await sortedOf(m.bottleIds[0]!)).toEqual([]);
      expect((await issue(code)).resolvedAt).toBeNull();
      const cycle = await cycleOf(m.crateCode);
      const issueId = (await issue(code)).id;
      await withPrivileged(async (db) => {
        await expect(
          db.$transaction((tx) =>
            identifyBySql(tx, {
              bottleId: m.bottleIds[0]!,
              cycleId: cycle.id,
              lineId: box.id,
              issueId,
            }),
          ),
        ).rejects.toThrow(/delivered member of the cycle, assigned before its line/);
      });
      await closedOutThenCounted(fresh.code, m.bottleUrls[0]!, code);
      const sorted = await sortedOf(m.bottleIds[0]!);
      expect(sorted.map((e) => e.crateCycleId)).toEqual([cycle.id]);
      expect(sorted[0]!.returnLineId).not.toBe(box.id);
    });

    it('moved into another crate and delivered there: the old issue identifies nothing (NOT_IN_THIS_LINE, then NOT_IN_CIRCULATION); the new circulation is counted once', async () => {
      const { m, box, code } = await recordedThenCancelled();
      // A supervised correction moves M1 into crate T, whose circulation then goes out.
      expect((await correctCrate(t, m.crateCode, 'reopen')).status).toBe(200);
      const m1 = (await t.prisma.bottle.findUniqueOrThrow({ where: { id: m.bottleIds[0]! } })).code;
      expect((await correctCrate(t, m.crateCode, 'remove-bottle', { bottle: m1 })).status).toBe(
        200,
      );
      const target = await factory.make('FILLING');
      const spare = (
        await t.prisma.bottle.findUniqueOrThrow({ where: { id: target.bottleIds[1]! } })
      ).code;
      expect(
        (await correctCrate(t, target.crateCode, 'remove-bottle', { bottle: spare })).status,
      ).toBe(200);
      const moved = await correctCrate(t, target.crateCode, 'add-bottle', { bottle: m1 });
      expect(moved.status, JSON.stringify(moved.body)).toBe(200);
      // Proven another circulation: T's, assigned after the old line was opened.
      refused(await api.identify(code, m.bottleUrls[0]!), 409, 'NOT_IN_THIS_LINE');
      const fs = await fillingSession(t, 'HAND_SOAP');
      expect((await fillLoadCrate(t, fs, target.crateUrl)).status).toBe(200);
      const done = await finishCrate(t, fs);
      expect(done.status, JSON.stringify(done.body)).toBe(200);
      const tCycle = await cycleOf(target.crateCode);
      expect(tCycle.status).toBe('FILLED');
      const shipped = await shipCrates(t, hotel, factory.kit.productCode, [target]);
      await deliver(t, shipped);
      const fresh = await api.open();
      expect(ok(await api.scanCrate(fresh.code, target.crateUrl))).toMatchObject({
        outcome: 'CRATE_RETURNED',
      });
      refused(await api.identify(code, m.bottleUrls[0]!), 409, 'NOT_IN_CIRCULATION');
      expect(await sortedOf(m.bottleIds[0]!)).toEqual([]);
      await withPrivileged(async (db) => {
        await expect(
          db.$transaction(async (tx) =>
            identifyBySql(tx, {
              bottleId: m.bottleIds[0]!,
              cycleId: tCycle.id,
              lineId: box.id,
              issueId: (await issue(code)).id,
            }),
          ),
        ).rejects.toThrow(/delivered member of the cycle, assigned before its line/);
      });
      await closedOutThenCounted(fresh.code, m.bottleUrls[0]!, code);
      expect((await sortedOf(m.bottleIds[0]!)).map((e) => e.crateCycleId)).toEqual([tCycle.id]);
    });
  });

  describe('concurrency (the crate row held so both requests are inside their transactions)', () => {
    const together = async (crateCode: string, calls: (() => Promise<request.Response>)[]) => {
      const [pending] = await withPrivileged(async (db) => {
        let held: Promise<request.Response>[] = [];
        await db.$transaction(async (tx) => {
          await tx.$executeRaw`SELECT 1 FROM "crates" WHERE "code" = ${crateCode} FOR UPDATE`;
          held = calls.map((c) => c());
          await new Promise((r) => setTimeout(r, 400));
        });
        return [held] as const;
      });
      return Promise.all(pending);
    };
    const answer = (r: request.Response) =>
      r.status === 200 ? (r.body as ReturnBottleScanResult).outcome : (r.body.code as string);

    it('"Dořešit" and the scan in the new receipt at once (both orders): one SORTED, on the old line; the scan refused', async () => {
      for (const first of ['identify', 'scan'] as const) {
        const { f, transit, box, code } = await oldReceiptWithIssue();
        const fresh = await freedInNewReceipt(f, transit);
        const identify = () => api.identify(code, f.bottleUrls[0]!);
        const scan = () => api.scanBottle(fresh.code, f.bottleUrls[0]!);
        const [a, b] = await together(
          f.crateCode,
          first === 'identify' ? [identify, scan] : [scan, identify],
        );
        const [id, sc] = first === 'identify' ? [a!, b!] : [b!, a!];
        expect(answer(id), JSON.stringify(id.body)).toBe('IDENTIFIED');
        expect(['OPEN_ISSUE', 'ALREADY_RECEIVED_ELSEWHERE']).toContain(answer(sc));
        const sorted = await sortedOf(f.bottleIds[0]!);
        expect(sorted.map((s) => s.returnLineId)).toEqual([box.id]);
        expect((await issue(code)).resolvingEventId).toBe(sorted[0]!.id);
      }
    });

    it('two "Dořešit" with different requestIds at once: one identification, the other repeats it', async () => {
      const { f, transit, code } = await oldReceiptWithIssue();
      await freedInNewReceipt(f, transit);
      const results = await together(f.crateCode, [
        () => api.identify(code, f.bottleUrls[0]!),
        () => api.identify(code, f.bottleUrls[0]!),
      ]);
      expect(results.map((r) => [r.status, r.body.repeated]).sort()).toEqual([
        [200, false],
        [200, true],
      ]);
      expect(await sortedOf(f.bottleIds[0]!)).toHaveLength(1);
    });

    it('"Dořešit" racing the new receipt’s crate scan (both orders): one SORTED, the crate freed once, closed', async () => {
      for (const first of ['identify', 'crate'] as const) {
        const { f, transit, box, code } = await oldReceiptWithIssue();
        await deliver(t, transit);
        const fresh = await api.open();
        const identify = () => api.identify(code, f.bottleUrls[0]!);
        const crate = () => api.scanCrate(fresh.code, f.crateUrl);
        const done = await together(
          f.crateCode,
          first === 'identify' ? [identify, crate] : [crate, identify],
        );
        for (const r of done) expect(r.status, JSON.stringify(r.body)).toBe(200);
        const cycle = await cycleOf(f.crateCode);
        expect(cycle.status).toBe('CLOSED');
        const sorted = await sortedOf(f.bottleIds[0]!);
        expect(sorted.map((s) => [s.returnLineId, s.crateCycleId])).toEqual([[box.id, cycle.id]]);
        const ms = await t.prisma.crateAssignment.findMany({ where: { cycleId: cycle.id } });
        expect(ms.filter((m) => m.releasedAt === null)).toHaveLength(0);
        expect(await sortedOf(f.bottleIds[1]!)).toHaveLength(0);
      }
    });
  });

  describe('database guards (direct SQL that commits)', () => {
    const fails = (p: Promise<unknown>, message: RegExp) => expect(p).rejects.toThrow(message);
    it('a freed member on an R1 line only by resolving its unanchored NOT_DELIVERED recorded while it was a member; once', async () => {
      const { f, transit, box, code } = await oldReceiptWithIssue();
      await freedInNewReceipt(f, transit);
      const cycle = await cycleOf(f.crateCode);
      const nd = await issue(code);
      const late = await r1Issue(box.id, f.bottleIds[1]!, 'NOT_DELIVERED');
      const lateIssue = await issue(late);
      await withPrivileged(async (db) => {
        // No issue: R1's rule (an active member) — refused.
        await fails(
          db.$transaction((tx) =>
            identifyBySql(tx, {
              bottleId: f.bottleIds[1]!,
              cycleId: cycle.id,
              lineId: box.id,
              issueId: null,
            }),
          ),
          /delivered member of the cycle, assigned before its line/,
        );
        // An issue recorded only after the crate was freed: not that circulation — refused.
        await fails(
          db.$transaction((tx) =>
            identifyBySql(tx, {
              bottleId: f.bottleIds[1]!,
              cycleId: cycle.id,
              lineId: box.id,
              issueId: lateIssue.id,
            }),
          ),
          /delivered member of the cycle, assigned before its line/,
        );
        // The issue recorded in it: commits.
        await db.$transaction((tx) =>
          identifyBySql(tx, {
            bottleId: f.bottleIds[0]!,
            cycleId: cycle.id,
            lineId: box.id,
            issueId: nd.id,
          }),
        );
      });
      expect(await sortedOf(f.bottleIds[0]!)).toHaveLength(1);
      expect(await sortedOf(f.bottleIds[1]!)).toHaveLength(0);
      // A second SORTED of the circulation (another line of the new receipt): never.
      const freshLine = await t.prisma.returnReceiptLine.findFirstOrThrow({
        where: { kind: 'CRATE', returnedCycleId: cycle.id },
      });
      await withPrivileged(async (db) => {
        await fails(
          db.$transaction((tx) =>
            identifyBySql(tx, {
              bottleId: f.bottleIds[0]!,
              cycleId: cycle.id,
              lineId: freshLine.id,
              issueId: null,
            }),
          ),
          /bottle_events_one_sorted_per_cycle|SORTED|scan goes only/,
        );
      });
    });
  });
});
