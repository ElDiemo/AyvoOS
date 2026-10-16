import { randomUUID } from 'node:crypto';
import type {
  CrateContent,
  CratePage,
  CycleCorrectionResult,
  OutsideBottlesPage,
  FillingState,
  FillScanResult,
  FinishCrateResult,
} from '@ayvo/types';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  approveDesign,
  chooseLiquidLot,
  correctCrate,
  fillingRevision,
  fillingSession,
  fillLoadCrate,
  fillScan,
  finishCrate,
  labelingKit,
  labelingSession,
  labelScan,
  loadCrate,
  registerCrate,
  setContext,
  type LabelingKit,
} from './support/labeling-fixtures.js';
import { createTestApp, hasDatabase, type TestApp } from './support/test-app.js';
import {
  drift,
  printedBottles,
  receiveBottles,
  receiveItem,
} from './support/warehouse-fixtures.js';

type Printed = Awaited<ReturnType<typeof printedBottles>>[number];

/**
 * Filling into the same crate, Hotovo and supervised corrections (doc 025 A4, owner B2–B5)
 * through the API and the real database: the filling scan accepts only members of the loaded
 * crate and consumes the cycle recipe's liquid (chosen lot) + pump exactly once — never body or
 * label again; Obsah and Naplněno are separate; only Hotovo makes a full, filled crate ready;
 * corrections move memberships without any consumption; the database enforces it on its own.
 * Crate capacity 3 (data on the crate type) keeps the scenarios short.
 */
