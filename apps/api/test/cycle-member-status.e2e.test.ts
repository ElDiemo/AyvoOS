import type { CycleCorrectionResult } from '@ayvo/types';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { testCarrierControl } from '../src/carriers/test-carrier.js';
import { correctCrate } from './support/labeling-fixtures.js';
import { crateFactory, createHotel, type MadeCrate } from './support/order-fixtures.js';
import { deliver, RETURN_ENV, returnsApi, shipCrates } from './support/return-fixtures.js';
import { createTestApp, hasDatabase, type TestApp, withPrivileged } from './support/test-app.js';

type Factory = Awaited<ReturnType<typeof crateFactory>>;

/**
 * A crate takes a new member only in LABELED_EMPTY or FILLED (R1 follow-up, #129 comment
 * 6695354613): the supervised "Doplnit lahev" and the database refuse a RETURNED, RETIRED or
 * DISPOSED bottle — the crate would never be fillable — while labelling, REPLACEMENT and REPACKED
 * stay as they are. Nothing of the refused attempt is written: no assignment, event, counter or
 * stock movement.
 */
describe.skipIf(!hasDatabase)('crate membership only for placeable bottles', () => {
  let t: TestApp;
  let factory: Factory;
  let hotel: string;
  let returned: { id: string; code: string };
  let retired: { id: string; code: string };
  let disposed: { id: string; code: string };

  const codeOf = async (id: string) =>
    (await t.prisma.bottle.findUniqueOrThrow({ where: { id } })).code;
  /** An assembling crate of the same product, design and recipe with one free place. */
  async function crateWithFreePlace() {
    const target = await factory.make('READY_TO_FILL');
    const out = await correctCrate(t, target.crateCode, 'remove-bottle', {
      bottle: await codeOf(target.bottleIds[0]!),
    });
    expect(out.status, JSON.stringify(out.body)).toBe(200);
    const cycle = (out.body as CycleCorrectionResult).cycle!;
    expect([cycle.status, cycle.memberCount, cycle.capacity]).toEqual(['OPEN_ASSEMBLY', 1, 2]);
    return target;
  }
  /** Everything a refused attempt must leave as it was. */
  async function snapshot(crate: MadeCrate, bottleIds: string[]) {
    const cycle = await t.prisma.crateCycle.findFirstOrThrow({
      where: { crate: { code: crate.crateCode } },
      orderBy: { openedAt: 'desc' },
    });
    return {
      cycle: [cycle.id, cycle.status, cycle.memberCount, cycle.filledCount],
      assignments: await t.prisma.crateAssignment.count({ where: { cycleId: cycle.id } }),
      bottles: await t.prisma.bottle.findMany({
        where: { id: { in: bottleIds } },
        select: { id: true, status: true },
        orderBy: { id: 'asc' },
      }),
      events: await t.prisma.bottleEvent.count({ where: { bottleId: { in: bottleIds } } }),
      crateEvents: await t.prisma.crateEvent.count({ where: { cycleId: cycle.id } }),
      movements: await t.prisma.inventoryMovement.count(),
    };
  }

  beforeAll(async () => {
    t = await createTestApp(RETURN_ENV);
    testCarrierControl.reset();
    testCarrierControl.rules.parcelWeight = 'NOT_USED';
    factory = await crateFactory(t, { capacity: 2 });
    hotel = (await createHotel(t, { name: 'Hotel Doplnění' })).code;
    // Two delivered crates come back: good → RETURNED, defective → RETIRED (R1 intake).
    const k = await factory.make();
    const l = await factory.make();
    await deliver(t, await shipCrates(t, hotel, factory.kit.productCode, [k, l]));
    const api = returnsApi(t);
    const receipt = await api.open();
    const line = (await api.scanCrate(receipt.code, k.crateUrl)).body.lineId as string;
    await api.scanBottle(receipt.code, line, k.bottleUrls[0]!, 'GOOD').expect(200);
    await api.scanBottle(receipt.code, line, k.bottleUrls[1]!, 'DEFECTIVE').expect(200);
    await api.scanBottle(receipt.code, line, l.bottleUrls[0]!, 'DEFECTIVE').expect(200);
    returned = { id: k.bottleIds[0]!, code: await codeOf(k.bottleIds[0]!) };
    retired = { id: k.bottleIds[1]!, code: await codeOf(k.bottleIds[1]!) };
    // DISPOSED has no API in R1: the database's own RETIRED → DISPOSED path (fixture only).
    const d = l.bottleIds[0]!;
    const op = await t.prisma.bottleEvent.findFirstOrThrow({
      where: { bottleId: d, type: 'RETIRED' },
      select: { actorId: true, operationRequestId: true },
    });
    await withPrivileged((db) =>
      db.$transaction(async (tx) => {
        await tx.$executeRaw`INSERT INTO "bottle_events" ("bottle_id", "type", "occurred_at", "actor_id", "operation_request_id")
          VALUES (${d}::uuid, 'DISPOSED', now(), ${op.actorId}::uuid, ${op.operationRequestId}::uuid)`;
        await tx.$executeRaw`UPDATE "bottles" SET "status" = 'DISPOSED' WHERE "id" = ${d}::uuid`;
      }),
    );
    disposed = { id: d, code: await codeOf(d) };
    for (const [b, status] of [
      [returned, 'RETURNED'],
      [retired, 'RETIRED'],
      [disposed, 'DISPOSED'],
    ] as const) {
      expect((await t.prisma.bottle.findUniqueOrThrow({ where: { id: b.id } })).status).toBe(
        status,
      );
    }
  });
  afterAll(async () => {
    testCarrierControl.reset();
    await t?.close();
  });
  beforeEach(() => {
    testCarrierControl.rules.parcelWeight = 'NOT_USED';
  });

  it('"Doplnit lahev" refuses a RETURNED, RETIRED or DISPOSED bottle into a crate with a free place; nothing changes', async () => {
    const target = await crateWithFreePlace();
    const ids = [returned.id, retired.id, disposed.id, ...target.bottleIds];
    const before = await snapshot(target, ids);
    for (const b of [returned, retired, disposed]) {
      const r = await correctCrate(t, target.crateCode, 'add-bottle', { bottle: b.code });
      expect([r.status, r.body.code], `${b.code} ${JSON.stringify(r.body)}`).toEqual([
        409,
        'BOTTLE_NOT_PLACEABLE',
      ]);
    }
    expect(await snapshot(target, ids)).toEqual(before);
  });

  it('the database refuses a new membership of a RETURNED, RETIRED or DISPOSED bottle at commit', async () => {
    const target = await crateWithFreePlace();
    const cycle = await t.prisma.crateCycle.findFirstOrThrow({
      where: { crate: { code: target.crateCode } },
      orderBy: { openedAt: 'desc' },
    });
    const member = await t.prisma.crateAssignment.findFirstOrThrow({
      where: { cycleId: cycle.id, releasedAt: null },
    });
    const ids = [returned.id, retired.id, disposed.id, ...target.bottleIds];
    const before = await snapshot(target, ids);
    for (const b of [returned, retired, disposed]) {
      // A complete, otherwise consistent write: event, assignment at the free ordinal, counter.
      const write = withPrivileged((db) =>
        db.$transaction(async (tx) => {
          await tx.$executeRaw`INSERT INTO "bottle_events" ("bottle_id", "type", "occurred_at", "actor_id",
              "crate_cycle_id", "operation_request_id", "payload")
            VALUES (${b.id}::uuid, 'ASSIGNED_TO_CRATE', now(), ${member.assignedBy}::uuid, ${cycle.id}::uuid,
              ${member.operationRequestId}::uuid, '{"source":"REPACKED"}')`;
          await tx.$executeRaw`INSERT INTO "crate_assignments" ("cycle_id", "cycle_capacity", "bottle_id", "ordinal",
              "source", "assigned_by", "operation_request_id", "assigned_event_id")
            SELECT ${cycle.id}::uuid, ${cycle.capacity}, ${b.id}::uuid,
              (SELECT min(o) FROM generate_series(1, ${cycle.capacity}) o
                WHERE o NOT IN (SELECT "ordinal" FROM "crate_assignments" WHERE "cycle_id" = ${cycle.id}::uuid AND "released_at" IS NULL)),
              'REPACKED', ${member.assignedBy}::uuid, ${member.operationRequestId}::uuid,
              (SELECT "id" FROM "bottle_events" WHERE "bottle_id" = ${b.id}::uuid AND "type" = 'ASSIGNED_TO_CRATE'
                ORDER BY "id" DESC LIMIT 1)`;
          // The capacity-th member makes it READY_TO_FILL with its crate event (as addMember does).
          await tx.$executeRaw`UPDATE "crate_cycles" SET "member_count" = "member_count" + 1, "status" = 'READY_TO_FILL',
              "ready_to_fill_at" = now() WHERE "id" = ${cycle.id}::uuid`;
          await tx.$executeRaw`INSERT INTO "crate_events" ("crate_id", "cycle_id", "type", "occurred_at", "actor_id", "site_id", "operation_request_id")
            VALUES (${cycle.crateId}::uuid, ${cycle.id}::uuid, 'READY_TO_FILL', now(), ${member.assignedBy}::uuid,
              ${cycle.siteId}::uuid, ${member.operationRequestId}::uuid)`;
        }),
      );
      await expect(write, b.code).rejects.toThrow(
        b.id === disposed.id
          ? /disposed bottle has no later event|placeable/
          : /a crate takes a new member only in LABELED_EMPTY or FILLED/,
      );
    }
    expect(await snapshot(target, ids)).toEqual(before);
  });

  it('new production, REPLACEMENT and REPACKED stay as they are', async () => {
    // New bottles: labelled, filled, Hotovo (the factory walks the real API).
    const full = await factory.make();
    expect(
      (
        await t.prisma.crateCycle.findFirstOrThrow({
          where: { crate: { code: full.crateCode } },
          orderBy: { openedAt: 'desc' },
        })
      ).status,
    ).toBe('FILLED');
    // REPACKED: a filled bottle taken out of a FILLING crate into an assembling one of the same snapshot.
    const filling = await factory.make('FILLING');
    const filledCode = await codeOf(filling.bottleIds[0]!);
    const out = await correctCrate(t, filling.crateCode, 'remove-bottle', { bottle: filledCode });
    expect(out.status, JSON.stringify(out.body)).toBe(200);
    const target = await crateWithFreePlace();
    const movements = await t.prisma.inventoryMovement.count();
    const repacked = await correctCrate(t, target.crateCode, 'add-bottle', { bottle: filledCode });
    expect(repacked.status, JSON.stringify(repacked.body)).toBe(200);
    expect(
      await t.prisma.crateAssignment.findFirstOrThrow({
        where: { bottleId: filling.bottleIds[0]!, releasedAt: null },
        select: { source: true },
      }),
    ).toEqual({ source: 'REPACKED' });
    // REPLACEMENT: an empty labelled bottle into the FILLING crate's free place.
    const emptyCode = await codeOf(filling.bottleIds[1]!);
    const loose = await correctCrate(t, filling.crateCode, 'remove-bottle', { bottle: emptyCode });
    expect(loose.status, JSON.stringify(loose.body)).toBe(200);
    // …put back: the FILLING crate has a free place again.
    const back = await correctCrate(t, filling.crateCode, 'add-bottle', { bottle: emptyCode });
    expect(back.status, JSON.stringify(back.body)).toBe(200);
    expect(
      await t.prisma.crateAssignment.findFirstOrThrow({
        where: { bottleId: filling.bottleIds[1]!, releasedAt: null },
        select: { source: true },
      }),
    ).toEqual({ source: 'REPLACEMENT' });
    // Never a consumption by a correction.
    expect(await t.prisma.inventoryMovement.count()).toBe(movements);
  });
});
