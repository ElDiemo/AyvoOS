import { randomUUID } from 'node:crypto';
import type { BottleCirculation } from '@ayvo/types';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { testCarrierControl } from '../src/carriers/test-carrier.js';
import {
  chooseLiquidLot,
  fillingSession,
  fillLoadCrate,
  fillScan,
  finishCrate,
  labelingSession,
  labelScan,
  loadCrate,
  setContext,
} from './support/labeling-fixtures.js';
import { crateFactory, createHotel, type MadeCrate } from './support/order-fixtures.js';
import { deliver, pickUp, RETURN_ENV, returnsApi, shipCrates } from './support/return-fixtures.js';
import { createTestApp, hasDatabase, type TestApp } from './support/test-app.js';

type Factory = Awaited<ReturnType<typeof crateFactory>>;

/**
 * The owner's acceptance walk of the closed bottle cycle (2026-11-18/19), end to end on the
 * integration of R3-a/R3-b (#152/#154), R1.1 (#197) and the bottle view R3-c (#160): one crate K
 * of 10 bottles — 10 shipped / 8 received, K reusable at once, the 2 missing never counted and
 * traceable at the hotel, a late return from K's first circulation after K went out again,
 * duplicate and concurrent scans, and the same crate K and bottle b through two whole
 * circulations (reuse 0 → 1 → 2) with each filling consumed exactly once. FAKE test carrier and
 * synthetic data only.
 */
