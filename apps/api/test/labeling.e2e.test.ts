import { randomUUID } from 'node:crypto';
import type { CratePage, LabelingState, LabelScanResult } from '@ayvo/types';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  approveDesign,
  labelingKit,
  labelingSession,
  labelScan,
  loadCrate,
  registerCrate,
  setContext,
  type LabelingKit,
} from './support/labeling-fixtures.js';
import { createTestApp, hasDatabase, TEST_QR_BASE_URL, type TestApp } from './support/test-app.js';
import { drift, printedBottles, receiveBottles } from './support/warehouse-fixtures.js';

type Printed = Awaited<ReturnType<typeof printedBottles>>[number];

/**
 * Labelling into crates (doc 025 A3, owner B1–B4) through the API and the real database: one
 * labelling scan = label applied + bottle into the crate + body and label consumed exactly once +
 * permanent product binding; duplicates and replays write nothing; the crate never mixes products
 * or designs and never takes a 41st bottle; the label design must be the chosen, approved one;
 * legacy and foreign bottles are refused, never moved; the recipe snapshot of an open crate never
 * changes; the standalone application is retired; the database enforces it all on its own.
 */
describe.skipIf(!hasDatabase)('labelling into crates (A3)', () => {
  let t: TestApp;
  let kit: LabelingKit;
  let sessionId: string;
  const http = () => request(t.app.getHttpServer());

  /** Bottles printed with one new design, the design approved for the kit's product. */
  async function designBottles(n: number, product = kit.productCode) {
    const bottles = await printedBottles(t, n);
    const versionId = await versionOf(bottles[0]!);
    await approveDesign(t, product, versionId);
    return { bottles, versionId };
  }
  async function versionOf(b: Printed) {
    const row = await t.prisma.bottle.findUniqueOrThrow({
      where: { id: b.id },
      include: { creationBatch: true },
    });
    return row.creationBatch.labelTemplateVersionId;
  }
  async function newLot(quantity: number) {
    return (await receiveBottles(t, quantity)).lines[0]!.lot!.id;
  }
  /** Context + a fresh crate of the given type loaded at the session. */
  async function ready(
    versionId: string,
    lotId: string,
    crateTypeCode = kit.crateTypeCode,
    product = kit.productCode,
  ) {
    const ctx = await setContext(t, sessionId, {
      productCode: product,
      labelTemplateVersionId: versionId,
      sourceLotId: lotId,
    });
    expect(ctx.status, JSON.stringify(ctx.body)).toBe(200);
    const crateUrl = await registerCrate(t, crateTypeCode);
    const loaded = await loadCrate(t, sessionId, crateUrl);
    expect(loaded.status, JSON.stringify(loaded.body)).toBe(200);
    return crateUrl;
  }
  const movementsOf = (bottleId: string) =>
    t.prisma.inventoryMovement.findMany({
      where: { bottleEvent: { bottleId } },
      include: { item: { select: { code: true } } },
      orderBy: { id: 'asc' },
    });

  beforeAll(async () => {
    t = await createTestApp();
    kit = await labelingKit(t);
    sessionId = await labelingSession(t);
  });
  afterAll(async () => {
    if (t) expect(await drift(t)).toEqual([]);
    await t?.close();
  });

  it('one scan: labelled, bound, in the crate; body and label consumed exactly once', async () => {
    const { bottles, versionId } = await designBottles(1);
    const lotId = await newLot(5);
    await ready(versionId, lotId);
    const res = await labelScan(t, sessionId, `${bottles[0]!.url}\r\n`);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const body = res.body as LabelScanResult;
    expect(body).toMatchObject({
      outcome: 'APPLIED',
      bottle: { code: bottles[0]!.code },
      cycle: { status: 'OPEN_ASSEMBLY', memberCount: 1, capacity: 40, recipeVersion: 1 },
      sourceLot: { onHand: '4' },
    });

    const bottle = await t.prisma.bottle.findUniqueOrThrow({
      where: { id: bottles[0]!.id },
      include: { events: { orderBy: { recordedAt: 'asc' } }, binding: true, assignments: true },
    });
    expect(bottle.status).toBe('LABELED_EMPTY');
    const applied = bottle.events.find((e) => e.type === 'LABEL_APPLIED')!;
    expect(applied).toMatchObject({ workstationSessionId: sessionId });
    expect(applied.crateCycleId).toBeTruthy();
    expect(applied.actorId).toBeTruthy();
    expect(bottle.events.map((e) => e.type)).toEqual([
      'CREATED',
      'LABEL_APPLIED',
      'ASSIGNED_TO_CRATE',
    ]);
    const product = await t.prisma.product.findUniqueOrThrow({ where: { code: kit.productCode } });
    expect(bottle.binding).toMatchObject({
      productId: product.id,
      categoryCode: 'HAND_SOAP',
      labelTemplateVersionId: versionId,
      labelAppliedEventId: applied.id,
    });
    expect(bottle.assignments).toHaveLength(1);
    expect(bottle.assignments[0]).toMatchObject({
      ordinal: 1,
      source: 'LABELING',
      releasedAt: null,
    });

    const moves = await movementsOf(bottles[0]!.id);
    expect(moves.map((m) => [m.item.code, m.quantityDelta.toString(), m.lotId])).toEqual(
      expect.arrayContaining([
        ['NEW_BOTTLE', '-1', lotId],
        [kit.labelItemCode, '-1', null],
      ]),
    );
    expect(moves).toHaveLength(2);
    const cycle = await t.prisma.crateCycle.findUniqueOrThrow({
      where: { id: applied.crateCycleId! },
      include: { events: true },
    });
    expect(cycle.events.map((e) => e.type)).toEqual(['CYCLE_OPENED']);

    const list = (await http().get('/api/admin/crates?pageSize=100').expect(200)).body as CratePage;
    expect(list.items.find((c) => c.code === body.crate.code)?.cycle).toEqual({
      status: 'OPEN_ASSEMBLY',
      memberCount: 1,
      capacity: 40,
      product: { code: kit.productCode, name: 'Tekuté mýdlo 330 ml' },
    });
  });

  it('a duplicate scan is ALREADY_APPLIED and writes nothing; a retried request replays', async () => {
    const { bottles, versionId } = await designBottles(1);
    await ready(versionId, await newLot(3));
    const requestId = randomUUID();
    const first = (await labelScan(t, sessionId, bottles[0]!.url, requestId).expect(200)).body;
    const replay = (await labelScan(t, sessionId, bottles[0]!.url, requestId).expect(200)).body;
    expect(replay).toEqual(first);
    const again = (await labelScan(t, sessionId, bottles[0]!.url).expect(200))
      .body as LabelScanResult;
    expect([again.outcome, again.cycle.memberCount]).toEqual(['ALREADY_APPLIED', 1]);
    expect(await movementsOf(bottles[0]!.id)).toHaveLength(2);
    expect(
      await t.prisma.bottleEvent.count({
        where: { bottleId: bottles[0]!.id, type: 'LABEL_APPLIED' },
      }),
    ).toBe(1);
  });

  it('the capacity-th bottle makes the crate READY_TO_FILL; one more is refused (no 41st)', async () => {
    const small = await labelingKit(t, { capacity: 3 });
    const bottles = await printedBottles(t, 4);
    const versionId = await versionOf(bottles[0]!);
    await approveDesign(t, small.productCode, versionId);
    await ready(versionId, await newLot(10), small.crateTypeCode, small.productCode);
    for (const [i, b] of bottles.slice(0, 3).entries()) {
      const r = (await labelScan(t, sessionId, b.url).expect(200)).body as LabelScanResult;
      expect(r.cycle.memberCount).toBe(i + 1);
      expect(r.cycle.status).toBe(i === 2 ? 'READY_TO_FILL' : 'OPEN_ASSEMBLY');
    }
    const fourth = await labelScan(t, sessionId, bottles[3]!.url);
    expect([fourth.status, fourth.body.code]).toEqual([409, 'CRATE_FULL']);
    const status = await t.prisma.bottle.findUniqueOrThrow({ where: { id: bottles[3]!.id } });
    expect(status.status).toBe('CREATED');
    expect(await movementsOf(bottles[3]!.id)).toHaveLength(0);
    const cycle = await t.prisma.crateCycle.findFirstOrThrow({
      where: { assignments: { some: { bottleId: bottles[0]!.id } } },
      include: { events: { orderBy: { recordedAt: 'asc' } } },
    });
    expect([cycle.status, cycle.memberCount]).toEqual(['READY_TO_FILL', 3]);
    expect(cycle.events.map((e) => e.type)).toEqual(['CYCLE_OPENED', 'READY_TO_FILL']);
  });

  it('accepts only the chosen, approved design for the product', async () => {
    const chosen = await designBottles(1);
    const lotId = await newLot(5);
    await ready(chosen.versionId, lotId);
    // A label of another design, even when that design is approved for another product.
    const other = await printedBottles(t, 1);
    const wrong = await labelScan(t, sessionId, other[0]!.url);
    expect([wrong.status, wrong.body.code]).toEqual([422, 'WRONG_LABEL_DESIGN']);
    // A design is approved for exactly one product.
    const otherKit = await labelingKit(t, { labelStock: 0 });
    const taken = await http()
      .post(`/api/admin/catalog/products/${otherKit.productCode}/label-approvals`)
      .send({ requestId: randomUUID(), labelTemplateVersionId: chosen.versionId, reason: 'pokus' });
    expect([taken.status, taken.body.code]).toEqual([409, 'DESIGN_APPROVED_FOR_ANOTHER_PRODUCT']);
    // An unapproved design cannot be chosen; a revoked one stops new scans.
    const unapproved = await setContext(t, sessionId, {
      productCode: kit.productCode,
      labelTemplateVersionId: await versionOf(other[0]!),
      sourceLotId: lotId,
    });
    expect([unapproved.status, unapproved.body.code]).toEqual([422, 'DESIGN_NOT_APPROVED']);
    const approvals = await http().get(
      `/api/admin/catalog/products/${kit.productCode}/label-approvals`,
    );
    const approval = (approvals.body as { id: string; design: { versionId: string } }[]).find(
      (a) => a.design.versionId === chosen.versionId,
    )!;
    await http()
      .post(`/api/admin/catalog/products/${kit.productCode}/label-approvals/${approval.id}/revoke`)
      .send({ requestId: randomUUID(), reason: 'design stažen' })
      .expect(200);
    const revoked = await labelScan(t, sessionId, chosen.bottles[0]!.url);
    expect([revoked.status, revoked.body.code]).toEqual([409, 'DESIGN_NOT_APPROVED']);
    expect(await movementsOf(chosen.bottles[0]!.id)).toHaveLength(0);
  });

  it('refuses a bottle of another crate and a legacy labelled bottle — never moves them', async () => {
    const { bottles, versionId } = await designBottles(2);
    const lotId = await newLot(5);
    await ready(versionId, lotId);
    await labelScan(t, sessionId, bottles[0]!.url).expect(200);
    const firstCrate = (
      await http().get(`/api/admin/station-sessions/${sessionId}/labeling`).expect(200)
    ).body as LabelingState;
    // Another crate at the same station: the bottle of the first crate is refused.
    await loadCrate(t, sessionId, await registerCrate(t, kit.crateTypeCode)).expect(200);
    const moved = await labelScan(t, sessionId, bottles[0]!.url);
    expect([moved.status, moved.body.code]).toEqual([409, 'IN_ANOTHER_CRATE']);
    expect(moved.body.message).toContain(firstCrate.crate!.code);
    expect(await t.prisma.crateAssignment.count({ where: { bottleId: bottles[0]!.id } })).toBe(1);

    // A bottle labelled before this change: LABELED_EMPTY without crate or binding (owner B3).
    await t.prisma.$transaction(async (tx) => {
      // Simulates historical data (written before the A3 rules existed).
      await tx.$executeRaw`SET LOCAL session_replication_role = replica`;
      await tx.$executeRaw`UPDATE "bottles" SET "status" = 'LABELED_EMPTY' WHERE "id" = ${bottles[1]!.id}::uuid`;
    });
    const legacy = await labelScan(t, sessionId, bottles[1]!.url);
    expect([legacy.status, legacy.body.code]).toEqual([409, 'ALREADY_LABELED']);
    expect(await t.prisma.bottleProductBinding.count({ where: { bottleId: bottles[1]!.id } })).toBe(
      0,
    );
    expect(await movementsOf(bottles[1]!.id)).toHaveLength(0);
  });

  it('never switches lots and refuses when label stock is missing, without partial writes', async () => {
    const { bottles, versionId } = await designBottles(2);
    await ready(versionId, await newLot(1));
    await labelScan(t, sessionId, bottles[0]!.url).expect(200);
    const exhausted = await labelScan(t, sessionId, bottles[1]!.url);
    expect([exhausted.status, exhausted.body.code]).toEqual([409, 'LOT_EXHAUSTED']);

    const noLabels = await labelingKit(t, { labelStock: 0 });
    const b = await printedBottles(t, 1);
    const v = await versionOf(b[0]!);
    await approveDesign(t, noLabels.productCode, v);
    await ready(v, await newLot(2), noLabels.crateTypeCode, noLabels.productCode);
    const missing = await labelScan(t, sessionId, b[0]!.url);
    expect([missing.status, missing.body.code]).toEqual([409, 'INSUFFICIENT_STOCK']);
    expect((await t.prisma.bottle.findUniqueOrThrow({ where: { id: b[0]!.id } })).status).toBe(
      'CREATED',
    );
    expect(await movementsOf(b[0]!.id)).toHaveLength(0);
    expect(
      await t.prisma.crateCycle.count({
        where: {
          productId: (
            await t.prisma.product.findUniqueOrThrow({ where: { code: noLabels.productCode } })
          ).id,
        },
      }),
    ).toBe(0);
  });

  it('holds under concurrency: capacity, one consumption per bottle', async () => {
    const small = await labelingKit(t, { capacity: 5 });
    const bottles = await printedBottles(t, 10);
    const versionId = await versionOf(bottles[0]!);
    await approveDesign(t, small.productCode, versionId);
    await ready(versionId, await newLot(20), small.crateTypeCode, small.productCode);
    const raced = await Promise.all(bottles.map((b) => labelScan(t, sessionId, b.url)));
    expect(raced.filter((r) => r.status === 200)).toHaveLength(5);
    expect(raced.filter((r) => r.status === 409).every((r) => r.body.code === 'CRATE_FULL')).toBe(
      true,
    );
    const cycle = await t.prisma.crateCycle.findFirstOrThrow({
      where: {
        productId: (
          await t.prisma.product.findUniqueOrThrow({ where: { code: small.productCode } })
        ).id,
      },
    });
    expect([cycle.status, cycle.memberCount]).toEqual(['READY_TO_FILL', 5]);

    const one = await designBottles(1);
    await ready(one.versionId, await newLot(5));
    const same = await Promise.all(
      Array.from({ length: 10 }, () => labelScan(t, sessionId, one.bottles[0]!.url)),
    );
    expect(same.map((r) => r.status).every((s) => s === 200)).toBe(true);
    expect(same.filter((r) => (r.body as LabelScanResult).outcome === 'APPLIED')).toHaveLength(1);
    expect(await movementsOf(one.bottles[0]!.id)).toHaveLength(2);
  });

  it('an open crate keeps its recipe version when a newer one is activated (owner B2)', async () => {
    const own = await labelingKit(t);
    const bottles = await printedBottles(t, 2);
    const versionId = await versionOf(bottles[0]!);
    await approveDesign(t, own.productCode, versionId);
    const lotId = await newLot(5);
    const crateUrl = await ready(versionId, lotId, own.crateTypeCode, own.productCode);
    await labelScan(t, sessionId, bottles[0]!.url).expect(200);
    // Version 2 (a second label line quantity would be odd: change the pump instead).
    const v2 = await http()
      .post(`/api/admin/catalog/products/${own.productCode}/recipes`)
      .send({ requestId: randomUUID(), reason: 'nová verze', basedOnVersion: 1 })
      .expect(201);
    expect(v2.body.version).toBe(2);
    await http()
      .post(`/api/admin/catalog/products/${own.productCode}/recipes/2/activate`)
      .send({ requestId: randomUUID(), reason: 'schváleno', expectedActiveVersion: 1 })
      .expect(200);
    // The station context now offers version 2, but the open crate continues with version 1.
    const ctx = (
      await setContext(t, sessionId, {
        productCode: own.productCode,
        labelTemplateVersionId: versionId,
        sourceLotId: lotId,
      }).expect(200)
    ).body as LabelingState;
    expect(ctx.recipeVersion).toBe(2);
    await loadCrate(t, sessionId, crateUrl).expect(200);
    const second = (await labelScan(t, sessionId, bottles[1]!.url).expect(200))
      .body as LabelScanResult;
    expect(second.cycle.recipeVersion).toBe(1);
    const lines = await t.prisma.inventoryMovement.findMany({
      where: { bottleEvent: { bottleId: bottles[1]!.id } },
      include: { bomLine: { include: { bomVersion: true } } },
    });
    expect(new Set(lines.map((l) => l.bomLine!.bomVersion.code))).toEqual(
      new Set([`R-${own.productCode}-V1-LA`]),
    );
  });

  it('validates the context and the crate: lot, mode, crate type, mixing, non-crate QR', async () => {
    const { bottles, versionId } = await designBottles(1);
    const lotId = await newLot(3);
    const wrongLot = await setContext(t, sessionId, {
      productCode: kit.productCode,
      labelTemplateVersionId: versionId,
      sourceLotId: randomUUID(),
    });
    expect([wrongLot.status, wrongLot.body.code]).toEqual([422, 'WRONG_LOT']);
    await setContext(t, sessionId, {
      productCode: kit.productCode,
      labelTemplateVersionId: versionId,
      sourceLotId: lotId,
    }).expect(200);
    const gel = await labelingKit(t, { category: 'SHOWER_GEL', labelStock: 0 });
    const gelCrate = await loadCrate(t, sessionId, await registerCrate(t, gel.crateTypeCode));
    expect([gelCrate.status, gelCrate.body.code]).toEqual([422, 'CRATE_TYPE_MISMATCH']);
    const bottleAsCrate = await loadCrate(t, sessionId, bottles[0]!.url);
    expect([bottleAsCrate.status, bottleAsCrate.body.code]).toEqual([422, 'NOT_A_CRATE']);
    // A crate assembling another design refuses this context (one crate never mixes).
    const other = await designBottles(1);
    const otherCrate = await ready(other.versionId, lotId);
    await labelScan(t, sessionId, other.bottles[0]!.url).expect(200);
    await setContext(t, sessionId, {
      productCode: kit.productCode,
      labelTemplateVersionId: versionId,
      sourceLotId: lotId,
    }).expect(200);
    const mixed = await loadCrate(t, sessionId, otherCrate);
    expect([mixed.status, mixed.body.code]).toEqual([409, 'CRATE_INCOMPATIBLE']);
    const noCrate = await labelScan(t, sessionId, bottles[0]!.url);
    expect([noCrate.status, noCrate.body.code]).toEqual([409, 'CONTEXT_INCOMPLETE']);
  });

  it('retires the standalone label application (410, nothing written)', async () => {
    const [bottle] = await printedBottles(t, 1);
    const lotId = await newLot(1);
    const res = await http().post('/api/admin/label-applications').send({
      requestId: randomUUID(),
      lotId,
      seriesCode: bottle!.seriesCode,
      scannedValue: bottle!.url,
    });
    expect([res.status, res.body.code]).toEqual([410, 'LABEL_APPLICATION_RETIRED']);
    expect((await t.prisma.bottle.findUniqueOrThrow({ where: { id: bottle!.id } })).status).toBe(
      'CREATED',
    );
  });

  it('enforces the A3 rules in the database on their own', async () => {
    const { bottles, versionId } = await designBottles(1);
    await ready(versionId, await newLot(2));
    await labelScan(t, sessionId, bottles[0]!.url).expect(200);
    const [bottle] = await printedBottles(t, 1);
    // A new LABEL_APPLIED without a crate cycle (the old path) is refused.
    await expect(
      t.prisma.$executeRaw`INSERT INTO "bottle_events" ("bottle_id", "type", "occurred_at")
                           VALUES (${bottle!.id}::uuid, 'LABEL_APPLIED', now())`,
    ).rejects.toThrow();
    // Bindings and assignments are history.
    await expect(
      t.prisma
        .$executeRaw`DELETE FROM "bottle_product_bindings" WHERE "bottle_id" = ${bottles[0]!.id}::uuid`,
    ).rejects.toThrow();
    await expect(
      t.prisma
        .$executeRaw`DELETE FROM "crate_assignments" WHERE "bottle_id" = ${bottles[0]!.id}::uuid`,
    ).rejects.toThrow();
    const cycle = await t.prisma.crateCycle.findFirstOrThrow({
      where: { assignments: { some: { bottleId: bottles[0]!.id } } },
    });
    // The snapshot is immutable; a cycle never jumps to FILLED; counts must match.
    await expect(
      t.prisma
        .$executeRaw`UPDATE "crate_cycles" SET "capacity" = 41 WHERE "id" = ${cycle.id}::uuid`,
    ).rejects.toThrow();
    await expect(
      t.prisma
        .$executeRaw`UPDATE "crate_cycles" SET "status" = 'FILLED' WHERE "id" = ${cycle.id}::uuid`,
    ).rejects.toThrow();
    await expect(
      t.prisma
        .$executeRaw`UPDATE "crate_cycles" SET "member_count" = 2 WHERE "id" = ${cycle.id}::uuid`,
    ).rejects.toThrow();
    expect(TEST_QR_BASE_URL).toBeTruthy();
  });
});
