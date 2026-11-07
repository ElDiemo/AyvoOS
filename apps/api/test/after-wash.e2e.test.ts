import { randomUUID } from 'node:crypto';
import type {
  AfterWashQueue,
  AfterWashScanResult,
  BottleDetail,
  CycleCorrectionResult,
} from '@ayvo/types';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { testCarrierControl } from '../src/carriers/test-carrier.js';
import { correctCrate, labelScan } from './support/labeling-fixtures.js';
import { crateFactory, createHotel, type MadeCrate } from './support/order-fixtures.js';
import { deliver, RETURN_ENV, returnsApi, shipCrates } from './support/return-fixtures.js';
import { createTestApp, hasDatabase, type TestApp, withPrivileged } from './support/test-app.js';

type Factory = Awaited<ReturnType<typeof crateFactory>>;
interface Piece {
  id: string;
  url: string;
  code: string;
}

/**
 * R2 "Po mytí" (doc 048 §1–§2) against the real database: a returned bottle, washed and
 * inspected, is scanned once more → READY_FOR_REUSE with one REUSE_READY, its pump attachment
 * closed for cleaning, nothing consumed. Refusals write nothing; a revoked design is set aside;
 * in R2 the bottle enters no crate (station, corrections, direct SQL) while today's walk of new
 * bottles stays as it is. Deliveries by the FAKE test carrier only — never PPL.
 */
