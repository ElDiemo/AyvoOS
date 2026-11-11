import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  chooseLiquidLot,
  fillingSession,
  fillLoadCrate,
  fillScan,
} from './support/labeling-fixtures.js';
import { crateFactory } from './support/order-fixtures.js';
import { createTestApp, hasDatabase, type TestApp } from './support/test-app.js';

type Factory = Awaited<ReturnType<typeof crateFactory>>;

/**
 * R3-a (doc 048 §3.3b–§3.3c, §8.2 step 1): one filling per circulation of a bottle, in the
 * database. Every FILLED — of the API (which passes no anchor) or of direct SQL — is anchored by
 * the database to the event that made its bottle fillable (its LABEL_APPLIED here); the side table
 * is insert-only, names only a FILLED and the latest circulation of the same bottle, and a
 * circulation is filled once. Run as the core runtime role (ADR 0041), with commits. Synthetic
 * data only. Placement is unchanged: a washed bottle still enters no crate (R3-b).
 */
describe.skipIf(!hasDatabase)('R3-a: one filling per circulation (database)', () => {
  let t: TestApp;
  let factory: Factory;

  const anchors = (bottleIds: string[]) =>
    t.prisma.bottleFillCirculation.findMany({
      where: { filled: { bottleId: { in: bottleIds } } },
      include: { filled: true, circulation: true },
    });
  const refused = async (sql: () => Promise<unknown>, message: RegExp) => {
    await expect(sql()).rejects.toThrow(message);
  };

  beforeAll(async () => {
    t = await createTestApp();
    factory = await crateFactory(t, { capacity: 2 });
  });
  afterAll(() => t?.close());

  it('every FILLED of the API gets its bottle’s LABEL_APPLIED as its circulation; none is missing', async () => {
    const made = await factory.make('FILLED');
    const rows = await anchors(made.bottleIds);
    expect(rows).toHaveLength(2);
    for (const r of rows) {
      expect(r.filled.type).toBe('FILLED');
      expect(r.circulation.type).toBe('LABEL_APPLIED');
      expect(r.circulation.bottleId).toBe(r.filled.bottleId);
    }
    // The whole database: each FILLED (backfilled at the migration or new) has exactly one anchor.
    const [counts] = await t.prisma.$queryRaw<{ filled: number; anchored: number }[]>`
      SELECT (SELECT count(*)::int FROM "bottle_events" WHERE "type" = 'FILLED') AS "filled",
             (SELECT count(*)::int FROM "bottle_fill_circulations") AS "anchored"`;
    expect(counts!.anchored).toBe(counts!.filled);
  });

  it('the side table is insert-only and never names another bottle, an older circulation or a non-FILLED', async () => {
    const a = await factory.make('FILLED');
    const b = await factory.make('FILLED');
    const [rowA] = await anchors([a.bottleIds[0]!]);
    const [rowB] = await anchors([b.bottleIds[0]!]);
    await refused(
      () =>
        t.prisma
          .$executeRaw`UPDATE "bottle_fill_circulations" SET "circulation_event_id" = ${rowB!.circulationEventId}::uuid
          WHERE "filled_event_id" = ${rowA!.filledEventId}::uuid`,
      /insert-only/,
    );
    await refused(
      () =>
        t.prisma
          .$executeRaw`DELETE FROM "bottle_fill_circulations" WHERE "filled_event_id" = ${rowA!.filledEventId}::uuid`,
      /insert-only/,
    );
    // A second row for a circulation already filled (e.g. after a repack into another crate).
    await refused(
      () =>
        t.prisma
          .$executeRaw`INSERT INTO "bottle_fill_circulations" ("filled_event_id", "circulation_event_id")
          VALUES (${rowB!.filledEventId}::uuid, ${rowA!.circulationEventId}::uuid)`,
      /same bottle|duplicate|unique/i,
    );
    // The circulation of another bottle, and a LABEL_APPLIED named as the "FILLED".
    await refused(
      () =>
        t.prisma
          .$executeRaw`INSERT INTO "bottle_fill_circulations" ("filled_event_id", "circulation_event_id")
          VALUES (${rowA!.circulationEventId}::uuid, ${rowB!.circulationEventId}::uuid)`,
      /names a FILLED/,
    );
    expect(await anchors([...a.bottleIds, ...b.bottleIds])).toHaveLength(4);
  });

  it('a second FILLED of a filled bottle is refused by direct SQL; nothing is written', async () => {
    const made = await factory.make('FILLED');
    const bottleId = made.bottleIds[0]!;
    const [filled] = await t.prisma.bottleEvent.findMany({
      where: { bottleId, type: 'FILLED' },
    });
    const before = await t.prisma.bottleEvent.count({ where: { bottleId } });
    await refused(
      () =>
        t.prisma.$executeRaw`INSERT INTO "bottle_events"
          ("bottle_id", "type", "occurred_at", "actor_id", "crate_cycle_id", "workstation_session_id",
           "operation_request_id", "liquid_lot_id", "payload")
          VALUES (${bottleId}::uuid, 'FILLED', now(), ${filled!.actorId}::uuid, ${filled!.crateCycleId}::uuid,
                  ${filled!.workstationSessionId}::uuid, ${filled!.operationRequestId}::uuid,
                  ${filled!.liquidLotId}::uuid, '{}')`,
      /AYVO/,
    );
    expect(await t.prisma.bottleEvent.count({ where: { bottleId } })).toBe(before);
    expect(await anchors([bottleId])).toHaveLength(1);
  });

  it('two concurrent fill scans of one bottle: one FILLED, one anchor', async () => {
    const made = await factory.make('READY_TO_FILL');
    const fs = await fillingSession(t, 'HAND_SOAP');
    expect((await fillLoadCrate(t, fs, made.crateUrl)).status).toBe(200);
    const lot = await factory.receiveLiquid();
    expect((await chooseLiquidLot(t, fs, lot)).status).toBe(200);
    const url = made.bottleUrls[0]!;
    const results = await Promise.all([fillScan(t, fs, url), fillScan(t, fs, url)]);
    // The second scan sees the bottle filled (the API answers that as ALREADY_FILLED, not an error).
    expect(results.every((r) => r.status === 200 || r.status === 409)).toBe(true);
    const bottleId = made.bottleIds[0]!;
    expect(await t.prisma.bottleEvent.count({ where: { bottleId, type: 'FILLED' } })).toBe(1);
    expect(await anchors([bottleId])).toHaveLength(1);
  });
});