describe.skipIf(!hasDatabase)('acceptance: the closed bottle cycle', () => {
  let t: TestApp;
  let ten: Factory;
  let hotel: string;
  let api: ReturnType<typeof returnsApi>;
  const http = () => request(t.app.getHttpServer());
  const wash = (url: string) =>
    http()
      .post('/api/admin/returns/after-wash')
      .send({ requestId: randomUUID(), scannedValue: url });
  const code = async (id: string) =>
    (await t.prisma.bottle.findUniqueOrThrow({ where: { id } })).code;
  const reuse = async (id: string) =>
    (
      await http()
        .get(`/api/admin/bottles/${await code(id)}`)
        .expect(200)
    ).body.reuseCycles as number;
  const status = async (id: string) =>
    (await t.prisma.bottle.findUniqueOrThrow({ where: { id } })).status;
  const sortedCycles = async (id: string) =>
    (
      await t.prisma.bottleEvent.findMany({
        where: { bottleId: id, type: 'SORTED' },
        orderBy: { id: 'asc' },
      })
    ).map((e) => e.crateCycleId);
  const cycleOf = (crateCode: string) =>
    t.prisma.crateCycle.findFirstOrThrow({
      where: { crate: { code: crateCode } },
      orderBy: { openedAt: 'desc' },
    });
  const view = async (id: string) => {
    const c = await code(id);
    const r = await http().get('/api/admin/bottle-circulation').query({ codes: c }).expect(200);
    return (r.body.items as BottleCirculation[])[0]!;
  };
  const balance = async (itemId: string) =>
    Number(
      (await t.prisma.inventoryBalance.aggregate({ where: { itemId }, _sum: { onHand: true } }))
        ._sum.onHand,
    );
  const fillMovements = (bottleId: string) =>
    t.prisma.bottleEvent.count({ where: { bottleId, type: 'FILLED' } });
  const send = async (dispatch: MadeCrate[]) => {
    const o = await shipCrates(t, hotel, ten.kit.productCode, dispatch);
    await pickUp(t, o);
    await deliver(t, o);
    return o;
  };

  beforeAll(async () => {
    t = await createTestApp(RETURN_ENV);
    testCarrierControl.reset();
    testCarrierControl.rules.parcelWeight = 'NOT_USED';
    ten = await crateFactory(t, { capacity: 10 });
    hotel = (await createHotel(t, { name: 'Hotel Akceptace' })).code;
    api = returnsApi(t);
  });
  afterAll(async () => {
    testCarrierControl.reset();
    await t?.close();
  });

  it('10 shipped / 8 received, K reusable at once, 2 missing traceable, a late return, duplicates, two whole circulations 0 → 1 → 2', async () => {
    // Circulation 1 of K: ten bottles, shipped and delivered.
    const k = await ten.make();
    const b = k.bottleIds.map((id, i) => ({ id, url: k.bottleUrls[i]! }));
    for (const x of b) expect(await reuse(x.id)).toBe(0);
    const o1 = await send([k]);
    const k1 = await cycleOf(k.crateCode);
    expect(k1.status).toBe('DELIVERED');

    // Three bottles come back before their crate.
    const r1 = await api.open(hotel);
    for (const x of b.slice(0, 3))
      expect((await api.scanBottle(r1.code, x.url).expect(200)).body.outcome).toBe('IDENTIFIED');
    // The crate scan frees K at once (7 still bound) and counts nothing.
    expect((await api.scanCrate(r1.code, k.crateUrl).expect(200)).body.freed).toBe(7);
    expect((await cycleOf(k.crateCode)).status).toBe('CLOSED');
    expect(await reuse(b[3]!.id)).toBe(0);
    // K is reusable at once: its next circulation with ten new bottles, before the rest is scanned.
    const kAgain = await ten.make('FILLED', undefined, k.crateUrl);
    const k2 = await cycleOf(k.crateCode);
    expect([k2.id === k1.id, k2.status]).toEqual([false, 'FILLED']);

    // Duplicates: the same request again is the first answer; a rescan counts nothing.
    const rid = randomUUID();
    const first = (await api.scanBottle(r1.code, b[3]!.url, 'GOOD', rid).expect(200)).body;
    expect((await api.scanBottle(r1.code, b[3]!.url, 'GOOD', rid).expect(200)).body).toEqual(first);
    expect((await api.scanBottle(r1.code, b[3]!.url).expect(200)).body.repeated).toBe(true);
    // Concurrent: b4 in two receipts at once — one identification.
    const r1b = await api.open(hotel);
    const both = await Promise.all([
      api.scanBottle(r1.code, b[4]!.url),
      api.scanBottle(r1b.code, b[4]!.url),
    ]);
    expect(
      both.filter((r) => r.status === 200 && r.body.outcome === 'IDENTIFIED' && !r.body.repeated),
    ).toHaveLength(1);
    expect(await sortedCycles(b[4]!.id)).toEqual([k1.id]);
    // b5, b6 good; b7 defective.
    await api.scanBottle(r1.code, b[5]!.url).expect(200);
    await api.scanBottle(r1.code, b[6]!.url).expect(200);
    expect((await api.scanBottle(r1.code, b[7]!.url, 'DEFECTIVE').expect(200)).body.result).toBe(
      'RETIRED',
    );
    await api.close(r1.code).expect(200);
    await api.close(r1b.code).expect(200);

    // 8 received (each once, all for K1), 2 missing: not counted, still at the hotel with order O1.
    for (const x of b.slice(0, 8)) {
      expect(await sortedCycles(x.id)).toEqual([k1.id]);
      expect(await reuse(x.id)).toBe(1);
    }
    for (const x of b.slice(8)) {
      expect([await status(x.id), await reuse(x.id)]).toEqual(['FILLED', 0]);
      const v = await view(x.id);
      expect(v.location).toMatchObject({ kind: 'AT_HOTEL', orderCode: o1.order });
      expect(v.crate).toBeNull(); // freed with K, in no crate
    }
    expect(
      (await t.prisma.crateAssignment.findMany({ where: { cycleId: k1.id } }))
        .map((a) => a.releaseReason)
        .sort(),
    ).toEqual([...Array(3).fill('RETURN_IDENTIFIED'), ...Array(7).fill('CRATE_RETURNED')].sort());

    // K's second circulation goes out; b8 of K1 comes back only now: counted for K1, b9 stays.
    await send([kAgain]);
    const late = await api.open(hotel);
    expect((await api.scanBottle(late.code, b[8]!.url).expect(200)).body.outcome).toBe(
      'IDENTIFIED',
    );
    expect(await sortedCycles(b[8]!.id)).toEqual([k1.id]);
    expect((await view(b[9]!.id)).location).toMatchObject({
      kind: 'AT_HOTEL',
      orderCode: o1.order,
    });
    // K2 back: freed (ten bound), its ten bottles back on their own.
    expect((await api.scanCrate(late.code, k.crateUrl).expect(200)).body.freed).toBe(10);
    for (const url of kAgain.bottleUrls) await api.scanBottle(late.code, url).expect(200);
    await api.close(late.code).expect(200);

    // Po mytí → K plnění: the 8 good of K1 (b0–b6, b8) and two of K2's bottles.
    const washed = [
      ...b.slice(0, 7),
      b[8]!,
      ...kAgain.bottleIds.slice(0, 2).map((id, i) => ({ id, url: kAgain.bottleUrls[i]! })),
    ];
    for (const x of washed) expect((await wash(x.url)).status).toBe(200);
    expect((await wash(b[0]!.url)).body.repeated).toBe(true); // a rescan writes nothing

    // Circulation 3 of K = the 2nd whole circulation of b0: the same crate, the same QR codes,
    // ten washed bottles placed at the ordinary station (their design; no lot of new bottles).
    const design = (
      await t.prisma.bottle.findUniqueOrThrow({
        where: { id: b[0]!.id },
        include: { creationBatch: true },
      })
    ).creationBatch.labelTemplateVersionId;
    const session = await labelingSession(t);
    expect(
      (
        await setContext(t, session, {
          productCode: ten.kit.productCode,
          labelTemplateVersionId: design,
          sourceLotId: null,
        })
      ).status,
    ).toBe(200);
    expect((await loadCrate(t, session, k.crateUrl)).status).toBe(200);
    const movements = await t.prisma.inventoryMovement.count();
    for (const x of washed) {
      const r = await labelScan(t, session, x.url);
      expect(r.body.outcome, JSON.stringify(r.body)).toBe('PLACED');
    }
    expect(await t.prisma.inventoryMovement.count()).toBe(movements); // placing consumes nothing
    const k3 = await cycleOf(k.crateCode);
    expect([k3.status, k3.memberCount]).toEqual(['READY_TO_FILL', 10]);
    const fs = await fillingSession(t, 'HAND_SOAP');
    expect((await fillLoadCrate(t, fs, k.crateUrl)).status).toBe(200);
    expect((await chooseLiquidLot(t, fs, await ten.receiveLiquid())).status).toBe(200);
    const pumps = await balance(ten.kit.pumpItemId);
    const liquid = await balance(ten.kit.liquidItemId);
    const before = await fillMovements(b[0]!.id);
    for (const x of washed) expect((await fillScan(t, fs, x.url)).status).toBe(200);
    // A repeated filling scan of b0 consumes nothing more.
    await fillScan(t, fs, b[0]!.url);
    expect(await fillMovements(b[0]!.id)).toBe(before + 1);
    expect((await finishCrate(t, fs)).status).toBe(200);
    // Exactly the real fillings: 10 × 330 ml of the reuse recipe, no new pump.
    expect(liquid - (await balance(ten.kit.liquidItemId))).toBe(10 * 330);
    expect(await balance(ten.kit.pumpItemId)).toBe(pumps);
    expect(await reuse(b[0]!.id)).toBe(1); // filling and delivery complete nothing
    await send([{ ...k, bottleIds: [], bottleUrls: [] }]);
    expect(await reuse(b[0]!.id)).toBe(1);

    // Back again: K freed, b0 received — its second completed circulation, the same crate K.
    const r3 = await api.open(hotel);
    expect((await api.scanCrate(r3.code, k.crateUrl).expect(200)).body.freed).toBe(10);
    await api.scanBottle(r3.code, b[0]!.url).expect(200);
    expect(await reuse(b[0]!.id)).toBe(2);
    expect(await sortedCycles(b[0]!.id)).toEqual([k1.id, k3.id]);
    // b9 is still traceable at the hotel with its first order; never counted.
    expect([await reuse(b[9]!.id), (await view(b[9]!.id)).location.orderCode]).toEqual([
      0,
      o1.order,
    ]);
  });
});