describe.skipIf(!hasDatabase)('R2 "Po mytí" (doc 048 §2)', () => {
  let t: TestApp;
  let factory: Factory;
  let hotel: string;
  let api: ReturnType<typeof returnsApi>;
  const http = () => request(t.app.getHttpServer());

  const wash = (scannedValue: string, requestId = randomUUID()) =>
    http().post('/api/admin/returns/after-wash').send({ requestId, scannedValue });
  const queue = async () =>
    (await http().get('/api/admin/returns/after-wash').expect(200)).body as AfterWashQueue;
  const ok = (r: request.Response) => {
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    return r.body as AfterWashScanResult;
  };
  const refused = (r: request.Response, status: number, code: string) =>
    expect([r.status, r.body.code], JSON.stringify(r.body)).toEqual([status, code]);
  const codeOf = async (id: string) =>
    (await t.prisma.bottle.findUniqueOrThrow({ where: { id } })).code;
  const pieces = async (crate: MadeCrate): Promise<Piece[]> =>
    Promise.all(
      crate.bottleIds.map(async (id, i) => ({
        id,
        url: crate.bottleUrls[i]!,
        code: await codeOf(id),
      })),
    );

  /** Crates delivered by the fake carrier and received back: each bottle GOOD or DEFECTIVE. */
  async function returned(outcomes: ('GOOD' | 'DEFECTIVE')[][]): Promise<MadeCrate[]> {
    const crates: MadeCrate[] = [];
    for (let i = 0; i < outcomes.length; i++) crates.push(await factory.make());
    await deliver(t, await shipCrates(t, hotel, factory.kit.productCode, crates));
    const receipt = await api.open();
    for (const [i, crate] of crates.entries()) {
      const line = (await api.scanCrate(receipt.code, crate.crateUrl)).body.lineId as string;
      for (const [j, outcome] of outcomes[i]!.entries()) {
        await api.scanBottle(receipt.code, line, crate.bottleUrls[j]!, outcome).expect(200);
      }
    }
    return crates;
  }

  /** Everything a refused or a "Po mytí" scan must leave as it was (besides its own writes). */
  async function snapshot(bottleIds: string[]) {
    return {
      bottles: await t.prisma.bottle.findMany({
        where: { id: { in: bottleIds } },
        select: { id: true, code: true, status: true, publicToken: true },
        orderBy: { id: 'asc' },
      }),
      events: await t.prisma.bottleEvent.findMany({
        where: { bottleId: { in: bottleIds } },
        select: { id: true, type: true },
        orderBy: { id: 'asc' },
      }),
      attachments: await t.prisma.bottleComponentAttachment.findMany({
        where: { bottleId: { in: bottleIds } },
        orderBy: { id: 'asc' },
      }),
      bindings: await t.prisma.bottleProductBinding.findMany({
        where: { bottleId: { in: bottleIds } },
        orderBy: { bottleId: 'asc' },
      }),
      assignments: await t.prisma.crateAssignment.count({ where: { bottleId: { in: bottleIds } } }),
      movements: await t.prisma.inventoryMovement.count(),
      balances: (
        await t.prisma.inventoryBalance.findMany({
          select: { id: true, onHand: true },
          orderBy: { id: 'asc' },
        })
      ).map((b) => [b.id, b.onHand.toString()]),
    };
  }

  beforeAll(async () => {
    t = await createTestApp(RETURN_ENV);
    testCarrierControl.reset();
    testCarrierControl.rules.parcelWeight = 'NOT_USED';
    factory = await crateFactory(t, { capacity: 2 });
    hotel = (await createHotel(t, { name: 'Hotel Po mytí' })).code;
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

  it('"Po mytí" of a RETURNED bottle: READY_FOR_REUSE, one REUSE_READY, the pump closed for cleaning; nothing consumed, the binding and the label kept', async () => {
    const [k] = await returned([['GOOD', 'GOOD']]);
    const [b, other] = await pieces(k!);
    const before = await snapshot([b!.id, other!.id]);
    const pumpBefore = await t.prisma.bottleComponentAttachment.findFirstOrThrow({
      where: { bottleId: b!.id, componentType: 'PUMP', removedAt: null },
    });
    expect((await queue()).waiting.map((w) => w.bottleCode)).toContain(b!.code);

    const rid = randomUUID();
    const result = ok(await wash(b!.url, rid));
    expect(result).toMatchObject({
      outcome: 'READY_FOR_REUSE',
      repeated: false,
      bottleCode: b!.code,
      product: { code: factory.kit.productCode },
    });
    expect(result.design).toMatch(/ v\d+$/);

    const after = await snapshot([b!.id, other!.id]);
    // The same physical bottle: row, code and QR; the other bottle of the crate untouched.
    expect(after.bottles).toEqual(
      before.bottles.map((x) => (x.id === b!.id ? { ...x, status: 'READY_FOR_REUSE' } : x)),
    );
    const event = await t.prisma.bottleEvent.findFirstOrThrow({
      where: { bottleId: b!.id, type: 'REUSE_READY' },
    });
    expect(after.events).toEqual([...before.events, { id: event.id, type: 'REUSE_READY' }]);
    expect(event).toMatchObject({
      operationRequestId: rid,
      crateCycleId: null,
      workstationSessionId: null,
      liquidLotId: null,
      returnLineId: null,
    });
    expect(event.actorId).not.toBeNull();
    // The pump attachment (from the filling) closed by this event; the label stays installed.
    const pump = await t.prisma.bottleComponentAttachment.findUniqueOrThrow({
      where: { id: pumpBefore.id },
    });
    expect(pump).toMatchObject({
      disposition: 'CLEANING_REQUIRED',
      removalReason: 'AFTER_WASH',
      removalEventId: event.id,
    });
    expect(pump.removedAt).not.toBeNull();
    expect(after.attachments.filter((a) => a.id !== pump.id)).toEqual(
      before.attachments.filter((a) => a.id !== pump.id),
    );
    expect(
      after.attachments.filter((a) => a.bottleId === b!.id && a.componentType === 'LABEL'),
    ).toEqual([expect.objectContaining({ removedAt: null })]);
    // Nothing consumed and the binding (product, category, design) unchanged.
    expect(after.bindings).toEqual(before.bindings);
    expect([after.movements, after.balances]).toEqual([before.movements, before.balances]);
    expect(await t.prisma.inventoryMovement.count({ where: { bottleEventId: event.id } })).toBe(0);
    expect(after.assignments).toBe(before.assignments);

    const detail = (await http().get(`/api/admin/bottles/${b!.code}`).expect(200))
      .body as BottleDetail;
    expect(detail.status).toBe('READY_FOR_REUSE');
    expect(detail.events.map((e) => e.type)).toContain('REUSE_READY');
    expect(detail.reuseCycles).toBe(1);
    const q = await queue();
    expect(q.ready.map((r) => r.bottleCode)).toContain(b!.code);
    expect(q.waiting.map((w) => w.bottleCode)).not.toContain(b!.code);
    expect(q.waiting.map((w) => w.bottleCode)).toContain(other!.code);
  });

  it('repeated and replayed scans: the first result, never a second REUSE_READY; an intake does not receive it again', async () => {
    const [k] = await returned([['GOOD', 'GOOD']]);
    const [b, c] = await pieces(k!);
    const rid = randomUUID();
    const first = ok(await wash(b!.url, rid));
    // The same request: the stored response.
    expect(ok(await wash(b!.url, rid))).toEqual(first);
    // The same requestId for another bottle: a conflict, nothing written.
    refused(await wash(c!.url, rid), 409, 'IDEMPOTENCY_CONFLICT');
    expect((await t.prisma.bottle.findUniqueOrThrow({ where: { id: c!.id } })).status).toBe(
      'RETURNED',
    );
    // A new scan of the same bottle: the first result, nothing written again.
    expect(ok(await wash(b!.url))).toEqual({ ...first, repeated: true });
    expect(
      await t.prisma.bottleEvent.count({ where: { bottleId: b!.id, type: 'REUSE_READY' } }),
    ).toBe(1);
    // A later intake scan of the washed bottle is not a second return.
    const receipt = await api.open();
    const box = (await api.container(receipt.code)).body.lineId as string;
    const again = await api.scanBottle(receipt.code, box, b!.url);
    refused(again, 409, 'ALREADY_RECEIVED_ELSEWHERE');
    expect(await t.prisma.bottleEvent.count({ where: { bottleId: b!.id, type: 'SORTED' } })).toBe(
      1,
    );
  });

  it('two operators scan the same bottle at once: one REUSE_READY, the others the first result', async () => {
    const [k] = await returned([['GOOD', 'GOOD']]);
    const [b] = await pieces(k!);
    // Hold the bottle row so every request queues on it, then release them together.
    const [pending] = await withPrivileged((db) =>
      db.$transaction(async (tx) => {
        await tx.$executeRaw`SELECT 1 FROM "bottles" WHERE "id" = ${b!.id}::uuid FOR UPDATE`;
        const scans = [0, 1, 2].map(() => wash(b!.url).then((r) => r));
        await new Promise((r) => setTimeout(r, 500));
        return [scans] as const;
      }),
    );
    const raced = (await Promise.all(pending)).map(ok);
    expect(raced.map((r) => r.repeated).sort()).toEqual([false, true, true]);
    expect(new Set(raced.map((r) => r.readyAt)).size).toBe(1);
    expect(
      await t.prisma.bottleEvent.count({ where: { bottleId: b!.id, type: 'REUSE_READY' } }),
    ).toBe(1);
    expect(
      await t.prisma.bottleComponentAttachment.count({
        where: { bottleId: b!.id, componentType: 'PUMP', disposition: 'CLEANING_REQUIRED' },
      }),
    ).toBe(1);
  });

  it('refusals write nothing: RETIRED, FILLED, LABELED_EMPTY, not a bottle, not AYVO', async () => {
    const [k] = await returned([['GOOD', 'DEFECTIVE']]);
    const [, retired] = await pieces(k!);
    const [filled] = await pieces(await factory.make());
    const [empty] = await pieces(await factory.make('READY_TO_FILL'));
    const ids = [retired!.id, filled!.id, empty!.id];
    const before = await snapshot(ids);
    for (const [b, status] of [
      [retired!, 'RETIRED'],
      [filled!, 'FILLED'],
      [empty!, 'LABELED_EMPTY'],
    ] as const) {
      const r = await wash(b.url);
      refused(r, 409, 'NOT_RETURNED');
      expect(r.body.details).toEqual({ bottle: b.code, status });
    }
    refused(await wash(k!.crateUrl), 422, 'NOT_A_BOTTLE');
    refused(await wash('https://example.com/x'), 422, 'NOT_AYVO_QR');
    expect(await snapshot(ids)).toEqual(before);
  });

  it('a revoked label design: set aside, the scan refused (DESIGN_WITHDRAWN), never retired; another design unaffected', async () => {
    const [approved] = await returned([['GOOD', 'GOOD']]);
    // A new design, its crate delivered and returned, then its approval revoked.
    await factory.refill();
    const revokedVersion = factory.designVersion();
    const [x] = await returned([['GOOD', 'GOOD']]);
    const approval = await t.prisma.productLabelApproval.findFirstOrThrow({
      where: { labelTemplateVersionId: revokedVersion, revokedAt: null },
    });
    await http()
      .post(
        `/api/admin/catalog/products/${factory.kit.productCode}/label-approvals/${approval.id}/revoke`,
      )
      .send({ requestId: randomUUID(), reason: 'design stažen' })
      .expect(200);
    const set = await pieces(x!);
    const q = await queue();
    expect(q.withdrawn.map((w) => w.bottleCode)).toEqual(
      expect.arrayContaining(set.map((p) => p.code)),
    );
    expect(q.waiting.map((w) => w.bottleCode)).not.toContain(set[0]!.code);
    expect(q.counts.withdrawn).toBe(q.withdrawn.length);

    const before = await snapshot(set.map((p) => p.id));
    const r = await wash(set[0]!.url);
    refused(r, 409, 'DESIGN_WITHDRAWN');
    expect(r.body.details).toEqual({ bottle: set[0]!.code });
    expect(await snapshot(set.map((p) => p.id))).toEqual(before);
    expect(
      await t.prisma.bottleEvent.count({
        where: { bottleId: { in: set.map((p) => p.id) }, type: { in: ['RETIRED', 'REUSE_READY'] } },
      }),
    ).toBe(0);
    // The still approved design passes as before.
    const [a] = await pieces(approved!);
    expect(ok(await wash(a!.url)).repeated).toBe(false);
    // Later crates of this factory need an approved design again.
    await factory.refill();
  });

  it('in R2 a bottle "Po mytí" enters no crate — station, "Doplnit lahev", direct SQL; meanwhile new bottles are labelled, filled, finished, picked and delivered as today', async () => {
    const [k] = await returned([['GOOD', 'GOOD']]);
    const [b] = await pieces(k!);
    ok(await wash(b!.url));

    // An assembling crate of the same product and design with one free place.
    const target = await factory.make('READY_TO_FILL');
    const out = await correctCrate(t, target.crateCode, 'remove-bottle', {
      bottle: await codeOf(target.bottleIds[0]!),
    });
    expect(out.status, JSON.stringify(out.body)).toBe(200);
    expect((out.body as CycleCorrectionResult).cycle!.status).toBe('OPEN_ASSEMBLY');
    // The labelling station of the same product and design, a new crate loaded (opened last:
    // a new session of the same user releases the older one).
    const station = await factory.openStation();
    const crate = await t.prisma.crate.findUniqueOrThrow({
      where: { qrToken: station.crateUrl.split('/').pop()! },
    });

    const before = await snapshot([b!.id]);
    const scan = await labelScan(t, station.sessionId, b!.url);
    refused(scan, 409, 'NOT_PLACEABLE_YET');
    expect(scan.body.details).toEqual({ bottle: b!.code });

    // "Doplnit lahev" into an assembling crate with a free place.
    const add = await correctCrate(t, target.crateCode, 'add-bottle', { bottle: b!.code });
    refused(add, 409, 'NOT_PLACEABLE_YET');

    // Direct SQL by the running core role: a complete, otherwise consistent membership.
    const row = await t.prisma.crateCycle.findFirstOrThrow({
      where: { crate: { code: target.crateCode } },
      orderBy: { openedAt: 'desc' },
    });
    const member = await t.prisma.crateAssignment.findFirstOrThrow({
      where: { cycleId: row.id, releasedAt: null },
    });
    for (const source of ['REPACKED', 'LABELING'] as const) {
      await expect(
        t.prisma.$transaction(async (tx) => {
          await tx.$executeRaw`INSERT INTO "bottle_events" ("bottle_id", "type", "occurred_at", "actor_id",
              "crate_cycle_id", "operation_request_id", "payload")
            VALUES (${b!.id}::uuid, 'ASSIGNED_TO_CRATE', now(), ${member.assignedBy}::uuid, ${row.id}::uuid,
              ${member.operationRequestId}::uuid, jsonb_build_object('source', ${source}::text))`;
          await tx.$executeRaw`INSERT INTO "crate_assignments" ("cycle_id", "cycle_capacity", "bottle_id", "ordinal",
              "source", "assigned_by", "operation_request_id", "assigned_event_id")
            SELECT ${row.id}::uuid, ${row.capacity}, ${b!.id}::uuid,
              (SELECT min(o) FROM generate_series(1, ${row.capacity}) o
                WHERE o NOT IN (SELECT "ordinal" FROM "crate_assignments" WHERE "cycle_id" = ${row.id}::uuid AND "released_at" IS NULL)),
              ${source}::"CrateAssignmentSource", ${member.assignedBy}::uuid, ${member.operationRequestId}::uuid,
              (SELECT "id" FROM "bottle_events" WHERE "bottle_id" = ${b!.id}::uuid AND "type" = 'ASSIGNED_TO_CRATE'
                ORDER BY "id" DESC LIMIT 1)`;
          // The capacity-th member makes it READY_TO_FILL with its crate event (as addMember does).
          await tx.$executeRaw`UPDATE "crate_cycles" SET "member_count" = "member_count" + 1, "status" = 'READY_TO_FILL',
              "ready_to_fill_at" = now() WHERE "id" = ${row.id}::uuid`;
          await tx.$executeRaw`INSERT INTO "crate_events" ("crate_id", "cycle_id", "type", "occurred_at", "actor_id", "site_id", "operation_request_id")
            VALUES (${row.crateId}::uuid, ${row.id}::uuid, 'READY_TO_FILL', now(), ${member.assignedBy}::uuid,
              ${row.siteId}::uuid, ${member.operationRequestId}::uuid)`;
        }),
        source,
      ).rejects.toThrow(/a crate takes a new member only in LABELED_EMPTY or FILLED/);
    }
    // Nothing of the attempts is left: the bottle, its events and the crates as they were.
    expect(await snapshot([b!.id])).toEqual(before);
    expect(await t.prisma.crateAssignment.count({ where: { cycle: { crateId: crate.id } } })).toBe(
      0,
    );

    // Today's walk of new bottles, unchanged, while READY_FOR_REUSE bottles exist.
    const fresh = await factory.make();
    const shipped = await shipCrates(t, hotel, factory.kit.productCode, [fresh]);
    await deliver(t, shipped);
    expect(
      (
        await t.prisma.crateCycle.findFirstOrThrow({
          where: { crate: { code: fresh.crateCode } },
          orderBy: { openedAt: 'desc' },
        })
      ).status,
    ).toBe('DELIVERED');
    expect((await t.prisma.bottle.findUniqueOrThrow({ where: { id: b!.id } })).status).toBe(
      'READY_FOR_REUSE',
    );
  });

  describe('database guards (direct SQL by the running core role, committed)', () => {
    const fails = (p: Promise<unknown>, message: RegExp) => expect(p).rejects.toThrow(message);

    /** A RETURNED bottle with its SORTED's operation and actor (valid references for SQL). */
    async function returnedBottle() {
      const [k] = await returned([['GOOD', 'GOOD']]);
      const [b, c] = await pieces(k!);
      const sorted = await t.prisma.bottleEvent.findFirstOrThrow({
        where: { bottleId: b!.id, type: 'SORTED' },
      });
      return { b: b!, c: c!, op: sorted.operationRequestId!, actor: sorted.actorId! };
    }
    const reuseEvent = (bottleId: string, op: string, actor: string) =>
      `INSERT INTO "bottle_events" ("bottle_id", "type", "occurred_at", "actor_id", "operation_request_id")
       VALUES ('${bottleId}', 'REUSE_READY', now(), '${actor}', '${op}')`;

    it('RETURNED → READY_FOR_REUSE only with one REUSE_READY that closes the pump for cleaning', async () => {
      const { b, op, actor } = await returnedBottle();
      // The status alone.
      await fails(
        t.prisma
          .$executeRaw`UPDATE "bottles" SET "status" = 'READY_FOR_REUSE' WHERE "id" = ${b.id}::uuid`,
        /bottle status READY_FOR_REUSE needs its event/,
      );
      // The event alone.
      await fails(
        t.prisma.$executeRawUnsafe(reuseEvent(b.id, op, actor)),
        /REUSE_READY makes the bottle READY_FOR_REUSE/,
      );
      // Event and status, the pump left attached.
      await fails(
        t.prisma.$transaction(async (tx) => {
          await tx.$executeRawUnsafe(reuseEvent(b.id, op, actor));
          await tx.$executeRaw`UPDATE "bottles" SET "status" = 'READY_FOR_REUSE' WHERE "id" = ${b.id}::uuid`;
        }),
        /has no pump attached/,
      );
      // The pump closed with another disposition, or the label closed by it.
      for (const [component, disposition] of [
        ['PUMP', 'SCRAPPED'],
        ['LABEL', 'CLEANING_REQUIRED'],
      ] as const) {
        await fails(
          t.prisma.$transaction(async (tx) => {
            await tx.$executeRawUnsafe(reuseEvent(b.id, op, actor));
            await tx.$executeRaw`UPDATE "bottle_component_attachments" SET "removed_at" = now(), "removed_by" = ${actor}::uuid,
                "removal_reason" = 'test', "disposition" = ${disposition}::"ComponentDisposition",
                "removal_event_id" = (SELECT "id" FROM "bottle_events" WHERE "bottle_id" = ${b.id}::uuid
                  AND "type" = 'REUSE_READY' ORDER BY "id" DESC LIMIT 1)
              WHERE "bottle_id" = ${b.id}::uuid AND "removed_at" IS NULL
                AND "component_type" IN ('PUMP', ${component}::"ComponentType")`;
            await tx.$executeRaw`UPDATE "bottles" SET "status" = 'READY_FOR_REUSE' WHERE "id" = ${b.id}::uuid`;
          }),
          /closes only the pump, for cleaning/,
        );
      }
      // REUSE_READY names no crate cycle.
      const cycle = await t.prisma.crateAssignment.findFirstOrThrow({ where: { bottleId: b.id } });
      await fails(
        t.prisma
          .$executeRaw`INSERT INTO "bottle_events" ("bottle_id", "type", "occurred_at", "actor_id",
            "operation_request_id", "crate_cycle_id")
          VALUES (${b.id}::uuid, 'REUSE_READY', now(), ${actor}::uuid, ${op}::uuid, ${cycle.cycleId}::uuid)`,
        /belongs to no crate cycle or station/,
      );
      expect((await t.prisma.bottle.findUniqueOrThrow({ where: { id: b.id } })).status).toBe(
        'RETURNED',
      );
      // The complete write commits (the same as the API's).
      await t.prisma.$transaction(async (tx) => {
        await tx.$executeRawUnsafe(reuseEvent(b.id, op, actor));
        await tx.$executeRaw`UPDATE "bottle_component_attachments" SET "removed_at" = now(), "removed_by" = ${actor}::uuid,
            "removal_reason" = 'AFTER_WASH', "disposition" = 'CLEANING_REQUIRED',
            "removal_event_id" = (SELECT "id" FROM "bottle_events" WHERE "bottle_id" = ${b.id}::uuid
              AND "type" = 'REUSE_READY' ORDER BY "id" DESC LIMIT 1)
          WHERE "bottle_id" = ${b.id}::uuid AND "removed_at" IS NULL AND "component_type" = 'PUMP'`;
        await tx.$executeRaw`UPDATE "bottles" SET "status" = 'READY_FOR_REUSE' WHERE "id" = ${b.id}::uuid`;
      });
      // …exactly once: a second REUSE_READY is refused at once.
      await fails(
        t.prisma.$executeRawUnsafe(reuseEvent(b.id, op, actor)),
        /only a RETURNED bottle/,
      );
      // …and nothing leaves READY_FOR_REUSE in R2.
      for (const next of ['RETURNED', 'RETIRED', 'LABELED_EMPTY', 'FILLED', 'DISPOSED']) {
        await fails(
          t.prisma.$executeRawUnsafe(
            `UPDATE "bottles" SET "status" = '${next}' WHERE "id" = '${b.id}'`,
          ),
          /is not allowed/,
        );
      }
    });

    it('a filled bottle — also a loose one, taken out of its crate — never becomes READY_FOR_REUSE', async () => {
      const made = await factory.make('FILLING');
      const [filled] = await pieces(made);
      const out = await correctCrate(t, made.crateCode, 'remove-bottle', { bottle: filled!.code });
      expect(out.status, JSON.stringify(out.body)).toBe(200);
      expect(
        await t.prisma.crateAssignment.count({ where: { bottleId: filled!.id, releasedAt: null } }),
      ).toBe(0);
      const event = await t.prisma.bottleEvent.findFirstOrThrow({
        where: { bottleId: filled!.id, type: 'FILLED' },
      });
      await fails(
        t.prisma.$executeRawUnsafe(
          reuseEvent(filled!.id, event.operationRequestId!, event.actorId!),
        ),
        /only a RETURNED bottle/,
      );
      await fails(
        t.prisma
          .$executeRaw`UPDATE "bottles" SET "status" = 'READY_FOR_REUSE' WHERE "id" = ${filled!.id}::uuid`,
        /FILLED → READY_FOR_REUSE is not allowed/,
      );
    });

    it('the ledger: no movement may name a REUSE_READY', async () => {
      const [k] = await returned([['GOOD', 'GOOD']]);
      const [b] = await pieces(k!);
      ok(await wash(b!.url));
      const reuse = await t.prisma.bottleEvent.findFirstOrThrow({
        where: { bottleId: b!.id, type: 'REUSE_READY' },
      });
      for (const type of ['LABEL_APPLIED', 'FILLED'] as const) {
        const source = await t.prisma.bottleEvent.findFirstOrThrow({
          where: { bottleId: b!.id, type },
        });
        // Its own consumption copied onto the REUSE_READY: refused.
        await fails(
          t.prisma.$executeRaw`INSERT INTO "inventory_movements"
            SELECT * FROM jsonb_populate_record(NULL::"inventory_movements",
              (SELECT to_jsonb(m) || jsonb_build_object('id', uuidv7(), 'bottle_event_id', ${reuse.id}::uuid)
                 FROM "inventory_movements" m WHERE m."bottle_event_id" = ${source.id}::uuid LIMIT 1))`,
          /AYVO:/,
        );
      }
      expect(await t.prisma.inventoryMovement.count({ where: { bottleEventId: reuse.id } })).toBe(
        0,
      );
    });
  });
});
