import { randomUUID } from 'node:crypto';
import type {
  BottleDetail,
  OrderDetail,
  OutsideBottlesPage,
  ReturnBottleScanResult,
  ReturnCrateScanResult,
  ReturnReceiptDetail,
} from '@ayvo/types';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { testCarrierControl } from '../src/carriers/test-carrier.js';
import { correctCrate, fillingSession, fillLoadCrate } from './support/labeling-fixtures.js';
import {
  cancelOrder,
  crateFactory,
  createHotel,
  createOrder,
  type MadeCrate,
  scanCrate as allocateCrate,
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
 * Return intake R1.1 (doc 047 §6.3; owner 2026-11-18) against the real database: crates delivered
 * by the FAKE test carrier (never PPL), then scanned back — the crate scan frees the crate at once
 * and ends its members' binding without confirming any bottle; each really returned bottle is
 * identified on its own by its QR, independent of any crate, exactly once per circulation. No
 * mandatory Vyprázdnit or physical count. Then the database guards, by direct SQL that commits.
 */
describe.skipIf(!hasDatabase)('return intake R1.1 (doc 047 §6.3)', () => {
  let t: TestApp;
  let factory: Factory;
  let hotel: string;
  let api: ReturnType<typeof returnsApi>;
  const http = () => request(t.app.getHttpServer());

  const delivered = async (
    n = 1,
    f: Factory = factory,
  ): Promise<{ crates: MadeCrate[]; shipped: ShippedOrder }> => {
    const crates: MadeCrate[] = [];
    // One order line takes one label design: a fresh pool so every crate carries the same one.
    if (n > 1) await f.refill();
    for (let i = 0; i < n; i++) crates.push(await f.make());
    const shipped = await shipCrates(t, hotel, f.kit.productCode, crates);
    await deliver(t, shipped);
    return { crates, shipped };
  };
  const cycleOf = (crateCode: string) =>
    t.prisma.crateCycle.findFirstOrThrow({
      where: { crate: { code: crateCode } },
      orderBy: { openedAt: 'desc' },
    });
  const bottle = (id: string) => t.prisma.bottle.findUniqueOrThrow({ where: { id } });
  const sortedOf = (bottleId: string) =>
    t.prisma.bottleEvent.findMany({ where: { bottleId, type: 'SORTED' }, orderBy: { id: 'asc' } });
  const reuse = async (id: string) =>
    (
      (
        await http()
          .get(`/api/admin/bottles/${(await bottle(id)).code}`)
          .expect(200)
      ).body as BottleDetail
    ).reuseCycles;
  const crateLine = (d: ReturnReceiptDetail, crateCode: string) =>
    d.lineDetails.find((l) => l.kind === 'CRATE' && l.crateCode === crateCode)!;
  const bottlesLine = (d: ReturnReceiptDetail) => d.lineDetails.find((l) => l.kind === 'BOTTLES');
  const scanned = async (code: string, crateUrl: string, requestId?: string) => {
    const r = await api.scanCrate(code, crateUrl, requestId);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    return r.body as ReturnCrateScanResult;
  };
  const ok = (r: request.Response) => {
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    return r.body as ReturnBottleScanResult;
  };
  const refused = (r: request.Response, status: number, code: string) =>
    expect([r.status, r.body.code], JSON.stringify(r.body)).toEqual([status, code]);
  const members = (cycleId: string) =>
    t.prisma.crateAssignment.findMany({ where: { cycleId }, orderBy: { ordinal: 'asc' } });

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

  it('the crate scan frees the crate at once: CLOSED, line emptied without a count, members released by the line; no bottle written; the order stays; the crate is usable at once', async () => {
    const { crates, shipped } = await delivered();
    const [k] = crates as [MadeCrate];
    const before = (await http().get(`/api/admin/orders/${shipped.order}`).expect(200))
      .body as OrderDetail;
    const receipt = await api.open(hotel);
    const rid = randomUUID();
    const crate = await scanned(receipt.code, k.crateUrl, rid);
    expect(crate).toMatchObject({ outcome: 'CRATE_RETURNED', crateCode: k.crateCode, freed: 2 });

    const cycle = await cycleOf(k.crateCode);
    expect(cycle.status).toBe('CLOSED');
    expect([cycle.memberCount, cycle.filledCount, cycle.filledAt]).toEqual([
      2,
      2,
      expect.any(Date),
    ]);
    const events = await t.prisma.crateEvent.findMany({
      where: { cycleId: cycle.id, type: { in: ['RETURNED', 'EMPTIED'] } },
      orderBy: { id: 'asc' },
    });
    expect(events.map((e) => e.type)).toEqual(['RETURNED', 'EMPTIED']);
    const line = await t.prisma.returnReceiptLine.findUniqueOrThrow({
      where: { id: crate.lineId },
    });
    expect([line.kind, line.emptiedAt !== null, line.physicalCount]).toEqual(['CRATE', true, null]);
    // Every member's binding ended by that line — none of them confirmed returned.
    const ms = await members(cycle.id);
    expect(ms.map((a) => [a.releaseReason, a.releasedByLineId, a.releasedEventId])).toEqual([
      ['CRATE_RETURNED', line.id, null],
      ['CRATE_RETURNED', line.id, null],
    ]);
    for (const id of k.bottleIds) {
      expect((await bottle(id)).status).toBe('FILLED');
      expect(await sortedOf(id)).toEqual([]);
      expect(await reuse(id)).toBe(0);
    }
    // The shipment record stays: the allocation completed with its insert-only contents.
    const allocation = await t.prisma.orderCrateAllocation.findFirstOrThrow({
      where: { cycleId: cycle.id },
      include: { bottles: true },
    });
    expect([allocation.releasedAt, allocation.completedLineId]).toEqual([null, line.id]);
    expect(allocation.bottles.map((b) => b.bottleId).sort()).toEqual([...k.bottleIds].sort());
    const after = (await http().get(`/api/admin/orders/${shipped.order}`).expect(200))
      .body as OrderDetail;
    expect([after.status, after.lines]).toEqual(['DELIVERED', before.lines]);

    // Repeats: the same request — stored; a new request in the same receipt — the first result;
    // another receipt — refused. Nothing written again.
    expect(await scanned(receipt.code, k.crateUrl, rid)).toEqual(crate);
    expect(await scanned(receipt.code, k.crateUrl)).toMatchObject({
      outcome: 'ALREADY_SCANNED',
      lineId: crate.lineId,
      freed: 2,
    });
    const other = await api.open();
    refused(await api.scanCrate(other.code, k.crateUrl), 409, 'CRATE_ALREADY_RETURNED');

    // The receipt closes at once (no Vyprázdněno, no count) with counts derived from the scans.
    const closed = (await api.close(receipt.code).expect(200)).body as ReturnReceiptDetail;
    expect([closed.state, closed.counts]).toEqual([
      'CLOSED',
      { crates: 1, identified: 0, defective: 0, unreadable: 0 },
    ]);
    expect(crateLine(closed, k.crateCode)).toMatchObject({
      freedWithCrate: 2,
      physicalCount: null,
      history: { shipped: 2, identified: 0, withoutConfirmedReturn: 2 },
    });

    // The crate is usable at once: a new cycle, filled, Hotovo — its freed bottles stay "at the
    // hotel" (never listed as finished bottles outside a crate, never placed into a crate).
    const again = await factory.make('FILLED', undefined, k.crateUrl);
    expect(again.crateCode).toBe(k.crateCode);
    const outside = (
      await http().get('/api/admin/bottles-outside-crates?group=finished&pageSize=100').expect(200)
    ).body as OutsideBottlesPage;
    const codes = await Promise.all(k.bottleIds.map(async (id) => (await bottle(id)).code));
    expect(outside.items.map((i) => i.code).filter((c) => codes.includes(c))).toEqual([]);
    const target = await factory.make('READY_TO_FILL');
    const fs = await fillingSession(t, 'HAND_SOAP');
    expect((await fillLoadCrate(t, fs, target.crateUrl)).status).toBe(200);
    const add = await correctCrate(t, target.crateCode, 'add-bottle', {
      bottle: codes[0]!,
      reason: 'test',
    });
    refused(add, 409, 'BOTTLE_AT_HOTEL');
  });

  it('regression: 10 shipped, 8 returned — some before the crate, one defective; 2 stay at the hotel; the crate needs no count', async () => {
    const ten = await crateFactory(t, { capacity: 10 });
    const { crates } = await delivered(1, ten);
    const [k] = crates as [MadeCrate];
    const receipt = await api.open(hotel);
    // Three bottles come before their crate (still members: released by their SORTED).
    for (const url of k.bottleUrls.slice(0, 3)) {
      expect(ok(await api.scanBottle(receipt.code, url))).toMatchObject({
        outcome: 'IDENTIFIED',
        result: 'RETURNED',
      });
    }
    expect((await scanned(receipt.code, k.crateUrl)).freed).toBe(7);
    // Five after it (freed with the crate: the SORTED names that cycle, no release), one defective.
    for (const [i, url] of k.bottleUrls.slice(3, 8).entries()) {
      expect(
        ok(await api.scanBottle(receipt.code, url, i === 4 ? 'DEFECTIVE' : 'GOOD')),
      ).toMatchObject({ outcome: 'IDENTIFIED', result: i === 4 ? 'RETIRED' : 'RETURNED' });
    }
    const cycle = await cycleOf(k.crateCode);
    const ms = await members(cycle.id);
    expect(ms.filter((a) => a.releaseReason === 'RETURN_IDENTIFIED')).toHaveLength(3);
    expect(ms.filter((a) => a.releaseReason === 'CRATE_RETURNED')).toHaveLength(7);
    expect(ms.filter((a) => a.releasedAt === null)).toHaveLength(0);
    for (const [i, id] of k.bottleIds.entries()) {
      expect([i, (await sortedOf(id)).length, await reuse(id)]).toEqual([
        i,
        i < 8 ? 1 : 0,
        i < 8 ? 1 : 0,
      ]);
    }
    expect(
      await Promise.all(k.bottleIds.slice(8).map(async (id) => (await bottle(id)).status)),
    ).toEqual(['FILLED', 'FILLED']);
    const d = (await api.close(receipt.code).expect(200)).body as ReturnReceiptDetail;
    expect(d.counts).toEqual({ crates: 1, identified: 8, defective: 1, unreadable: 0 });
    expect(crateLine(d, k.crateCode).history).toEqual({
      shipped: 10,
      identified: 8,
      withoutConfirmedReturn: 2,
    });
    expect(bottlesLine(d)!.bottles).toHaveLength(8);
    // The ninth comes back weeks later, after K went out again: identified for K's first cycle.
    const again = await ten.make('FILLED', undefined, k.crateUrl);
    const o2 = await shipCrates(t, hotel, ten.kit.productCode, [again]);
    await deliver(t, o2);
    const later = await api.open();
    ok(await api.scanBottle(later.code, k.bottleUrls[8]!));
    expect((await sortedOf(k.bottleIds[8]!))[0]!.crateCycleId).toBe(cycle.id);
    expect(crateLine(await api.detail(receipt.code), k.crateCode).history).toEqual({
      shipped: 10,
      identified: 9,
      withoutConfirmedReturn: 1,
    });
  });

  it('a bottle on its own: before its crate, a crate never scanned (mixed), in another receipt after its crate was reused', async () => {
    const { crates, shipped: o1 } = await delivered(2);
    const [k, l] = crates as [MadeCrate, MadeCrate];
    const r1 = await api.open(hotel);
    // k0 before its crate; l0 of crate L (L is never scanned).
    expect(ok(await api.scanBottle(r1.code, k.bottleUrls[0]!))).toMatchObject({
      outcome: 'IDENTIFIED',
    });
    expect(ok(await api.scanBottle(r1.code, l.bottleUrls[0]!, 'DEFECTIVE'))).toMatchObject({
      outcome: 'IDENTIFIED',
      result: 'RETIRED',
    });
    const k1 = await cycleOf(k.crateCode);
    const l1 = await cycleOf(l.crateCode);
    expect((await sortedOf(l.bottleIds[0]!))[0]!.crateCycleId).toBe(l1.id);
    expect(l1.status).toBe('DELIVERED'); // L itself stays with the hotel
    expect((await members(l1.id)).filter((a) => a.releasedAt === null)).toHaveLength(1);
    // Then K: only k1 is still bound to it.
    expect((await scanned(r1.code, k.crateUrl)).freed).toBe(1);
    await api.close(r1.code).expect(200);

    // K goes out again (cycle K2) and is delivered; k1 of K1 arrives later, in a new receipt.
    const again = await factory.make('FILLED', undefined, k.crateUrl);
    const o2 = await shipCrates(t, hotel, factory.kit.productCode, [again]);
    await deliver(t, o2);
    const k2 = await cycleOf(k.crateCode);
    expect(k2.id).not.toBe(k1.id);
    const r2 = await api.open();
    ok(await api.scanBottle(r2.code, k.bottleUrls[1]!));
    expect((await sortedOf(k.bottleIds[1]!)).map((e) => e.crateCycleId)).toEqual([k1.id]);
    // K2's own bottle: identified for K2, still a member — K2 not scanned.
    ok(await api.scanBottle(r2.code, again.bottleUrls[0]!));
    expect((await sortedOf(again.bottleIds[0]!)).map((e) => e.crateCycleId)).toEqual([k2.id]);
    expect([k.bottleIds[0], k.bottleIds[1], l.bottleIds[0]].length).toBe(3);
    for (const id of [k.bottleIds[0]!, k.bottleIds[1]!, l.bottleIds[0]!, again.bottleIds[0]!]) {
      expect(await reuse(id)).toBe(1);
    }
    // O1 keeps its original contents, parcel and delivery.
    const first = await t.prisma.orderCrateAllocation.findMany({
      where: { order: { code: o1.order } },
      include: { bottles: true, parcels: { include: { progress: true } } },
      orderBy: { allocatedAt: 'asc' },
    });
    expect(first.map((a) => a.bottles.length)).toEqual([2, 2]);
    expect(first.every((a) => a.parcels[0]!.progress!.deliveredAt !== null)).toBe(true);
    expect(first[0]!.bottles.map((b) => b.bottleId).sort()).toEqual([...k.bottleIds].sort());
  });

  it('late scans: a receipt opened before the delivery identifies nothing of it (also with a new requestId); a new receipt does', async () => {
    const m = await factory.make();
    const shipped = await shipCrates(t, hotel, factory.kit.productCode, [m]);
    await pickUp(t, shipped);
    const early = await api.open();
    await deliver(t, shipped);
    refused(await api.scanCrate(early.code, m.crateUrl), 409, 'CRATE_DELIVERED_AFTER_RECEIPT');
    refused(await api.scanBottle(early.code, m.bottleUrls[0]!), 409, 'DELIVERED_AFTER_RECEIPT');
    refused(await api.scanBottle(early.code, m.bottleUrls[0]!), 409, 'DELIVERED_AFTER_RECEIPT');
    expect(await sortedOf(m.bottleIds[0]!)).toEqual([]);
    expect((await cycleOf(m.crateCode)).status).toBe('DELIVERED');
    const fresh = await api.open();
    expect((await scanned(fresh.code, m.crateUrl)).outcome).toBe('CRATE_RETURNED');
    ok(await api.scanBottle(fresh.code, m.bottleUrls[0]!));
  });

  it('NOT_DELIVERED is anchored at its first scan: a retry adds nothing; resolved after the delivery and the close; the wrong bottle refused', async () => {
    const m = await factory.make();
    const shipped = await shipCrates(t, hotel, factory.kit.productCode, [m]);
    await pickUp(t, shipped);
    const m1 = await cycleOf(m.crateCode);
    const receipt = await api.open();
    const rid = randomUUID();
    const first = ok(await api.scanBottle(receipt.code, m.bottleUrls[0]!, 'GOOD', rid));
    expect(first).toMatchObject({ outcome: 'ISSUE_RECORDED', code: 'NOT_DELIVERED' });
    expect(ok(await api.scanBottle(receipt.code, m.bottleUrls[0]!, 'GOOD', rid))).toEqual(first);
    expect(ok(await api.scanBottle(receipt.code, m.bottleUrls[0]!))).toMatchObject({
      issue: first.issue,
    });
    const issue = await t.prisma.returnReceiptIssue.findFirstOrThrow({
      where: { code: first.issue!.code },
    });
    const allocation = await t.prisma.orderCrateAllocation.findFirstOrThrow({
      where: { cycleId: m1.id },
    });
    expect([issue.anchorCycleId, issue.anchorAllocationId]).toEqual([m1.id, allocation.id]);
    expect(await t.prisma.returnReceiptIssue.count({ where: { receiptId: issue.receiptId } })).toBe(
      1,
    );

    await api.close(receipt.code).expect(200);
    refused(await api.identify(first.issue!.code, m.bottleUrls[0]!), 409, 'NOT_DELIVERED');
    await deliver(t, shipped); // delivered after the receipt was opened — the anchor allows it
    refused(await api.identify(first.issue!.code, m.bottleUrls[1]!), 409, 'WRONG_BOTTLE');
    const done = ok(await api.identify(first.issue!.code, m.bottleUrls[0]!));
    expect(done).toMatchObject({ outcome: 'IDENTIFIED', repeated: false, issue: first.issue });
    expect(ok(await api.identify(first.issue!.code, m.bottleUrls[0]!)).repeated).toBe(true);
    const [sorted] = await sortedOf(m.bottleIds[0]!);
    expect([sorted!.crateCycleId, sorted!.returnLineId, sorted!.resolvesIssueId]).toEqual([
      m1.id,
      issue.lineId,
      issue.id,
    ]);
    const d = await api.detail(receipt.code);
    expect(d.state).toBe('CLOSED');
    expect(await reuse(m.bottleIds[0]!)).toBe(1);
    // An ordinary scan never uses that exception: the other bottle in the old receipt is refused.
    refused(await api.scanBottle(receipt.code, m.bottleUrls[1]!), 409, 'RECEIPT_CLOSED');
  });

  it('an anchored issue never closes a later circulation: ALREADY_RECEIVED_ELSEWHERE when identified elsewhere', async () => {
    const m = await factory.make();
    const shipped = await shipCrates(t, hotel, factory.kit.productCode, [m]);
    await pickUp(t, shipped);
    const old = await api.open();
    const issue = ok(await api.scanBottle(old.code, m.bottleUrls[0]!)).issue!.code;
    await deliver(t, shipped);
    // The bottle is identified for M1 in another receipt…
    const other = await api.open();
    refused(await api.scanBottle(other.code, m.bottleUrls[0]!), 409, 'OPEN_ISSUE');
    await api.closeOut(issue, 'WRITTEN_OFF', 'kontrola: lahev přijde jinou cestou').expect(200);
    ok(await api.scanBottle(other.code, m.bottleUrls[0]!));
    // …then a second anchored issue of the same circulation cannot identify it again.
    const m2 = await factory.make();
    const s2 = await shipCrates(t, hotel, factory.kit.productCode, [m2]);
    await pickUp(t, s2);
    const r = await api.open();
    const i2 = ok(await api.scanBottle(r.code, m2.bottleUrls[0]!)).issue!.code;
    await deliver(t, s2);
    const elsewhere = await api.open();
    // The other bottle's ordinary path is unaffected; the issue's bottle is blocked by its issue.
    ok(await api.scanBottle(elsewhere.code, m2.bottleUrls[1]!));
    ok(await api.identify(i2, m2.bottleUrls[0]!));
    refused(
      await api.scanBottle(elsewhere.code, m2.bottleUrls[0]!),
      409,
      'ALREADY_RECEIVED_ELSEWHERE',
    );
    expect(await sortedOf(m2.bottleIds[0]!)).toHaveLength(1);
  });

  it('an anchored issue against a later circulation writes nothing: CIRCULATION_CHANGED (the order cancelled, the bottle moved to another crate)', async () => {
    const m = await factory.make();
    const order = await createOrder(t, hotel, [
      { productCode: factory.kit.productCode, crates: 1 },
    ]);
    expect((await allocateCrate(t, order.code, m.crateUrl)).status).toBe(200);
    const m1 = await cycleOf(m.crateCode);
    expect(m1.status).toBe('ALLOCATED');
    const receipt = await api.open();
    const issue = ok(await api.scanBottle(receipt.code, m.bottleUrls[0]!)).issue!.code;
    // The order is cancelled before any pickup; the bottle leaves M by a supervised correction
    // and is repacked into another crate.
    expect((await cancelOrder(t, order.code)).status).toBe(200);
    expect((await correctCrate(t, m.crateCode, 'reopen')).status).toBe(200);
    const code = (await bottle(m.bottleIds[0]!)).code;
    expect((await correctCrate(t, m.crateCode, 'remove-bottle', { bottle: code })).status).toBe(
      200,
    );
    const target = await factory.make('FILLING');
    const free = (await bottle(target.bottleIds[1]!)).code;
    expect(
      (await correctCrate(t, target.crateCode, 'remove-bottle', { bottle: free })).status,
    ).toBe(200);
    const moved = await correctCrate(t, target.crateCode, 'add-bottle', { bottle: code });
    expect(moved.status, JSON.stringify(moved.body)).toBe(200);
    refused(await api.identify(issue, m.bottleUrls[0]!), 409, 'CIRCULATION_CHANGED');
    expect(await sortedOf(m.bottleIds[0]!)).toEqual([]);
    expect(
      (await t.prisma.returnReceiptIssue.findFirstOrThrow({ where: { code: issue } })).resolvedAt,
    ).toBeNull();
    expect(
      await t.prisma.crateAssignment.count({
        where: {
          bottleId: m.bottleIds[0]!,
          releasedAt: null,
          cycle: { crate: { code: target.crateCode } },
        },
      }),
    ).toBe(1);
  });

  it('duplicates: replays, rescans, another outcome, another receipt, foreign values; unreadable pieces', async () => {
    const { crates } = await delivered();
    const [k] = crates as [MadeCrate];
    const receipt = await api.open();
    const rid = randomUUID();
    const first = ok(await api.scanBottle(receipt.code, k.bottleUrls[0]!, 'GOOD', rid));
    expect(ok(await api.scanBottle(receipt.code, k.bottleUrls[0]!, 'GOOD', rid))).toEqual(first);
    refused(
      await api.scanBottle(receipt.code, k.bottleUrls[0]!, 'DEFECTIVE', rid),
      409,
      'IDEMPOTENCY_CONFLICT',
    );
    expect(ok(await api.scanBottle(receipt.code, k.bottleUrls[0]!))).toMatchObject({
      outcome: 'IDENTIFIED',
      repeated: true,
    });
    refused(
      await api.scanBottle(receipt.code, k.bottleUrls[0]!, 'DEFECTIVE'),
      409,
      'ALREADY_RECEIVED',
    );
    const other = await api.open();
    refused(await api.scanBottle(other.code, k.bottleUrls[0]!), 409, 'ALREADY_RECEIVED_ELSEWHERE');
    expect(await sortedOf(k.bottleIds[0]!)).toHaveLength(1);
    refused(await api.scanBottle(receipt.code, 'https://example.com/x'), 422, 'NOT_AYVO_QR');
    refused(await api.scanBottle(receipt.code, k.crateUrl), 422, 'NOT_A_BOTTLE');
    refused(await api.scanCrate(receipt.code, k.bottleUrls[1]!), 422, 'NOT_A_CRATE');
    // An unreadable piece is a piece of the BOTTLES line, resolved later by its scan.
    const unreadable = (await api.unreadable(receipt.code).expect(200)).body.issue.code as string;
    let d = await api.detail(receipt.code);
    expect(d.counts).toMatchObject({ identified: 1, unreadable: 1 });
    expect(d.lineDetails.filter((l) => l.kind === 'BOTTLES')).toHaveLength(1);
    await api.close(receipt.code).expect(200);
    refused(await api.scanBottle(receipt.code, k.bottleUrls[1]!), 409, 'RECEIPT_CLOSED');
    refused(await api.unreadable(receipt.code), 409, 'RECEIPT_CLOSED');
    ok(await api.identify(unreadable, k.bottleUrls[1]!));
    d = await api.detail(receipt.code);
    expect(bottlesLine(d)!.recordedCount).toBe(2);
    expect(await reuse(k.bottleIds[1]!)).toBe(1);
  });

  describe('concurrency', () => {
    it('one crate in two receipts at once: freed once; the other refused', async () => {
      const { crates } = await delivered();
      const [k] = crates as [MadeCrate];
      const [a, b] = [await api.open(), await api.open()];
      const results = await Promise.all([
        api.scanCrate(a.code, k.crateUrl),
        api.scanCrate(b.code, k.crateUrl),
      ]);
      const answers = results.map((r) => (r.status === 200 ? r.body.outcome : r.body.code)).sort();
      expect(answers).toEqual(['CRATE_ALREADY_RETURNED', 'CRATE_RETURNED']);
      expect(
        await t.prisma.returnReceiptLine.count({ where: { crate: { code: k.crateCode } } }),
      ).toBe(1);
      expect(
        await t.prisma.crateAssignment.count({
          where: { cycleId: (await cycleOf(k.crateCode)).id, releaseReason: 'CRATE_RETURNED' },
        }),
      ).toBe(2);
    });

    it('a crate scan and the scan of its bottle at once (both orders): one identification, the balance holds', async () => {
      for (const first of ['crate', 'bottle'] as const) {
        const { crates } = await delivered();
        const [k] = crates as [MadeCrate];
        const receipt = await api.open();
        // Hold the crate row so both requests are inside their transactions before either runs on.
        const [pending] = await withPrivileged(async (db) => {
          let held: [Promise<request.Response>, Promise<request.Response>] | null = null;
          await db.$transaction(async (tx) => {
            await tx.$executeRaw`SELECT 1 FROM "crates" WHERE "code" = ${k.crateCode} FOR UPDATE`;
            const crate = () => api.scanCrate(receipt.code, k.crateUrl).then((r) => r);
            const one = () => api.scanBottle(receipt.code, k.bottleUrls[0]!).then((r) => r);
            held = first === 'crate' ? [crate(), one()] : [one(), crate()];
            await new Promise((r) => setTimeout(r, 400));
          });
          return [held!] as const;
        });
        const done = await Promise.all(pending);
        for (const r of done) {
          expect([200, 409], JSON.stringify(r.body)).toContain(r.status);
          if (r.status === 409) expect(r.body.code).toBe('CONCURRENT_CHANGE');
        }
        // Retried if needed, it ends the same: one SORTED, the other member freed by the crate.
        const crateDone = await api.scanCrate(receipt.code, k.crateUrl);
        expect(crateDone.status).toBe(200);
        ok(await api.scanBottle(receipt.code, k.bottleUrls[0]!));
        const cycle = await cycleOf(k.crateCode);
        const ms = await members(cycle.id);
        expect(ms.filter((a) => a.releasedAt === null)).toHaveLength(0);
        expect(await sortedOf(k.bottleIds[0]!)).toHaveLength(1);
        expect(await sortedOf(k.bottleIds[1]!)).toHaveLength(0);
        expect(cycle.status).toBe('CLOSED');
      }
    });

    it('one bottle in two receipts at once, and the first scans of one receipt at once: one identification, one BOTTLES line', async () => {
      const { crates } = await delivered();
      const [k] = crates as [MadeCrate];
      const [a, b] = [await api.open(), await api.open()];
      const results = await Promise.all([
        api.scanBottle(a.code, k.bottleUrls[0]!),
        api.scanBottle(b.code, k.bottleUrls[0]!),
      ]);
      const answers = results.map((r) => (r.status === 200 ? 'OK' : r.body.code));
      expect(answers.filter((x) => x === 'OK')).toHaveLength(1);
      expect(['ALREADY_RECEIVED_ELSEWHERE', 'CONCURRENT_CHANGE']).toContain(
        answers.find((x) => x !== 'OK'),
      );
      expect(await sortedOf(k.bottleIds[0]!)).toHaveLength(1);
      const c = await api.open();
      await Promise.all([api.unreadable(c.code), api.unreadable(c.code), api.unreadable(c.code)]);
      const d = await api.detail(c.code);
      expect(d.lineDetails.filter((l) => l.kind === 'BOTTLES')).toHaveLength(1);
      expect(d.counts.unreadable).toBe(3);
    });

    it('a crate scan racing a filling station load of the same crate: never a half state; the next cycle opens after the scan', async () => {
      const { crates } = await delivered();
      const [k] = crates as [MadeCrate];
      const receipt = await api.open();
      const fs = await fillingSession(t, 'HAND_SOAP');
      const [crateScan, load] = await Promise.all([
        api.scanCrate(receipt.code, k.crateUrl),
        fillLoadCrate(t, fs, k.crateUrl),
      ]);
      expect(crateScan.status, JSON.stringify(crateScan.body)).toBe(200);
      // Either refused while still delivered, or after the scan (a filling station opens no cycle).
      expect([409, 404, 422]).toContain(load.status);
      const again = await factory.make('FILLED', undefined, k.crateUrl);
      expect(again.crateCode).toBe(k.crateCode);
      const cycles = await t.prisma.crateCycle.findMany({
        where: { crate: { code: k.crateCode } },
        orderBy: { openedAt: 'asc' },
      });
      expect(cycles.map((c) => c.status)).toEqual(['CLOSED', 'FILLED']);
    });
  });

  describe('database guards (direct SQL that commits)', () => {
    const fails = (p: Promise<unknown>, message: RegExp) => expect(p).rejects.toThrow(message);

    it('a delivered cycle: never CLOSED or RETURNED by SQL alone; members leave only by their SORTED or by their own crate line', async () => {
      const { crates } = await delivered(2);
      const [k, l] = crates as [MadeCrate, MadeCrate];
      const cycle = await cycleOf(k.crateCode);
      // L's crate line (a real scan) — K's members can never be released by it.
      const receipt = await api.open();
      const lLine = (await scanned(receipt.code, l.crateUrl)).lineId;
      await withPrivileged(async (db) => {
        await fails(
          db.$executeRaw`UPDATE "crate_cycles" SET "status" = 'CLOSED' WHERE "id" = ${cycle.id}::uuid`,
          /changes only DELIVERED → RETURNED → CLOSED/,
        );
        await fails(
          db.$executeRaw`UPDATE "crate_cycles" SET "status" = 'RETURNED' WHERE "id" = ${cycle.id}::uuid`,
          /RETURNED or CLOSED exactly when its allocation is completed|ALLOCATED exactly while an order holds it/,
        );
        const release = (reason: string, line: string | null, event: string | null) =>
          db.$executeRaw`UPDATE "crate_assignments" SET "released_at" = now(), "released_by" = "assigned_by",
              "release_reason" = ${reason}, "release_operation_id" = "operation_request_id",
              "released_by_line_id" = ${line}::uuid, "released_event_id" = ${event}::uuid
            WHERE "cycle_id" = ${cycle.id}::uuid AND "released_at" IS NULL`;
        await fails(
          release('REMOVED', null, null),
          /only by its SORTED .* or by its own crate line/,
        );
        await fails(release('RETURN_IDENTIFIED', null, null), /only by its SORTED/);
        await fails(
          release('CRATE_RETURNED', null, null),
          /or by its own crate line|crate_assignments_crate_return_check/,
        );
        // Another cycle's crate line, or a line with a bottle event too.
        await fails(release('CRATE_RETURNED', lLine, null), /or by its own crate line/);
        await fails(
          release('REMOVED', lLine, null),
          /or by its own crate line|crate_assignments_crate_return_check/,
        );
      });
      expect((await cycleOf(k.crateCode)).status).toBe('DELIVERED');
      expect((await members(cycle.id)).filter((a) => a.releasedAt === null)).toHaveLength(2);
    });

    it('a freed crate: closed for good, no active member, no reactivation; lines by kind; a receipt closes without its BOTTLES line', async () => {
      const { crates } = await delivered();
      const [k] = crates as [MadeCrate];
      const receipt = await api.open();
      const kLine = (await scanned(receipt.code, k.crateUrl)).lineId;
      await api.unreadable(receipt.code).expect(200);
      const bLine = bottlesLine(await api.detail(receipt.code))!.id;
      const cycle = await cycleOf(k.crateCode);
      await withPrivileged(async (db) => {
        await fails(
          db.$executeRaw`UPDATE "crate_cycles" SET "status" = 'RETURNED' WHERE "id" = ${cycle.id}::uuid`,
          /closed crate cycle never changes/,
        );
        await fails(
          db.$executeRaw`UPDATE "crate_assignments" SET "released_at" = NULL WHERE "cycle_id" = ${cycle.id}::uuid`,
          /changes only by its one release/,
        );
        // A BOTTLES line is never emptied and has no count; a second one is refused.
        await fails(
          db.$executeRaw`UPDATE "return_receipt_lines" SET "emptied_at" = now(), "emptied_by" = "scanned_by",
            "empty_operation_id" = "scan_operation_id" WHERE "id" = ${bLine}::uuid`,
          /return_receipt_lines_emptied_check/,
        );
        await fails(
          db.$executeRaw`INSERT INTO "return_receipt_lines" ("receipt_id", "kind", "scanned_by", "scan_operation_id")
            SELECT "receipt_id", 'BOTTLES', "scanned_by", "scan_operation_id" FROM "return_receipt_lines" WHERE "id" = ${bLine}::uuid`,
          /return_receipt_lines_one_bottles_line/,
        );
        // The crate line keeps its (absent) count: an emptied line changes no more.
        await fails(
          db.$executeRaw`UPDATE "return_receipt_lines" SET "physical_count" = 2 WHERE "id" = ${kLine}::uuid`,
          /changes only by its one emptying/,
        );
      });
      await api.close(receipt.code).expect(200);
    });

    it('a container line of the previous image (a rollback before the first R1.1 write) stays an R1 line: emptied with its count, then the receipt closes', async () => {
      const { crates } = await delivered();
      const [k] = crates as [MadeCrate];
      const receipt = await api.open();
      // R1.1 itself has no container route.
      expect((await api.post(`/receipts/${receipt.code}/containers`, {})).status).toBe(404);
      await api.unreadable(receipt.code).expect(200);
      const bLine = bottlesLine(await api.detail(receipt.code))!.id;
      // What the previous image's "Krabice bez kódu" writes, committed as the core role.
      await t.prisma
        .$executeRaw`INSERT INTO "return_receipt_lines" ("receipt_id", "kind", "scanned_by", "scan_operation_id")
        SELECT "receipt_id", 'CONTAINER', "scanned_by", "scan_operation_id" FROM "return_receipt_lines" WHERE "id" = ${bLine}::uuid`;
      const box = (await api.detail(receipt.code)).lineDetails.find((l) => l.kind === 'CONTAINER')!;
      expect(box.emptiedAt).toBeNull();
      // A bottle scanned now goes to the BOTTLES line, never to the container.
      expect(ok(await api.scanBottle(receipt.code, k.bottleUrls[0]!))).toMatchObject({
        outcome: 'IDENTIFIED',
      });
      expect((await sortedOf(k.bottleIds[0]!))[0]!.returnLineId).toBe(bLine);
      // The container keeps R1's rule: the close waits for its Vyprázdněno with a count.
      refused(await api.close(receipt.code), 409, 'LINES_NOT_EMPTIED');
      await api.empty(receipt.code, box.id, 0).expect(200);
      await api.close(receipt.code).expect(200);
    });

    it('SORTED only for the latest circulation, delivered before its receipt — or exactly an anchored issue; complete at commit', async () => {
      const { crates } = await delivered();
      const [k] = crates as [MadeCrate];
      const receipt = await api.open();
      await scanned(receipt.code, k.crateUrl);
      await api.unreadable(receipt.code).expect(200);
      const line = await t.prisma.returnReceiptLine.findFirstOrThrow({
        where: {
          receiptId: (
            await t.prisma.returnReceipt.findFirstOrThrow({ where: { code: receipt.code } })
          ).id,
          kind: 'BOTTLES',
        },
      });
      const cycle = await cycleOf(k.crateCode);
      const [good, bad] = k.bottleIds as [string, string];
      const sorted = (tx: Db, bottleId: string, outcome: string, cycleId = cycle.id) =>
        tx.$executeRaw`INSERT INTO "bottle_events" ("bottle_id", "type", "occurred_at", "actor_id", "crate_cycle_id",
            "return_line_id", "operation_request_id", "payload")
          VALUES (${bottleId}::uuid, 'SORTED', now(), ${line.scannedBy}::uuid, ${cycleId}::uuid, ${line.id}::uuid,
            ${line.scanOperationId}::uuid, ${JSON.stringify({ outcome, receipt: receipt.code, crate: k.crateCode })}::jsonb)`;
      const status = (tx: Db, bottleId: string, to: string) =>
        tx.$executeRaw`UPDATE "bottles" SET "status" = ${to}::"BottleStatus" WHERE "id" = ${bottleId}::uuid`;
      const retired = (tx: Db, bottleId: string) =>
        tx.$executeRaw`INSERT INTO "bottle_events" ("bottle_id", "type", "occurred_at", "actor_id", "operation_request_id", "payload")
          VALUES (${bottleId}::uuid, 'RETIRED', now(), ${line.scannedBy}::uuid, ${line.scanOperationId}::uuid,
            '{"reason":"DEFECTIVE_AT_RETURN"}')`;
      const other = await factory.make();
      const otherCycle = await cycleOf(other.crateCode);
      await withPrivileged(async (db) => {
        // Not the latest circulation of the bottle (another cycle).
        await fails(
          db.$transaction(async (tx) => {
            await sorted(tx, good, 'RETURNED', otherCycle.id);
          }),
          /identifies the bottle's latest circulation/,
        );
        // The event alone (no status) — or a defective one without RETIRED.
        await fails(
          db.$transaction(async (tx) => {
            await sorted(tx, good, 'RETURNED');
          }),
          /SORTED leaves the bottle RETURNED/,
        );
        await fails(
          db.$transaction(async (tx) => {
            await sorted(tx, bad, 'RETIRED');
            await status(tx, bad, 'RETIRED');
          }),
          /SORTED leaves the bottle RETIRED|needs its event/,
        );
      });
      expect([await sortedOf(good), await sortedOf(bad)]).toEqual([[], []]);
      // The complete writes commit (freed with the crate: no release needed).
      await withPrivileged((db) =>
        db.$transaction(async (tx) => {
          await sorted(tx, good, 'RETURNED');
          await status(tx, good, 'RETURNED');
        }),
      );
      await withPrivileged((db) =>
        db.$transaction(async (tx) => {
          await sorted(tx, bad, 'RETIRED');
          await retired(tx, bad);
          await status(tx, bad, 'RETIRED');
        }),
      );
      expect([(await bottle(good)).status, (await bottle(bad)).status]).toEqual([
        'RETURNED',
        'RETIRED',
      ]);
      // Once per cycle.
      await withPrivileged(async (db) => {
        await fails(
          db.$transaction(async (tx) => {
            await sorted(tx, good, 'RETURNED');
          }),
          /bottle_events_one_sorted_per_cycle/,
        );
      });

      // A receipt opened before a delivery: SORTED of that circulation refused, also by SQL.
      const m = await factory.make();
      const shipped = await shipCrates(t, hotel, factory.kit.productCode, [m]);
      await pickUp(t, shipped);
      const early = await api.open();
      await api.unreadable(early.code).expect(200);
      await deliver(t, shipped);
      const earlyLine = await t.prisma.returnReceiptLine.findFirstOrThrow({
        where: { receipt: { code: early.code }, kind: 'BOTTLES' },
      });
      const mCycle = await cycleOf(m.crateCode);
      await withPrivileged(async (db) => {
        await fails(
          db.$transaction(async (tx) => {
            await tx.$executeRaw`INSERT INTO "bottle_events" ("bottle_id", "type", "occurred_at", "actor_id", "crate_cycle_id",
                "return_line_id", "operation_request_id", "payload")
              VALUES (${m.bottleIds[0]!}::uuid, 'SORTED', now(), ${earlyLine.scannedBy}::uuid, ${mCycle.id}::uuid, ${earlyLine.id}::uuid,
                ${earlyLine.scanOperationId}::uuid, '{"outcome":"RETURNED","crate":"x"}'::jsonb)`;
          }),
          /delivered before its receipt was opened/,
        );
        // A NOT_DELIVERED issue without its anchor, or with only one of the two columns.
        await fails(
          db.$executeRaw`INSERT INTO "return_receipt_issues" ("serial", "code", "receipt_id", "line_id", "kind", "bottle_id",
              "recorded_by", "record_operation_id")
            VALUES (999001, 'RI-999001', ${earlyLine.receiptId}::uuid, ${earlyLine.id}::uuid, 'NOT_DELIVERED',
              ${m.bottleIds[1]!}::uuid, ${earlyLine.scannedBy}::uuid, ${earlyLine.scanOperationId}::uuid)`,
          /names the bottle's current, not yet delivered circulation/,
        );
        await fails(
          db.$executeRaw`INSERT INTO "return_receipt_issues" ("serial", "code", "receipt_id", "line_id", "kind", "bottle_id",
              "recorded_by", "record_operation_id", "anchor_cycle_id")
            VALUES (999002, 'RI-999002', ${earlyLine.receiptId}::uuid, ${earlyLine.id}::uuid, 'NOT_DELIVERED',
              ${m.bottleIds[1]!}::uuid, ${earlyLine.scannedBy}::uuid, ${earlyLine.scanOperationId}::uuid, ${mCycle.id}::uuid)`,
          /return_receipt_issues_anchor_check|names the bottle's current, not yet delivered circulation/,
        );
      });
    });

    it('a bottle freed with its crate joins no crate before its own scan (direct SQL too); after it, it is returned', async () => {
      const { crates } = await delivered();
      const [k] = crates as [MadeCrate];
      const receipt = await api.open();
      await scanned(receipt.code, k.crateUrl);
      // A FILLING crate with a free place: its empty member removed by a supervised correction.
      const target = await factory.make('FILLING');
      const emptyOne = (await bottle(target.bottleIds[1]!)).code;
      const removed = await correctCrate(t, target.crateCode, 'remove-bottle', {
        bottle: emptyOne,
      });
      expect(removed.status, JSON.stringify(removed.body)).toBe(200);
      const tCycle = await cycleOf(target.crateCode);
      const free = (await members(tCycle.id)).find((a) => a.releasedAt !== null)!;
      const freed = k.bottleIds[0]!;
      await withPrivileged(async (db) => {
        await fails(
          db.$transaction(async (tx) => {
            const ev = await tx.$queryRaw<{ id: string }[]>`
              INSERT INTO "bottle_events" ("bottle_id", "type", "occurred_at", "actor_id", "crate_cycle_id", "operation_request_id", "payload")
              VALUES (${freed}::uuid, 'ASSIGNED_TO_CRATE', now(), ${free.assignedBy}::uuid, ${tCycle.id}::uuid,
                ${free.operationRequestId}::uuid, '{"source":"REPACKED","reason":"x"}'::jsonb) RETURNING "id"`;
            await tx.$executeRaw`INSERT INTO "crate_assignments" ("cycle_id", "cycle_capacity", "bottle_id", "ordinal", "source",
                "assigned_by", "operation_request_id", "assigned_event_id")
              VALUES (${tCycle.id}::uuid, ${tCycle.capacity}, ${freed}::uuid, ${free.ordinal}, 'REPACKED',
                ${free.assignedBy}::uuid, ${free.operationRequestId}::uuid, ${ev[0]!.id}::uuid)`;
            await tx.$executeRaw`UPDATE "crate_cycles" SET "member_count" = "member_count" + 1, "filled_count" = "filled_count" + 1
              WHERE "id" = ${tCycle.id}::uuid`;
          }),
          /freed with its returned crate joins no crate before its own return scan/,
        );
      });
      // Through the API it is refused the same way ("Doplnit lahev").
      refused(
        await correctCrate(t, target.crateCode, 'add-bottle', {
          bottle: (await bottle(freed)).code,
        }),
        409,
        'BOTTLE_AT_HOTEL',
      );
      ok(await api.scanBottle(receipt.code, k.bottleUrls[0]!));
      expect((await bottle(freed)).status).toBe('RETURNED');
    });
  });
});
