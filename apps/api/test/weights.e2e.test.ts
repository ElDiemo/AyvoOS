import { randomUUID } from 'node:crypto';
import type {
  CrateTypeMeasurements,
  CrateWeightSnapshot,
  ItemWeights,
  ProductWeights,
} from '@ayvo/types';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { crateFactory } from './support/order-fixtures.js';
import { createTestApp, hasDatabase, type TestApp } from './support/test-app.js';
import { drift } from './support/warehouse-fixtures.js';

type Factory = Awaited<ReturnType<typeof crateFactory>>;

/**
 * Weights and dimensions (doc 025 §10, PR W1) through the API and the real database: exact grams,
 * unknown never 0, the liquid as a weighed sample (330 ml is not 330 g), the expected crate from
 * the finished-bottle reference + tare only (components are a cross-check, never added twice),
 * packaging added only when not in the tare, corrections keep history, Hotovo keeps a snapshot
 * that later measurements never change and that never blocks it, and stock never moves.
 * Synthetic values only.
 */
describe.skipIf(!hasDatabase)('weights and dimensions (W1)', () => {
  let t: TestApp;
  let f: Factory;
  let codes: { label: string; liquid: string; pump: string };
  const http = () => request(t.app.getHttpServer());
  const base = (extra: Record<string, unknown> = {}) => ({
    requestId: randomUUID(),
    measuredOn: '2026-10-15',
    method: 'Kuchyňská váha 0,1 g, průměr z 5 kusů',
    correctionOf: null,
    correctionReason: null,
    ...extra,
  });
  const ledger = async () => ({
    movements: await t.prisma.inventoryMovement.count(),
    balances: (await t.prisma.inventoryBalance.findMany({ orderBy: { id: 'asc' } })).map((b) =>
      b.onHand.toString(),
    ),
    units: (await t.prisma.inventoryItem.findMany({ orderBy: { id: 'asc' } })).map(
      (i) => i.baseUnitId,
    ),
  });
  const product = async () =>
    (await http().get(`/api/admin/catalog/products/${f.kit.productCode}/weights`).expect(200))
      .body as ProductWeights;

  beforeAll(async () => {
    t = await createTestApp();
    f = await crateFactory(t, { capacity: 2 });
    const code = async (id: string) =>
      (await t.prisma.inventoryItem.findUniqueOrThrow({ where: { id } })).code;
    codes = {
      label: await code(f.kit.labelItemId),
      liquid: await code(f.kit.liquidItemId),
      pump: await code(f.kit.pumpItemId),
    };
  });
  afterAll(async () => {
    if (t) expect(await drift(t)).toEqual([]);
    await t?.close();
  });

  it('a crate finished before anything is measured keeps an all-unknown snapshot (Hotovo not blocked)', async () => {
    const crate = await f.make(); // Hotovo succeeds without any reference
    const snaps = (await http().get(`/api/admin/crates/${crate.crateCode}/weights`).expect(200))
      .body as CrateWeightSnapshot[];
    expect(snaps).toHaveLength(1);
    expect(snaps[0]).toMatchObject({
      bottles: 2,
      bottleG: null,
      tareG: null,
      packaging: 'NOT_RECORDED',
      expectedCrateG: null,
      expectedPackageG: null,
    });
    const p = await product();
    expect(p.current).toBeNull();
    expect(p.expectation).toMatchObject({
      recipeVersion: 1,
      crateType: { capacity: 2 },
      bottleG: null,
      tareG: null,
      expectedCrateG: null, // unknown, never 0
      expectedPackageG: null,
      missing: ['BOTTLE', 'TARE', 'PACKAGE'],
      components: { sumG: null },
    });
    expect(p.expectation.components.unknown.length).toBeGreaterThan(0);
  });

  it('records components per unit and the liquid as a weighed sample; validates the mode', async () => {
    const before = await ledger();
    const label = await http()
      .post(`/api/admin/catalog/components/${codes.label}/weights`)
      .send(base({ massG: '0.512', sampleVolume: null }))
      .expect(201);
    expect(label.body as ItemWeights).toMatchObject({
      mode: 'PER_UNIT',
      current: { massG: '0.512', sampleVolume: null, measuredOn: '2026-10-15' },
    });
    const withSample = await http()
      .post(`/api/admin/catalog/components/${codes.pump}/weights`)
      .send(base({ massG: '12.3', sampleVolume: '100' }));
    expect([withSample.status, withSample.body.code]).toEqual([422, 'SAMPLE_VOLUME_NOT_ALLOWED']);
    await http()
      .post(`/api/admin/catalog/components/${codes.pump}/weights`)
      .send(base({ massG: '12.3', sampleVolume: null }))
      .expect(201);
    const noSample = await http()
      .post(`/api/admin/catalog/components/${codes.liquid}/weights`)
      .send(base({ massG: '103.4', sampleVolume: null }));
    expect([noSample.status, noSample.body.code]).toEqual([422, 'SAMPLE_VOLUME_REQUIRED']);
    const liquid = await http()
      .post(`/api/admin/catalog/components/${codes.liquid}/weights`)
      .send(base({ massG: '103.4', sampleVolume: '100' }))
      .expect(201);
    expect(liquid.body).toMatchObject({ mode: 'SAMPLE', current: { sampleVolume: '100' } });
    await http()
      .post('/api/admin/catalog/components/NEW_BOTTLE/weights')
      .send(base({ massG: '28.4', sampleVolume: null }))
      .expect(201);
    for (const bad of [{ massG: '0' }, { massG: '-1' }, { massG: '1.2345' }, { massG: '1e3' }]) {
      const r = await http()
        .post(`/api/admin/catalog/components/${codes.label}/weights`)
        .send(base({ sampleVolume: null, ...bad }));
      expect(r.status, JSON.stringify(bad)).toBe(400);
    }
    const future = await http()
      .post(`/api/admin/catalog/components/${codes.label}/weights`)
      .send(base({ massG: '1', sampleVolume: null, measuredOn: '2099-01-01' }));
    expect([future.status, future.body.code]).toEqual([422, 'MEASURED_IN_FUTURE']);
    // Recording weights never touches stock, units or consumption.
    expect(await ledger()).toEqual(before);
  });

  it('expected crate = bottles × finished bottle + tare; components only a cross-check', async () => {
    const before = await ledger();
    // Components summed per bottle (not added): 28.4 + 0.512 + 12.3 + 330 ml × 103.4 g / 100 ml.
    let p = await product();
    const lines = new Map(p.expectation.components.lines.map((l) => [l.item.code, l.massG]));
    expect(lines.get(codes.liquid)).toBe('341.22'); // 330 ml is not 330 g
    expect(lines.get('NEW_BOTTLE')).toBe('28.4');
    expect(p.expectation.components.sumG).toBe('382.432');
    expect(p.expectation.expectedCrateG).toBeNull(); // still no finished-bottle reference

    await http()
      .post(`/api/admin/catalog/products/${f.kit.productCode}/weights`)
      .send(base({ massG: '372.5', bottlesWeighed: 10 }))
      .expect(201);
    const tare = (
      await http()
        .post(`/api/admin/catalog/crate-types/${f.kit.crateTypeCode}/tare`)
        .send(base({ massG: '1850', configuration: 'Bedna s přepážkami 5 × 8' }))
        .expect(201)
    ).body as CrateTypeMeasurements;
    p = await product();
    // 2 × 372.5 + 1850 = 2595 g — the components (382.432 g/bottle) are NOT added on top.
    expect(p.expectation).toMatchObject({
      bottleG: '372.5',
      tareG: '1850',
      expectedCrateG: '2595',
      packaging: { state: 'NOT_RECORDED' },
      expectedPackageG: null,
      missing: ['PACKAGE'],
    });

    // Dimensions of the crate and of the final shipping package (an extra carton, mass unknown).
    await http()
      .post(`/api/admin/catalog/crate-types/${f.kit.crateTypeCode}/dimensions`)
      .send(
        base({
          subject: 'CRATE',
          lengthMm: 600,
          widthMm: 400,
          heightMm: 300,
          extraPackaging: null,
          extraDescription: null,
          extraMassG: null,
          extraInTare: null,
        }),
      )
      .expect(201);
    const carton = (
      await http()
        .post(`/api/admin/catalog/crate-types/${f.kit.crateTypeCode}/dimensions`)
        .send(
          base({
            subject: 'SHIPPING_PACKAGE',
            lengthMm: 620,
            widthMm: 420,
            heightMm: 320,
            extraPackaging: 'CARTON',
            extraDescription: 'Kartonový přebal',
            extraMassG: null,
            extraInTare: false,
          }),
        )
        .expect(201)
    ).body as CrateTypeMeasurements;
    p = await product();
    expect(p.expectation).toMatchObject({
      packaging: { state: 'MASS_UNKNOWN' },
      expectedPackageG: null,
      missing: ['PACKAGE_MASS'],
    });
    // The carton weighed: added on top (not in the tare).
    await http()
      .post(`/api/admin/catalog/crate-types/${f.kit.crateTypeCode}/dimensions`)
      .send(
        base({
          subject: 'SHIPPING_PACKAGE',
          lengthMm: 620,
          widthMm: 420,
          heightMm: 320,
          extraPackaging: 'CARTON',
          extraDescription: 'Kartonový přebal',
          extraMassG: '450.25',
          extraInTare: false,
          correctionOf: carton.package.current!.id,
          correctionReason: 'Karton dovážen',
        }),
      )
      .expect(201);
    p = await product();
    expect(p.expectation).toMatchObject({
      expectedCrateG: '2595',
      packaging: { state: 'ADDED', extraMassG: '450.25' },
      expectedPackageG: '3045.25',
      missing: [],
    });
    // Already in the tare: not added again.
    await http()
      .post(`/api/admin/catalog/crate-types/${f.kit.crateTypeCode}/dimensions`)
      .send(
        base({
          subject: 'SHIPPING_PACKAGE',
          lengthMm: 620,
          widthMm: 420,
          heightMm: 320,
          extraPackaging: 'CARTON',
          extraDescription: 'Karton zvážený spolu s bednou',
          extraMassG: '450.25',
          extraInTare: true,
        }),
      )
      .expect(201);
    p = await product();
    expect(p.expectation).toMatchObject({
      packaging: { state: 'IN_TARE' },
      expectedPackageG: '2595',
    });
    // Extra packaging only on the shipping package; a real one needs its description.
    const wrong = await http()
      .post(`/api/admin/catalog/crate-types/${f.kit.crateTypeCode}/dimensions`)
      .send(
        base({
          subject: 'CRATE',
          lengthMm: 1,
          widthMm: 1,
          heightMm: 1,
          extraPackaging: 'CARTON',
          extraDescription: null,
          extraMassG: null,
          extraInTare: null,
        }),
      );
    expect(wrong.status).toBe(400);
    expect(tare.tare.current).toMatchObject({ configuration: 'Bedna s přepážkami 5 × 8' });
    expect(await ledger()).toEqual(before);
  });

  it('a correction keeps the previous value; Hotovo snapshots never change afterwards', async () => {
    const crate = await f.make();
    let snaps = (await http().get(`/api/admin/crates/${crate.crateCode}/weights`).expect(200))
      .body as CrateWeightSnapshot[];
    expect(snaps[0]).toMatchObject({
      bottles: 2,
      bottleG: '372.5',
      tareG: '1850',
      packaging: 'IN_TARE',
      expectedCrateG: '2595',
      expectedPackageG: '2595',
    });
    // A tare correction: the old row stays, the new one is current.
    const m = (
      await http()
        .get(`/api/admin/catalog/crate-types/${f.kit.crateTypeCode}/measurements`)
        .expect(200)
    ).body as CrateTypeMeasurements;
    const noReason = await http()
      .post(`/api/admin/catalog/crate-types/${f.kit.crateTypeCode}/tare`)
      .send(base({ massG: '1900', configuration: 'x', correctionOf: m.tare.current!.id }));
    expect(noReason.status).toBe(400);
    const corrected = (
      await http()
        .post(`/api/admin/catalog/crate-types/${f.kit.crateTypeCode}/tare`)
        .send(
          base({
            massG: '1900',
            configuration: 'Bedna s přepážkami 5 × 8',
            correctionOf: m.tare.current!.id,
            correctionReason: 'Váha nebyla vynulovaná',
          }),
        )
        .expect(201)
    ).body as CrateTypeMeasurements;
    expect(corrected.tare.history.map((h) => h.massG)).toEqual(['1900', '1850']);
    expect(corrected.tare.current).toMatchObject({
      correctionOf: m.tare.current!.id,
      correctionReason: 'Váha nebyla vynulovaná',
    });
    await http()
      .post(`/api/admin/catalog/products/${f.kit.productCode}/weights`)
      .send(base({ massG: '375', bottlesWeighed: 20 }))
      .expect(201);
    // The crate finished earlier keeps what was known at its Hotovo.
    snaps = (await http().get(`/api/admin/crates/${crate.crateCode}/weights`).expect(200)).body;
    expect(snaps[0]).toMatchObject({ bottleG: '372.5', tareG: '1850', expectedCrateG: '2595' });
    // A new crate uses the new references: 2 × 375 + 1900.
    const next = await f.make();
    const fresh = (await http().get(`/api/admin/crates/${next.crateCode}/weights`).expect(200))
      .body as CrateWeightSnapshot[];
    expect(fresh[0]).toMatchObject({ bottleG: '375', tareG: '1900', expectedCrateG: '2650' });
    // A correction of another crate type's record is refused.
    const other = await crateFactory(t, { capacity: 2 });
    const foreign = await http()
      .post(`/api/admin/catalog/crate-types/${other.kit.crateTypeCode}/tare`)
      .send(
        base({
          massG: '1',
          configuration: 'x',
          correctionOf: m.tare.current!.id,
          correctionReason: 'omyl',
        }),
      );
    expect([foreign.status, foreign.body.code]).toEqual([422, 'CORRECTION_TARGET_INVALID']);
  });

  it('the database keeps every record immutable and refuses inconsistent rows', async () => {
    const row = await t.prisma.crateTypeTareWeight.findFirstOrThrow();
    await expect(
      t.prisma.crateTypeTareWeight.update({ where: { id: row.id }, data: { massG: '1' } }),
    ).rejects.toThrow();
    await expect(t.prisma.crateTypeTareWeight.delete({ where: { id: row.id } })).rejects.toThrow();
    const snap = await t.prisma.crateCycleWeightSnapshot.findFirstOrThrow();
    await expect(
      t.prisma.crateCycleWeightSnapshot.update({
        where: { id: snap.id },
        data: { expectedCrateG: '1' },
      }),
    ).rejects.toThrow();
    // A liquid without a sample volume, straight into the database.
    const op = randomUUID();
    await t.prisma.operationRequest.create({
      data: { requestId: op, kind: 'MEASUREMENT_RECORD', payloadSha256: '0'.repeat(64) },
    });
    const admin = await t.prisma.user.findFirstOrThrow();
    await expect(
      t.prisma.itemReferenceWeight.create({
        data: {
          itemId: f.kit.liquidItemId,
          massG: '100',
          measuredOn: new Date('2026-10-15T00:00:00Z'),
          method: 'x',
          recordedBy: admin.id,
          operationRequestId: op,
        },
      }),
    ).rejects.toThrow(/volume item a weighed sample/);
  });

  it('a replayed request records nothing twice', async () => {
    const body = base({ massG: '0.6', sampleVolume: null });
    const count = () =>
      t.prisma.itemReferenceWeight.count({ where: { itemId: f.kit.labelItemId } });
    const before = await count();
    await http()
      .post(`/api/admin/catalog/components/${codes.label}/weights`)
      .send(body)
      .expect(201);
    await http()
      .post(`/api/admin/catalog/components/${codes.label}/weights`)
      .send(body)
      .expect(201);
    expect(await count()).toBe(before + 1);
  });
});
