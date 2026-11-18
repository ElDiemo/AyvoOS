import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { testCarrierControl } from '../src/carriers/test-carrier.js';
import {
  chooseLiquidLot,
  correctCrate,
  fillingSession,
  fillLoadCrate,
  fillScan,
  finishCrate,
  labelScan,
  registerCrate,
} from './support/labeling-fixtures.js';
import { crateFactory, createHotel, type MadeCrate } from './support/order-fixtures.js';
import { deliver, pickUp, RETURN_ENV, returnsApi, shipCrates } from './support/return-fixtures.js';
import { createTestApp, hasDatabase, type TestApp } from './support/test-app.js';
import { receiveItem } from './support/warehouse-fixtures.js';

type Factory = Awaited<ReturnType<typeof crateFactory>>;

/**
 * R3-b (doc 048 §3.0–§3.3, §8.3; owner 2026-11-09): the second circulation of one physical bottle.
 * Delivered → returned and identified (R1) → "Po mytí" (R2) → placed at the ordinary labelling
 * station like a new bottle (REUSE: no label, nothing consumed) next to a new bottle in one crate →
 * filled (liquid consumed, no new pump; a washed pump attached) → Hotovo → shipped and delivered
 * again. One filling per circulation, anchored to its REUSE_READY. The FAKE test carrier only.
 */
