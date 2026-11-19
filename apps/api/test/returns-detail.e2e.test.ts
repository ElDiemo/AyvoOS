import { RETURN_RECENT_BOTTLES, type ReturnReceiptDetail } from '@ayvo/types';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { testCarrierControl } from '../src/carriers/test-carrier.js';
import { crateFactory, createHotel } from './support/order-fixtures.js';
import { deliver, RETURN_ENV, returnsApi, shipCrates } from './support/return-fixtures.js';
import { createTestApp, hasDatabase, type TestApp } from './support/test-app.js';

/**
 * The receipt detail of a large intake (R1.1): read in a fixed number of queries, and with
 * `?bottles=recent` only the latest bottles of each line — the counts, lines and issues stay
 * complete and current (also another operator's scans). FAKE test carrier, synthetic data.
 */
describe.skipIf(!hasDatabase)('return receipt detail: complete counts, recent bottles', () => {
  let t: TestApp;
  let api: ReturnType<typeof returnsApi>;
  const http = () => request(t.app.getHttpServer());
  const get = async (code: string, query = '') =>
    (await http().get(`/api/admin/returns/receipts/${code}${query}`).expect(200))
      .body as ReturnReceiptDetail;
  const ok = (r: request.Response) => expect(r.status, JSON.stringify(r.body)).toBe(200);
  /** Everything but the bottle lists. */
  const withoutBottles = (d: ReturnReceiptDetail) => ({
    ...d,
    lineDetails: d.lineDetails.map(({ bottles: _bottles, ...l }) => l),
  });

  beforeAll(async () => {
    t = await createTestApp(RETURN_ENV);
    api = returnsApi(t);
    testCarrierControl.reset();
    testCarrierControl.rules.parcelWeight = 'NOT_USED';
  });
  afterAll(async () => {
    testCarrierControl.reset();
    await t?.close();
  });

  it('3 crates × 10: the recent view keeps every count, line and issue; its bottles are the tail of the full list', async () => {
    const f = await crateFactory(t, { capacity: 10 });
    const hotel = (await createHotel(t, { name: 'Hotel Velký příjem' })).code;
    // One order line takes one label design (a pool holds two crates): K + L, then M on its own.
    const k = await f.make();
    const l = await f.make();
    await deliver(t, await shipCrates(t, hotel, f.kit.productCode, [k, l]));
    await f.refill();
    const m = await f.make();
    await deliver(t, await shipCrates(t, hotel, f.kit.productCode, [m]));
    const receipt = await api.open(hotel);
    // K first (freed 10), then its bottles; L's bottles before L (freed 0); M never scanned.
    ok(await api.scanCrate(receipt.code, k.crateUrl));
    for (const [i, url] of k.bottleUrls.entries())
      ok(await api.scanBottle(receipt.code, url, i === 0 ? 'DEFECTIVE' : 'GOOD'));
    for (const url of l.bottleUrls) ok(await api.scanBottle(receipt.code, url));
    ok(await api.scanCrate(receipt.code, l.crateUrl));
    for (const url of m.bottleUrls.slice(0, 5)) ok(await api.scanBottle(receipt.code, url));
    ok(await api.unreadable(receipt.code));

    const all = await get(receipt.code, '?bottles=all');
    const plain = await get(receipt.code);
    const recent = await get(receipt.code, '?bottles=recent');
    expect(plain).toEqual(all);
    expect(all.counts).toEqual({ crates: 2, identified: 25, defective: 1, unreadable: 1 });
    expect([all.identified, all.openIssues, all.lines]).toEqual([25, 1, 3]);
    const crateLine = (d: ReturnReceiptDetail, code: string) =>
      d.lineDetails.find((x) => x.crateCode === code)!;
    expect(crateLine(all, k.crateCode)).toMatchObject({
      freedWithCrate: 10,
      bottleCount: 0,
      recordedCount: 0,
      history: { shipped: 10, identified: 10, withoutConfirmedReturn: 0 },
    });
    expect(crateLine(all, l.crateCode)).toMatchObject({
      freedWithCrate: 0,
      history: { shipped: 10, identified: 10, withoutConfirmedReturn: 0 },
    });
    const bottles = all.lineDetails.find((x) => x.kind === 'BOTTLES')!;
    expect([bottles.bottleCount, bottles.bottles.length, bottles.recordedCount]).toEqual([
      25, 25, 26,
    ]);
    expect(bottles.bottles[0]).toMatchObject({ outcome: 'RETIRED', crateCode: k.crateCode });
    expect(bottles.bottles.at(-1)).toMatchObject({ outcome: 'RETURNED', crateCode: m.crateCode });
    expect(new Set(bottles.bottles.map((b) => b.orderCode)).size).toBe(2);
    expect(bottles.bottles[0]!.orderCode).toMatch(/^ORD-/);

    // The recent view: the same receipt but the bottle lists.
    expect(withoutBottles(recent)).toEqual(withoutBottles(all));
    const recentBottles = recent.lineDetails.find((x) => x.kind === 'BOTTLES')!;
    expect(recentBottles.bottles).toEqual(bottles.bottles.slice(-RETURN_RECENT_BOTTLES));
    expect(recentBottles.bottles).toHaveLength(20);

    // Another operator's scan is in the next recent view: count, list and the line's total.
    ok(await api.scanBottle(receipt.code, m.bottleUrls[5]!));
    const next = await get(receipt.code, '?bottles=recent');
    expect(next.counts.identified).toBe(26);
    const nextBottles = next.lineDetails.find((x) => x.kind === 'BOTTLES')!;
    expect(nextBottles.bottleCount).toBe(26);
    expect(nextBottles.bottles.at(-1)!.bottleCode).toBe(
      (await t.prisma.bottle.findUniqueOrThrow({ where: { id: m.bottleIds[5]! } })).code,
    );
  });

  it('an unknown view is refused', async () => {
    const receipt = await api.open(null);
    await http().get(`/api/admin/returns/receipts/${receipt.code}?bottles=some`).expect(400);
  });
});