describe.skipIf(!hasDatabase)('filling into the same crate (A4)', () => {
  let t: TestApp;
  let kit: LabelingKit;
  let versionId: string;
  let bottleLot: string;
  let pool: Printed[];
  const http = () => request(t.app.getHttpServer());
  const take = (n: number) => pool.splice(0, n);

  async function liquidLot(ml: number) {
    return (await receiveItem(t, kit.liquidItemId, ml)).lines[0]!.lot!.id;
  }
  /** A new crate with the given bottles labelled into it (a fresh labelling session). */
  async function labelled(bottles: Printed[]) {
    const ls = await labelingSession(t);
    const ctx = await setContext(t, ls, {
      productCode: kit.productCode,
      labelTemplateVersionId: versionId,
      sourceLotId: bottleLot,
    });
    expect(ctx.status, JSON.stringify(ctx.body)).toBe(200);
    const crateUrl = await registerCrate(t, kit.crateTypeCode);
    expect((await loadCrate(t, ls, crateUrl)).status).toBe(200);
    for (const b of bottles) {
      const r = await labelScan(t, ls, b.url);
      expect(r.status, JSON.stringify(r.body)).toBe(200);
    }
    const crate = await t.prisma.crate.findUniqueOrThrow({
      where: { qrToken: crateUrl.split('/').pop()! },
    });
    return { crateUrl, crateCode: crate.code, bottles };
  }
  /** A filling session with the crate loaded and the liquid lot chosen. */
  async function filling(crateUrl: string, lotId: string) {
    const fs = await fillingSession(t);
    const loaded = await fillLoadCrate(t, fs, crateUrl);
    expect(loaded.status, JSON.stringify(loaded.body)).toBe(200);
    const chosen = await chooseLiquidLot(t, fs, lotId);
    expect(chosen.status, JSON.stringify(chosen.body)).toBe(200);
    return fs;
  }
  async function fillOk(fs: string, b: Printed) {
    const r = await fillScan(t, fs, b.url);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    return r.body as FillScanResult;
  }
  const movementsOf = (bottleId: string) =>
    t.prisma.inventoryMovement.findMany({
      where: { bottleEvent: { bottleId } },
      include: { item: { select: { id: true, code: true } } },
      orderBy: { id: 'asc' },
    });
  const bottleRow = (id: string) =>
    t.prisma.bottle.findUniqueOrThrow({
      where: { id },
      include: { events: { orderBy: { recordedAt: 'asc' } }, assignments: true, components: true },
    });
  const onHand = async (lotId: string) =>
    (await t.prisma.inventoryBalance.findFirstOrThrow({ where: { lotId } })).onHand.toString();
  const ledger = async () => ({
    movements: await t.prisma.inventoryMovement.count(),
    balances: (await t.prisma.inventoryBalance.findMany({ orderBy: { id: 'asc' } })).map((b) =>
      b.onHand.toString(),
    ),
  });
  const cycleOf = (crateCode: string) =>
    t.prisma.crateCycle.findFirst({
      where: { crate: { code: crateCode }, status: { not: 'ABORTED' } },
    });

  beforeAll(async () => {
    t = await createTestApp();
    kit = await labelingKit(t, { capacity: 3 });
    await receiveItem(t, kit.pumpItemId, 500);
    bottleLot = (await receiveBottles(t, 200)).lines[0]!.lot!.id;
    pool = await printedBottles(t, 60);
    const row = await t.prisma.bottle.findUniqueOrThrow({
      where: { id: pool[0]!.id },
      include: { creationBatch: true },
    });
    versionId = row.creationBatch.labelTemplateVersionId;
    await approveDesign(t, kit.productCode, versionId);
  });
  afterAll(async () => {
    if (t) expect(await drift(t)).toEqual([]);
    await t?.close();
  });

  it('fills the same crate: liquid + pump once per bottle; Obsah ≠ Naplněno; only Hotovo readies', async () => {
    const { crateUrl, crateCode, bottles } = await labelled(take(3));
    const lot = await liquidLot(3300);
    const fs = await filling(crateUrl, lot);
    const state = (await http().get(`/api/admin/station-sessions/${fs}/filling`).expect(200))
      .body as FillingState;
    expect(state).toMatchObject({
      category: { code: 'HAND_SOAP' },
      crate: {
        code: crateCode,
        cycle: { status: 'READY_TO_FILL', memberCount: 3, filledCount: 0 },
      },
      liquidItem: { unitCode: 'ml', quantity: '330' },
      liquidLot: { id: lot, onHand: '3300' },
    });
    // 3 labelled / 0 filled is not ready.
    const early = await finishCrate(t, fs);
    expect([early.status, early.body.code]).toEqual([409, 'CRATE_NOT_COMPLETE']);

    const first = await fillOk(fs, bottles[0]!);
    expect(first).toMatchObject({
      outcome: 'FILLED',
      cycle: { status: 'FILLING', memberCount: 3, filledCount: 1 },
      liquidLot: { onHand: '2970' },
    });
    const b0 = await bottleRow(bottles[0]!.id);
    expect(b0.status).toBe('FILLED');
    const filled = b0.events.find((e) => e.type === 'FILLED')!;
    expect(filled).toMatchObject({ liquidLotId: lot, workstationSessionId: fs });
    expect(b0.assignments).toHaveLength(1); // the filling scan never assigns
    expect(b0.components.map((c) => c.componentType).sort()).toEqual(['LABEL', 'PUMP']);
    const moves = await movementsOf(bottles[0]!.id);
    expect(moves.filter((m) => m.type === 'LABEL_APPLICATION')).toHaveLength(2);
    expect(
      moves
        .filter((m) => m.type === 'FILL')
        .map((m) => [m.item.id, m.quantityDelta.toString(), m.lotId, m.bottleEventId]),
    ).toEqual(
      expect.arrayContaining([
        [kit.liquidItemId, '-330', lot, filled.id],
        [kit.pumpItemId, '-1', null, filled.id],
      ]),
    );
    expect(moves.filter((m) => m.type === 'FILL')).toHaveLength(2);

    const partial = await finishCrate(t, fs);
    expect([partial.status, partial.body.code, partial.body.details]).toEqual([
      409,
      'CRATE_NOT_COMPLETE',
      { memberCount: 3, filledCount: 1, capacity: 3 },
    ]);
    await fillOk(fs, bottles[1]!);
    const third = await fillOk(fs, bottles[2]!);
    // 3/3 filled is still FILLING until Hotovo.
    expect(third.cycle).toMatchObject({ status: 'FILLING', memberCount: 3, filledCount: 3 });
    const done = await finishCrate(t, fs);
    expect(done.status, JSON.stringify(done.body)).toBe(200);
    expect((done.body as FinishCrateResult).cycle.status).toBe('FILLED');
    const events = await t.prisma.crateEvent.findMany({
      where: { crate: { code: crateCode } },
      orderBy: [{ occurredAt: 'asc' }, { id: 'asc' }],
    });
    expect(events.map((e) => e.type)).toEqual([
      'REGISTERED',
      'CYCLE_OPENED',
      'READY_TO_FILL',
      'FILLING_STARTED',
      'CRATE_FILLED',
    ]);
    // The ready crate left the station; it cannot be loaded for filling again.
    const after = (await http().get(`/api/admin/station-sessions/${fs}/filling`).expect(200))
      .body as FillingState;
    expect(after.crate).toBeNull();
    const again = await fillLoadCrate(t, fs, crateUrl);
    expect([again.status, again.body.code]).toEqual([409, 'CRATE_ALREADY_FILLED']);
    expect(await onHand(lot)).toBe('2310');
  });

  it('duplicates write nothing, a retried request replays, concurrent scans consume once', async () => {
    const { crateUrl, bottles } = await labelled(take(3));
    const lot = await liquidLot(3300);
    const fs = await filling(crateUrl, lot);
    const requestId = randomUUID();
    const first = await fillScan(t, fs, bottles[0]!.url, requestId);
    expect(first.status).toBe(200);
    const replay = await fillScan(t, fs, bottles[0]!.url, requestId);
    expect(replay.body).toEqual(first.body);
    const dup = await fillScan(t, fs, bottles[0]!.url);
    expect([dup.status, (dup.body as FillScanResult).outcome]).toEqual([200, 'ALREADY_FILLED']);
    expect(await movementsOf(bottles[0]!.id)).toHaveLength(4); // body, label, liquid, pump

    const revision = await fillingRevision(t, fs);
    const raced = await Promise.all(
      [bottles[1]!, bottles[1]!, bottles[2]!, bottles[2]!].map((b) =>
        fillScan(t, fs, b.url, randomUUID(), revision),
      ),
    );
    expect(raced.map((r) => r.status)).toEqual([200, 200, 200, 200]);
    expect(raced.map((r) => (r.body as FillScanResult).outcome).sort()).toEqual([
      'ALREADY_FILLED',
      'ALREADY_FILLED',
      'FILLED',
      'FILLED',
    ]);
    for (const b of bottles) {
      expect((await movementsOf(b.id)).filter((m) => m.type === 'FILL')).toHaveLength(2);
    }
    expect(await onHand(lot)).toBe('2310');
  });

  it('refuses foreign, unlabelled, removed and wrong-category bottles and crates — no write', async () => {
    const a = await labelled(take(3));
    const b = await labelled(take(1)); // still assembling
    const [unlabelled] = take(1);
    const lot = await liquidLot(3300);
    const fs = await fillingSession(t);
    const notReady = await fillLoadCrate(t, fs, b.crateUrl);
    expect([notReady.status, notReady.body.code]).toEqual([409, 'CRATE_NOT_READY']);
    expect((await fillLoadCrate(t, fs, a.crateUrl)).status).toBe(200);
    const noLot = await fillScan(t, fs, a.bottles[0]!.url);
    expect([noLot.status, noLot.body.code]).toEqual([409, 'CONTEXT_INCOMPLETE']);
    const wrongLot = await chooseLiquidLot(t, fs, bottleLot);
    expect([wrongLot.status, wrongLot.body.code]).toEqual([422, 'WRONG_LOT']);
    expect((await chooseLiquidLot(t, fs, lot)).status).toBe(200);

    const before = await ledger();
    const events = await t.prisma.bottleEvent.count();
    const foreign = await fillScan(t, fs, b.bottles[0]!.url);
    expect([foreign.status, foreign.body.code, foreign.body.details]).toEqual([
      409,
      'IN_ANOTHER_CRATE',
      { crate: b.crateCode },
    ]);
    const bare = await fillScan(t, fs, unlabelled!.url);
    expect([bare.status, bare.body.code]).toEqual([409, 'BOTTLE_NOT_LABELED']);
    const crateQr = await fillScan(t, fs, a.crateUrl);
    expect([crateQr.status, crateQr.body.code]).toEqual([422, 'NOT_A_BOTTLE']);
    // A bottle removed from its crate is in no crate: refused, never re-assigned silently.
    await correctCrate(t, b.crateCode, 'remove-bottle', { bottle: b.bottles[0]!.code }).expect(200);
    const outside = await fillScan(t, fs, b.bottles[0]!.url);
    expect([outside.status, outside.body.code]).toEqual([409, 'NOT_IN_THIS_CRATE']);
    expect(await ledger()).toEqual(before);
    expect(await t.prisma.bottleEvent.count()).toBe(events + 1); // only REMOVED_FROM_CRATE

    // A filling station of another category never loads this crate.
    const shower = await fillingSession(t, 'SHOWER_GEL');
    const wrongCategory = await fillLoadCrate(t, shower, a.crateUrl);
    expect([wrongCategory.status, wrongCategory.body.code]).toEqual([422, 'WRONG_CATEGORY']);
  });

  it('a lot switch applies from the next bottle; a scan from before it is refused; one lot each', async () => {
    const { crateUrl, bottles } = await labelled(take(3));
    const l1 = await liquidLot(3300);
    const l2 = await liquidLot(3300);
    const fs = await filling(crateUrl, l1);
    await fillOk(fs, bottles[0]!);
    const old = await fillingRevision(t, fs);
    expect((await chooseLiquidLot(t, fs, l2)).status).toBe(200);
    const stale = await fillScan(t, fs, bottles[1]!.url, randomUUID(), old);
    expect([stale.status, stale.body.code]).toEqual([409, 'CONTEXT_CHANGED']);
    expect((await bottleRow(bottles[1]!.id)).status).toBe('LABELED_EMPTY');
    await fillOk(fs, bottles[1]!);
    await fillOk(fs, bottles[2]!);
    const lots = await t.prisma.bottleEvent.findMany({
      where: { type: 'FILLED', bottleId: { in: bottles.map((b) => b.id) } },
      select: { bottleId: true, liquidLotId: true },
    });
    expect(new Map(lots.map((e) => [e.bottleId, e.liquidLotId]))).toEqual(
      new Map([
        [bottles[0]!.id, l1],
        [bottles[1]!.id, l2],
        [bottles[2]!.id, l2],
      ]),
    );
    expect([await onHand(l1), await onHand(l2)]).toEqual(['2970', '2640']);
  });

  it('an exhausted liquid lot refuses without a partial write', async () => {
    const { crateUrl, bottles } = await labelled(take(3));
    const lot = await liquidLot(330);
    const fs = await filling(crateUrl, lot);
    await fillOk(fs, bottles[0]!);
    const before = await ledger();
    const empty = await fillScan(t, fs, bottles[1]!.url);
    expect([empty.status, empty.body.code]).toEqual([409, 'LOT_EXHAUSTED']);
    expect(await ledger()).toEqual(before);
    const b1 = await bottleRow(bottles[1]!.id);
    expect([b1.status, b1.components.length]).toEqual(['LABELED_EMPTY', 1]);
  });

  it('scenario 1: abort a filled crate → finished bottles outside → repack into an empty crate → Hotovo', async () => {
    const a = await labelled(take(3));
    const loose = await labelled(take(1));
    await correctCrate(t, loose.crateCode, 'remove-bottle', { bottle: loose.bottles[0]!.code });
    const lot = await liquidLot(3300);
    const fs = await filling(a.crateUrl, lot);
    for (const b of a.bottles) await fillOk(fs, b);
    const ledgerAfterFills = await ledger();

    const aborted = await correctCrate(t, a.crateCode, 'abort-cycle', { reason: 'nová bedna' });
    expect(aborted.status, JSON.stringify(aborted.body)).toBe(200);
    expect((aborted.body as CycleCorrectionResult).cycle).toBeNull();
    for (const b of a.bottles) {
      const row = await bottleRow(b.id);
      expect(row.status).toBe('FILLED'); // never re-emptied
      expect(row.assignments.every((x) => x.releasedAt !== null)).toBe(true);
      expect(row.events.at(-1)!.type).toBe('REMOVED_FROM_CRATE');
    }
    // A labelled EMPTY bottle never opens an empty crate.
    const c = await registerCrate(t, kit.crateTypeCode);
    const cCode = (
      await t.prisma.crate.findUniqueOrThrow({ where: { qrToken: c.split('/').pop()! } })
    ).code;
    const empty = await correctCrate(t, cCode, 'add-bottle', { bottle: loose.bottles[0]!.code });
    expect([empty.status, empty.body.code]).toEqual([409, 'EMPTY_CRATE_TAKES_FINISHED']);

    // Přeložit hotové lahve: the first opens a FILLING cycle with the bottles' snapshot.
    for (const [i, b] of a.bottles.entries()) {
      const added = await correctCrate(t, cCode, 'add-bottle', { bottle: b.url });
      expect(added.status, JSON.stringify(added.body)).toBe(200);
      expect((added.body as CycleCorrectionResult).cycle).toMatchObject({
        status: 'FILLING',
        memberCount: i + 1,
        filledCount: i + 1,
        recipeVersion: 1,
      });
    }
    const full = await correctCrate(t, cCode, 'add-bottle', { bottle: loose.bottles[0]!.code });
    expect([full.status, full.body.code]).toEqual([409, 'CRATE_FULL']);
    const assignments = await t.prisma.crateAssignment.findMany({
      where: { cycle: { crate: { code: cCode } } },
      orderBy: { ordinal: 'asc' },
    });
    expect(assignments.map((x) => [x.ordinal, x.source])).toEqual([
      [1, 'REPACKED'],
      [2, 'REPACKED'],
      [3, 'REPACKED'],
    ]);
    const fs2 = await fillingSession(t);
    expect((await fillLoadCrate(t, fs2, c)).status).toBe(200);
    const done = await finishCrate(t, fs2);
    expect(done.status, JSON.stringify(done.body)).toBe(200);
    // No step after the original fills touched the ledger.
    expect(await ledger()).toEqual(ledgerAfterFills);
  });

  it('scenario 2: remove the only filled bottle → still FILLING → replace → fill all → Hotovo; reopen', async () => {
    const a = await labelled(take(3));
    const b = await labelled(take(1));
    const lot = await liquidLot(3300);
    const fs = await filling(a.crateUrl, lot);
    await fillOk(fs, a.bottles[0]!);
    const removed = await correctCrate(t, a.crateCode, 'remove-bottle', {
      bottle: a.bottles[0]!.url,
      reason: 'prasklá pumpička',
    });
    expect((removed.body as CycleCorrectionResult).cycle).toMatchObject({
      status: 'FILLING', // sticky
      memberCount: 2,
      filledCount: 0,
    });
    expect((await bottleRow(a.bottles[0]!.id)).status).toBe('FILLED');
    // A labelled empty from another crate replaces it (Doplnit).
    await correctCrate(t, b.crateCode, 'remove-bottle', { bottle: b.bottles[0]!.code }).expect(200);
    const replaced = await correctCrate(t, a.crateCode, 'add-bottle', {
      bottle: b.bottles[0]!.code,
    });
    expect((replaced.body as CycleCorrectionResult).cycle).toMatchObject({
      status: 'FILLING',
      memberCount: 3,
      filledCount: 0,
    });
    const source = await t.prisma.crateAssignment.findFirstOrThrow({
      where: { bottleId: b.bottles[0]!.id, releasedAt: null },
    });
    expect([source.source, source.ordinal]).toEqual(['REPLACEMENT', 1]);
    // The station re-reads the crate: fill the three members by normal scans.
    for (const x of [a.bottles[1]!, a.bottles[2]!, b.bottles[0]!]) await fillOk(fs, x);
    expect((await finishCrate(t, fs)).status).toBe(200);
    for (const x of [...a.bottles, b.bottles[0]!]) {
      const fills = await t.prisma.bottleEvent.count({ where: { bottleId: x.id, type: 'FILLED' } });
      expect(fills).toBe(1); // the removed bottle keeps its single fill
    }
    // A ready crate is corrected only after "Vrátit do rozpracování".
    const blocked = await correctCrate(t, a.crateCode, 'remove-bottle', {
      bottle: a.bottles[1]!.code,
    });
    expect([blocked.status, blocked.body.code]).toEqual([409, 'CRATE_READY']);
    const reopened = await correctCrate(t, a.crateCode, 'reopen', { reason: 'kontrola obsahu' });
    expect((reopened.body as CycleCorrectionResult).cycle?.status).toBe('FILLING');
    const fs2 = await fillingSession(t);
    expect((await fillLoadCrate(t, fs2, a.crateUrl)).status).toBe(200);
    expect((await finishCrate(t, fs2)).status).toBe(200);
    expect((await cycleOf(a.crateCode))!.status).toBe('FILLED');
  });

  it('overview (A5): states with both counts, crate content with lots, bottles outside a crate', async () => {
    const a = await labelled(take(3));
    const lot = await liquidLot(3300);
    const fs = await filling(a.crateUrl, lot);
    await fillOk(fs, a.bottles[0]!);
    const lotCode = (await t.prisma.inventoryLot.findUniqueOrThrow({ where: { id: lot } })).code;

    const page = (
      await http().get('/api/admin/crates').query({ state: 'FILLING', pageSize: 100 }).expect(200)
    ).body as CratePage;
    expect(page.items.find((c) => c.code === a.crateCode)?.cycle).toMatchObject({
      status: 'FILLING',
      memberCount: 3,
      filledCount: 1,
      recipeVersion: 1,
    });
    expect(page.items.every((c) => c.cycle?.status === 'FILLING')).toBe(true);
    expect(page.stateCounts.FILLING).toBeGreaterThanOrEqual(1);
    const all = (await http().get('/api/admin/crates').query({ pageSize: 1 }).expect(200))
      .body as CratePage;
    expect(Object.values(all.stateCounts).reduce((x, y) => x + y, 0)).toBe(all.total);

    const content = (await http().get(`/api/admin/crates/${a.crateCode}/content`).expect(200))
      .body as CrateContent;
    expect(content.cycle).toMatchObject({ status: 'FILLING', memberCount: 3, filledCount: 1 });
    expect(
      content.members.map((m) => [m.ordinal, m.bottle.code, m.bottle.status, m.liquidLot]),
    ).toEqual([
      [1, a.bottles[0]!.code, 'FILLED', lotCode],
      [2, a.bottles[1]!.code, 'LABELED_EMPTY', null],
      [3, a.bottles[2]!.code, 'LABELED_EMPTY', null],
    ]);

    await correctCrate(t, a.crateCode, 'remove-bottle', {
      bottle: a.bottles[0]!.code,
      reason: 'odložena',
    }).expect(200);
    await correctCrate(t, a.crateCode, 'remove-bottle', {
      bottle: a.bottles[1]!.code,
      reason: 'poškozená',
    }).expect(200);
    const find = async (group: string, search: string) =>
      (
        (await http().get('/api/admin/bottles-outside-crates').query({ group, search }).expect(200))
          .body as OutsideBottlesPage
      ).items;
    expect(await find('finished', a.bottles[0]!.code)).toEqual([
      expect.objectContaining({
        status: 'FILLED',
        liquidLot: lotCode,
        lastCrate: a.crateCode,
        reason: 'odložena',
        recipeVersion: 1,
      }),
    ]);
    // Found by the scanned QR as well.
    expect(await find('labelledEmpty', a.bottles[1]!.url)).toEqual([
      expect.objectContaining({
        code: a.bottles[1]!.code,
        status: 'LABELED_EMPTY',
        lastCrate: a.crateCode,
        reason: 'poškozená',
      }),
    ]);
    expect(await find('labelledEmpty', a.bottles[2]!.code)).toEqual([]); // still in the crate
    expect(await find('finished', 'nesmysl')).toEqual([]); // never "everything"
    const detail = (await http().get(`/api/admin/crates/${a.crateCode}`).expect(200)).body as {
      events: { type: string; bottle: string | null; reason: string | null }[];
    };
    expect(detail.events.filter((e) => e.type === 'MEMBER_REMOVED')).toEqual([
      expect.objectContaining({ bottle: a.bottles[0]!.code, reason: 'odložena' }),
      expect.objectContaining({ bottle: a.bottles[1]!.code, reason: 'poškozená' }),
    ]);
  });

  it('enforces the A4 rules in the database on its own', async () => {
    const { crateCode, bottles } = await labelled(take(3));
    const cycle = (await cycleOf(crateCode))!;
    // A bottle is FILLED only with its FILLED event (and the counters follow).
    await expect(
      t.prisma.$transaction(async (tx) => {
        await tx.$executeRaw`UPDATE "bottles" SET "status" = 'FILLED' WHERE "id" = ${bottles[0]!.id}::uuid`;
      }),
    ).rejects.toThrow(/AYVO/);
    // Counters never drift from the members.
    await expect(
      t.prisma.$transaction(async (tx) => {
        await tx.$executeRaw`UPDATE "crate_cycles" SET "filled_count" = 1 WHERE "id" = ${cycle.id}::uuid`;
      }),
    ).rejects.toThrow(/AYVO|check/);
    // FILLING is never entered without a filled member; FILLED never without Hotovo.
    await expect(
      t.prisma.$transaction(async (tx) => {
        await tx.$executeRaw`UPDATE "crate_cycles" SET "status" = 'FILLING' WHERE "id" = ${cycle.id}::uuid`;
      }),
    ).rejects.toThrow(/AYVO/);
    await expect(
      t.prisma.$transaction(async (tx) => {
        await tx.$executeRaw`UPDATE "crate_cycles" SET "status" = 'FILLED', "filled_at" = now() WHERE "id" = ${cycle.id}::uuid`;
      }),
    ).rejects.toThrow(/AYVO/);
    // A FILLED event only for an active member of a crate in filling.
    const [stranger] = take(1);
    const lot = await liquidLot(330);
    const actor = await t.prisma.user.findFirstOrThrow();
    await expect(
      t.prisma.$transaction(async (tx) => {
        await tx.bottleEvent.create({
          data: {
            bottleId: stranger!.id,
            type: 'FILLED',
            occurredAt: new Date(),
            actorId: actor.id,
            crateCycleId: cycle.id,
            liquidLotId: lot,
          },
        });
      }),
    ).rejects.toThrow(/AYVO/);
    expect((await t.prisma.crateCycle.findUniqueOrThrow({ where: { id: cycle.id } })).status).toBe(
      'READY_TO_FILL',
    );
  });
});