describe.skipIf(!hasDatabase)('R3-b: a washed bottle back into production', () => {
  let t: TestApp;
  let factory: Factory;
  let hotel: string;
  let api: ReturnType<typeof returnsApi>;
  const http = () => request(t.app.getHttpServer());
  const wash = (url: string) =>
    http()
      .post('/api/admin/returns/after-wash')
      .send({ requestId: randomUUID(), scannedValue: url });

  /** A crate delivered and received back, every bottle GOOD, then washed ("Po mytí"). */
  async function washedCrate(): Promise<MadeCrate> {
    const crate = await factory.make();
    const shipped = await shipCrates(t, hotel, factory.kit.productCode, [crate]);
    await pickUp(t, shipped);
    await deliver(t, shipped);
    const receipt = await api.open();
    await api.scanCrate(receipt.code, crate.crateUrl).expect(200);
    for (const url of crate.bottleUrls) await api.scanBottle(receipt.code, url, 'GOOD').expect(200);
    for (const url of crate.bottleUrls) expect((await wash(url)).status).toBe(200);
    return crate;
  }
  const balance = async (itemId: string) =>
    (
      await t.prisma.inventoryBalance.aggregate({ where: { itemId }, _sum: { onHand: true } })
    )._sum.onHand!.toString();

  beforeAll(async () => {
    t = await createTestApp(RETURN_ENV);
    testCarrierControl.reset();
    testCarrierControl.rules.parcelWeight = 'NOT_USED';
    factory = await crateFactory(t, { capacity: 2 });
    hotel = (await createHotel(t, { name: 'Hotel Druhý oběh' })).code;
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

  it('a washed and a new bottle in one crate: placed, filled (no new pump for the washed one), Hotovo, delivered again', async () => {
    const first = await washedCrate();
    const reused = { id: first.bottleIds[0]!, url: first.bottleUrls[0]! };
    expect((await t.prisma.bottle.findUniqueOrThrow({ where: { id: reused.id } })).status).toBe(
      'READY_FOR_REUSE',
    );

    // The ordinary station: the washed bottle is only placed, a new one labelled as today.
    const station = await factory.openStation();
    const pumpsBefore = await balance(factory.kit.pumpItemId);
    const movementsBefore = await t.prisma.inventoryMovement.count();
    const placed = await labelScan(t, station.sessionId, reused.url);
    expect(placed.status, JSON.stringify(placed.body)).toBe(200);
    expect(placed.body.outcome).toBe('PLACED');
    expect(await t.prisma.inventoryMovement.count()).toBe(movementsBefore); // nothing consumed
    expect(
      await t.prisma.bottleEvent.count({ where: { bottleId: reused.id, type: 'LABEL_APPLIED' } }),
    ).toBe(1); // never labelled again
    // A duplicate scan writes nothing.
    expect((await labelScan(t, station.sessionId, reused.url)).body.outcome).toBe(
      'ALREADY_APPLIED',
    );
    // A new, printed bottle of the same design, labelled into the same crate as today.
    const siteId = (await t.prisma.bottle.findUniqueOrThrow({ where: { id: reused.id } })).siteId;
    const spare = await t.prisma.bottle.findFirstOrThrow({
      where: { status: 'CREATED', siteId, printJobItems: { some: {} } },
      orderBy: { serial: 'desc' },
    });
    const spareUrl = (
      await t.prisma.labelPrintJobItem.findFirstOrThrow({ where: { bottleId: spare.id } })
    ).qrUrl;
    const labelled = await labelScan(t, station.sessionId, spareUrl);
    expect(labelled.status, JSON.stringify(labelled.body)).toBe(200);
    expect(labelled.body.outcome).toBe('APPLIED');
    expect(labelled.body.cycle.status).toBe('READY_TO_FILL'); // 1 washed + 1 new = capacity 2
    const crate = await t.prisma.crateCycle.findFirstOrThrow({
      where: { crate: { qrToken: station.crateUrl.split('/').pop()! } },
      orderBy: { openedAt: 'desc' },
      include: { assignments: { where: { releasedAt: null } }, crate: true },
    });
    expect(crate.assignments.map((a) => a.source).sort()).toEqual(['LABELING', 'REUSE']);

    // Filling: liquid for both, a new pump only for the new bottle.
    const fs = await fillingSession(t, 'HAND_SOAP');
    expect((await fillLoadCrate(t, fs, station.crateUrl)).status).toBe(200);
    const lot = await factory.receiveLiquid();
    expect((await chooseLiquidLot(t, fs, lot)).status).toBe(200);
    const pumpsAfterLabel = await balance(factory.kit.pumpItemId);
    expect(pumpsAfterLabel).toBe(pumpsBefore);
    const r1 = await fillScan(t, fs, reused.url);
    expect(r1.status, JSON.stringify(r1.body)).toBe(200);
    expect(await balance(factory.kit.pumpItemId)).toBe(pumpsBefore); // no new pump
    const r2 = await fillScan(t, fs, spareUrl);
    expect(r2.status, JSON.stringify(r2.body)).toBe(200);
    expect(Number(await balance(factory.kit.pumpItemId))).toBe(Number(pumpsBefore) - 1);
    expect((await finishCrate(t, fs)).status).toBe(200);

    // The washed bottle: two fillings, one per circulation; the second anchored to REUSE_READY,
    // with a new pump attachment and no pump movement.
    const fills = await t.prisma.bottleEvent.findMany({
      where: { bottleId: reused.id, type: 'FILLED' },
      orderBy: { id: 'asc' },
      include: {
        fillCirculation: { include: { circulation: true } },
        movements: { include: { item: true } },
      },
    });
    expect(fills.map((f) => f.fillCirculation!.circulation.type)).toEqual([
      'LABEL_APPLIED',
      'REUSE_READY',
    ]);
    expect(fills[1]!.movements.map((m) => m.item.kind)).not.toContain('PUMP');
    expect(fills[1]!.movements.some((m) => m.item.kind === 'BULK_LIQUID')).toBe(true);
    expect(
      await t.prisma.bottleComponentAttachment.count({
        where: { bottleId: reused.id, componentType: 'PUMP', removedAt: null },
      }),
    ).toBe(1);

    // The database refuses a new pump written off for the washed bottle's filling (direct SQL).
    const pump = await t.prisma.inventoryMovement.findFirstOrThrow({
      where: { type: 'FILL', item: { kind: 'PUMP' }, bottleEvent: { bottleId: spare.id } },
    });
    await expect(
      t.prisma.inventoryMovement.create({
        data: {
          itemId: pump.itemId,
          unitId: pump.unitId,
          locationId: pump.locationId,
          lotId: pump.lotId,
          quantityDelta: pump.quantityDelta,
          type: 'FILL',
          bottleEventId: fills[1]!.id,
          bomLineId: pump.bomLineId,
          occurredAt: new Date(),
          actorId: pump.actorId,
          requestId: randomUUID(),
        },
      }),
    ).rejects.toThrow(/consumes no new pump/);

    // Shipped and delivered again with the unchanged code.
    const made: MadeCrate = {
      crateUrl: station.crateUrl,
      crateCode: crate.crate.code,
      bottleIds: [reused.id, spare.id],
      bottleUrls: [reused.url, spareUrl],
    };
    const again = await shipCrates(t, hotel, factory.kit.productCode, [made]);
    await pickUp(t, again);
    await deliver(t, again);
    expect((await t.prisma.bottle.findUniqueOrThrow({ where: { id: reused.id } })).status).toBe(
      'FILLED',
    );
  });

  it('the database places a REUSE member only for a washed bottle placed after its "Po mytí"', async () => {
    // An assembling crate with one free place (a bottle taken out by the supervised removal).
    const made = await factory.make('READY_TO_FILL');
    const out = await correctCrate(t, made.crateCode, 'remove-bottle', {
      bottle: (await t.prisma.bottle.findUniqueOrThrow({ where: { id: made.bottleIds[1]! } })).code,
    });
    expect(out.status, JSON.stringify(out.body)).toBe(200);
    const cycle = await t.prisma.crateCycle.findFirstOrThrow({
      where: { crate: { code: made.crateCode } },
      orderBy: { openedAt: 'desc' },
    });
    expect(cycle.status).toBe('OPEN_ASSEMBLY');
    const member = await t.prisma.crateAssignment.findFirstOrThrow({
      where: { cycleId: cycle.id, releasedAt: null },
    });
    const bottleId = made.bottleIds[1]!; // LABELED_EMPTY, in no crate now
    /** A complete, otherwise consistent REUSE membership by direct SQL (as addMember writes it). */
    const attempt = (id: string) =>
      t.prisma.$transaction(async (tx) => {
        await tx.$executeRaw`INSERT INTO "bottle_events" ("bottle_id", "type", "occurred_at", "actor_id",
            "crate_cycle_id", "operation_request_id", "payload")
          VALUES (${id}::uuid, 'ASSIGNED_TO_CRATE', now(), ${member.assignedBy}::uuid, ${cycle.id}::uuid,
            ${member.operationRequestId}::uuid, jsonb_build_object('source', 'REUSE'))`;
        await tx.$executeRaw`INSERT INTO "crate_assignments" ("cycle_id", "cycle_capacity", "bottle_id", "ordinal",
            "source", "assigned_by", "operation_request_id", "assigned_event_id")
          SELECT ${cycle.id}::uuid, ${cycle.capacity}, ${id}::uuid,
            (SELECT min(o) FROM generate_series(1, ${cycle.capacity}) o
              WHERE o NOT IN (SELECT "ordinal" FROM "crate_assignments" WHERE "cycle_id" = ${cycle.id}::uuid AND "released_at" IS NULL)),
            'REUSE', ${member.assignedBy}::uuid, ${member.operationRequestId}::uuid,
            (SELECT "id" FROM "bottle_events" WHERE "bottle_id" = ${id}::uuid AND "type" = 'ASSIGNED_TO_CRATE'
              ORDER BY "id" DESC LIMIT 1)`;
        await tx.$executeRaw`UPDATE "crate_cycles" SET "member_count" = "member_count" + 1, "status" = 'READY_TO_FILL',
            "ready_to_fill_at" = now() WHERE "id" = ${cycle.id}::uuid`;
        await tx.$executeRaw`INSERT INTO "crate_events" ("crate_id", "cycle_id", "type", "occurred_at", "actor_id", "site_id", "operation_request_id")
          VALUES (${cycle.crateId}::uuid, ${cycle.id}::uuid, 'READY_TO_FILL', now(), ${member.assignedBy}::uuid,
            ${cycle.siteId}::uuid, ${member.operationRequestId}::uuid)`;
      });
    const rule = /a REUSE member is a washed bottle placed after its REUSE_READY/;
    // A labelled bottle that was never returned: refused, nothing left.
    const events = await t.prisma.bottleEvent.count({ where: { bottleId } });
    await expect(attempt(bottleId)).rejects.toThrow(rule);
    expect(await t.prisma.bottleEvent.count({ where: { bottleId } })).toBe(events);
    // A RETURNED bottle not yet "Po mytí".
    const back = await (async () => {
      const crate = await factory.make();
      const shipped = await shipCrates(t, hotel, factory.kit.productCode, [crate]);
      await pickUp(t, shipped);
      await deliver(t, shipped);
      const receipt = await api.open();
      await api.scanCrate(receipt.code, crate.crateUrl).expect(200);
      await api.scanBottle(receipt.code, crate.bottleUrls[0]!, 'GOOD').expect(200);
      return crate.bottleIds[0]!;
    })();
    expect((await t.prisma.bottle.findUniqueOrThrow({ where: { id: back } })).status).toBe(
      'RETURNED',
    );
    await expect(attempt(back)).rejects.toThrow(rule);
    expect(
      await t.prisma.crateAssignment.count({ where: { bottleId: back, releasedAt: null } }),
    ).toBe(0);
  });
  /** A printed, not yet labelled bottle of the factory's current design at the bottle's site. */
  async function spareOf(siteId: string) {
    const spare = await t.prisma.bottle.findFirstOrThrow({
      where: { status: 'CREATED', siteId, printJobItems: { some: {} } },
      orderBy: { serial: 'desc' },
    });
    const url = (
      await t.prisma.labelPrintJobItem.findFirstOrThrow({ where: { bottleId: spare.id } })
    ).qrUrl;
    return { id: spare.id, url };
  }

  it('a crate of washed bottles needs no lot of new bottles; a new bottle without one writes nothing', async () => {
    const washed = await washedCrate();
    const station = await factory.openStation({ withLot: false });
    const state = await http().get(`/api/admin/station-sessions/${station.sessionId}/labeling`);
    expect(state.body.sourceLot).toBeNull();
    const siteId = (
      await t.prisma.bottle.findUniqueOrThrow({ where: { id: washed.bottleIds[0]! } })
    ).siteId;
    const movements = await t.prisma.inventoryMovement.count();
    const first = await labelScan(t, station.sessionId, washed.bottleUrls[0]!);
    expect(first.status, JSON.stringify(first.body)).toBe(200);
    expect(first.body.outcome).toBe('PLACED');
    expect(first.body.sourceLot).toBeNull();
    // A new bottle in the same series: refused, nothing written — no label, no stock, no event.
    const fresh = await spareOf(siteId);
    const events = await t.prisma.bottleEvent.count({ where: { bottleId: fresh.id } });
    const refused = await labelScan(t, station.sessionId, fresh.url);
    expect(refused.status, JSON.stringify(refused.body)).toBe(409);
    expect(refused.body.code).toBe('LOT_REQUIRED');
    expect((await t.prisma.bottle.findUniqueOrThrow({ where: { id: fresh.id } })).status).toBe(
      'CREATED',
    );
    expect(await t.prisma.bottleEvent.count({ where: { bottleId: fresh.id } })).toBe(events);
    expect(await t.prisma.inventoryMovement.count()).toBe(movements);
    // The second washed bottle fills the crate; still nothing consumed.
    const second = await labelScan(t, station.sessionId, washed.bottleUrls[1]!);
    expect(second.status, JSON.stringify(second.body)).toBe(200);
    expect(second.body.outcome).toBe('PLACED');
    expect(second.body.cycle.status).toBe('READY_TO_FILL');
    expect(await t.prisma.inventoryMovement.count()).toBe(movements);
  });

  it('"Doplnit lahev" of a refilled bottle uses the recipe of its latest filling, not of its labelling', async () => {
    // Crate A: assembled and partly filled with recipe version 1 (one free place after a removal).
    const a = await factory.make('FILLING');
    const freed = await correctCrate(t, a.crateCode, 'remove-bottle', {
      bottle: (await t.prisma.bottle.findUniqueOrThrow({ where: { id: a.bottleIds[1]! } })).code,
    });
    expect(freed.status, JSON.stringify(freed.body)).toBe(200);
    const product = factory.kit.productCode;
    const catalog = '/api/admin/catalog';
    const items = await t.prisma.inventoryItem.findMany({
      where: {
        id: { in: [factory.kit.labelItemId, factory.kit.liquidItemId, factory.kit.pumpItemId] },
      },
    });
    const code = (id: string) => items.find((i) => i.id === id)!.code;
    const washed = await washedCrate(); // labelled with recipe version 1
    const reused = { id: washed.bottleIds[0]!, url: washed.bottleUrls[0]! };
    // Recipe version 2 becomes active: the second circulation is filled with it.
    const v2 = await http()
      .post(`${catalog}/products/${product}/recipes`)
      .send({
        requestId: randomUUID(),
        reason: 'nová receptura',
        crateTypeCode: factory.kit.crateTypeCode,
        components: [
          { itemCode: 'NEW_BOTTLE', quantity: '1', unitCode: 'pcs' },
          { itemCode: code(factory.kit.labelItemId), quantity: '1', unitCode: 'pcs' },
          { itemCode: code(factory.kit.liquidItemId), quantity: '330', unitCode: 'ml' },
          { itemCode: code(factory.kit.pumpItemId), quantity: '1', unitCode: 'pcs' },
        ],
      });
    expect(v2.status, JSON.stringify(v2.body)).toBe(201);
    const version = v2.body.version as number;
    const activated = await http()
      .post(`${catalog}/products/${product}/recipes/${version}/activate`)
      .send({ requestId: randomUUID(), reason: 'schváleno', expectedActiveVersion: version - 1 });
    expect(activated.status, JSON.stringify(activated.body)).toBe(200);
    // The last test of this file: the factory's product keeps recipe 2 from here on.
    // Crate B (recipe 2): the washed bottle placed next to a new one; only the washed one filled.
    const station = await factory.openStation();
    expect((await labelScan(t, station.sessionId, reused.url)).body.outcome).toBe('PLACED');
    const siteId = (await t.prisma.bottle.findUniqueOrThrow({ where: { id: reused.id } })).siteId;
    const fresh = await spareOf(siteId);
    expect((await labelScan(t, station.sessionId, fresh.url)).body.outcome).toBe('APPLIED');
    const fs = await fillingSession(t, 'HAND_SOAP');
    expect((await fillLoadCrate(t, fs, station.crateUrl)).status).toBe(200);
    expect((await chooseLiquidLot(t, fs, await factory.receiveLiquid())).status).toBe(200);
    const filled = await fillScan(t, fs, reused.url);
    expect(filled.status, JSON.stringify(filled.body)).toBe(200);
    const b = await t.prisma.crateCycle.findFirstOrThrow({
      where: { crate: { qrToken: station.crateUrl.split('/').pop()! } },
      orderBy: { openedAt: 'desc' },
      include: { crate: true, recipeVersion: true },
    });
    expect(b.recipeVersion.version).toBe(version);
    const bottle = (await t.prisma.bottle.findUniqueOrThrow({ where: { id: reused.id } })).code;
    const out = () => correctCrate(t, b.crate.code, 'remove-bottle', { bottle });
    expect((await out()).status).toBe(200);
    const movements = await t.prisma.inventoryMovement.count();

    // Into crate A (recipe 1, the recipe of its labelling): refused.
    const intoA = await correctCrate(t, a.crateCode, 'add-bottle', { bottle });
    expect(intoA.status, JSON.stringify(intoA.body)).toBe(409);
    expect(intoA.body.code).toBe('SNAPSHOT_MISMATCH');
    // Back into crate B (recipe 2, filling): accepted, nothing consumed.
    const intoB = await correctCrate(t, b.crate.code, 'add-bottle', { bottle });
    expect(intoB.status, JSON.stringify(intoB.body)).toBe(200);
    expect(await t.prisma.inventoryMovement.count()).toBe(movements);
    // Into an empty crate: a FILLING cycle with recipe 2 (the database accepts it), no consumption.
    expect((await out()).status).toBe(200);
    const emptyUrl = await registerCrate(t, factory.kit.crateTypeCode);
    const empty = await t.prisma.crate.findUniqueOrThrow({
      where: { qrToken: emptyUrl.split('/').pop()! },
    });
    const intoEmpty = await correctCrate(t, empty.code, 'add-bottle', { bottle });
    expect(intoEmpty.status, JSON.stringify(intoEmpty.body)).toBe(200);
    const c = await t.prisma.crateCycle.findFirstOrThrow({
      where: { crateId: empty.id },
      include: { recipeVersion: true, assignments: { where: { releasedAt: null } } },
    });
    expect(c.status).toBe('FILLING');
    expect(c.recipeVersion.version).toBe(version);
    expect(c.assignments.map((m) => [m.bottleId, m.source])).toEqual([[reused.id, 'REPACKED']]);
    expect(await t.prisma.inventoryMovement.count()).toBe(movements);
  });

  it('R1.1 + R3: the same crate and the same bottle through two circulations — reuse 0 → 1 → 2; the crate scan never counts, stock only by real fillings', async () => {
    const reuseOf = async (id: string) => {
      const code = (await t.prisma.bottle.findUniqueOrThrow({ where: { id } })).code;
      return (await http().get(`/api/admin/bottles/${code}`).expect(200)).body
        .reuseCycles as number;
    };
    // Circulation 1: K with b and c, delivered.
    const k = await factory.make();
    const [b, c] = [
      { id: k.bottleIds[0]!, url: k.bottleUrls[0]! },
      { id: k.bottleIds[1]!, url: k.bottleUrls[1]! },
    ];
    expect(await reuseOf(b.id)).toBe(0);
    const o1 = await shipCrates(t, hotel, factory.kit.productCode, [k]);
    await pickUp(t, o1);
    await deliver(t, o1);
    const k1 = await t.prisma.crateCycle.findFirstOrThrow({
      where: { crate: { code: k.crateCode } },
      orderBy: { openedAt: 'desc' },
    });
    // The crate scan frees K and counts nothing; each bottle's own scan counts once.
    const r1 = await api.open();
    expect((await api.scanCrate(r1.code, k.crateUrl).expect(200)).body.freed).toBe(2);
    expect(await reuseOf(b.id)).toBe(0);
    await api.scanBottle(r1.code, b.url).expect(200);
    await api.scanBottle(r1.code, c.url).expect(200);
    expect(await reuseOf(b.id)).toBe(1);
    await api.scanBottle(r1.code, b.url).expect(200); // a rescan: the first result, no second count
    expect(await reuseOf(b.id)).toBe(1);
    // Po mytí → K plnění.
    expect((await wash(b.url)).status).toBe(200);
    expect((await wash(c.url)).status).toBe(200);

    // Circulation 2: the SAME crate K, the SAME QR codes, placed and filled the ordinary way.
    const pumps = await balance(factory.kit.pumpItemId);
    const liquid = await balance(factory.kit.liquidItemId);
    const movements = await t.prisma.inventoryMovement.count();
    const station = await factory.openStation({ withLot: false, crateUrl: k.crateUrl });
    expect((await labelScan(t, station.sessionId, b.url)).body.outcome).toBe('PLACED');
    const second = await labelScan(t, station.sessionId, c.url);
    expect([second.body.outcome, second.body.cycle.status]).toEqual(['PLACED', 'READY_TO_FILL']);
    expect(await t.prisma.inventoryMovement.count()).toBe(movements); // placing consumes nothing
    const fs = await fillingSession(t, 'HAND_SOAP');
    expect((await fillLoadCrate(t, fs, k.crateUrl)).status).toBe(200);
    expect((await chooseLiquidLot(t, fs, await factory.receiveLiquid())).status).toBe(200);
    const liquidReceived = await balance(factory.kit.liquidItemId);
    for (const x of [b, c]) {
      const r = await fillScan(t, fs, x.url);
      expect(r.status, JSON.stringify(r.body)).toBe(200);
    }
    expect((await finishCrate(t, fs)).status).toBe(200);
    // The real fillings: liquid of the reuse recipe for each, no new pump.
    expect(await balance(factory.kit.pumpItemId)).toBe(pumps);
    expect(Number(liquidReceived) - Number(await balance(factory.kit.liquidItemId))).toBe(2 * 330);
    expect(Number(liquidReceived)).toBeGreaterThan(Number(liquid));
    const k2 = await t.prisma.crateCycle.findFirstOrThrow({
      where: { crate: { code: k.crateCode } },
      orderBy: { openedAt: 'desc' },
    });
    expect(k2.id).not.toBe(k1.id);
    const o2 = await shipCrates(t, hotel, factory.kit.productCode, [k]);
    await pickUp(t, o2);
    await deliver(t, o2);
    expect(await reuseOf(b.id)).toBe(1); // a delivery completes nothing

    // Back again: freed by K's scan, b identified for K2 — the counter is 2.
    const r2 = await api.open();
    expect((await api.scanCrate(r2.code, k.crateUrl).expect(200)).body.freed).toBe(2);
    await api.scanBottle(r2.code, b.url).expect(200);
    expect(await reuseOf(b.id)).toBe(2);
    const sorted = await t.prisma.bottleEvent.findMany({
      where: { bottleId: b.id, type: 'SORTED' },
      orderBy: { id: 'asc' },
    });
    expect(sorted.map((e) => e.crateCycleId)).toEqual([k1.id, k2.id]);
    // Both shipments keep their contents.
    const allocations = await t.prisma.orderCrateAllocation.findMany({
      where: { crate: { code: k.crateCode } },
      include: { bottles: true, cycle: { select: { status: true } } },
      orderBy: { allocatedAt: 'asc' },
    });
    expect(
      allocations.map((a) => [a.cycle.status, a.bottles.map((x) => x.bottleId).sort()]),
    ).toEqual([
      ['CLOSED', [b.id, c.id].sort()],
      ['CLOSED', [b.id, c.id].sort()],
    ]);
  });

  it('stock availability: two refills at once with liquid for one bottle — one filled, the other refused, never negative', async () => {
    const first = await washedCrate();
    const station = await factory.openStation({ withLot: false });
    for (const url of first.bottleUrls) {
      expect((await labelScan(t, station.sessionId, url)).body.outcome).toBe('PLACED');
    }
    const lot = (await receiveItem(t, factory.kit.liquidItemId, 330)).lines[0]!.lot!.id;
    const fs = await fillingSession(t, 'HAND_SOAP');
    expect((await fillLoadCrate(t, fs, station.crateUrl)).status).toBe(200);
    expect((await chooseLiquidLot(t, fs, lot)).status).toBe(200);
    const results = await Promise.all(first.bottleUrls.map((url) => fillScan(t, fs, url)));
    const answers = results.map((r) => (r.status === 200 ? 'OK' : r.body.code));
    // Exactly one filled; the other refused because the lot no longer covers a bottle.
    expect(answers.sort()).toEqual(['LOT_EXHAUSTED', 'OK']);
    const onHand = await t.prisma.inventoryBalance.findMany({ where: { lotId: lot } });
    expect(onHand.every((x) => !x.onHand.isNegative())).toBe(true);
    expect(onHand.reduce((sum, x) => sum + Number(x.onHand), 0)).toBe(0);
    // The refused bottle stays washed and placed — nothing half written.
    const statuses = await Promise.all(
      first.bottleIds.map(
        async (id) => (await t.prisma.bottle.findUniqueOrThrow({ where: { id } })).status,
      ),
    );
    expect(statuses.sort()).toEqual(['FILLED', 'READY_FOR_REUSE']);
  });
});
