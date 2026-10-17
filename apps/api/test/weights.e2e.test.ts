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
      .send(base({ recipeVersion: 1, massG: '372.5', bottlesWeighed: 10 }))
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
          extraItemCode: null,
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
            extraItemCode: null,
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
          extraItemCode: null,
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
          extraItemCode: null,
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
          extraItemCode: null,
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
      .send(base({ recipeVersion: 1, massG: '375', bottlesWeighed: 20 }))
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

  it('Hotovo picks every reference with the same cut-off (one snapshot, no mixing)', async () => {
    const pending = await f.make('READY_TO_FILL');
    const product = await t.prisma.product.findUniqueOrThrow({
      where: { code: f.kit.productCode },
    });
    const recipe = await t.prisma.recipeVersion.findFirstOrThrow({
      where: { productId: product.id, version: 1 },
    });
    const type = await t.prisma.crateType.findUniqueOrThrow({
      where: { code: f.kit.crateTypeCode },
    });
    const admin = await t.prisma.user.findFirstOrThrow();
    // References "recorded after" the Hotovo (a measurement committed concurrently): none of
    // them may be used — neither the bottle nor the tare nor the package.
    const later = new Date(Date.now() + 3_600_000);
    const op = async () => {
      const requestId = randomUUID();
      await t.prisma.operationRequest.create({
        data: { requestId, kind: 'MEASUREMENT_RECORD', payloadSha256: '0'.repeat(64) },
      });
      return requestId;
    };
    const common = {
      measuredOn: new Date('2026-10-15T00:00:00Z'),
      method: 'souběžné měření',
      recordedBy: admin.id,
      recordedAt: later,
    };
    await t.prisma.productReferenceWeight.create({
      data: {
        ...common,
        productId: product.id,
        recipeVersionId: recipe.id,
        massG: '1',
        bottlesWeighed: 1,
        operationRequestId: await op(),
      },
    });
    await t.prisma.crateTypeTareWeight.create({
      data: {
        ...common,
        crateTypeId: type.id,
        massG: '1',
        configuration: 'x',
        operationRequestId: await op(),
      },
    });
    await t.prisma.crateTypeDimension.create({
      data: {
        ...common,
        crateTypeId: type.id,
        subject: 'SHIPPING_PACKAGE',
        lengthMm: 1,
        widthMm: 1,
        heightMm: 1,
        extraPackaging: 'NONE',
        operationRequestId: await op(),
      },
    });
    await f.fillAndFinish(pending);
    const snaps = (await http().get(`/api/admin/crates/${pending.crateCode}/weights`).expect(200))
      .body as CrateWeightSnapshot[];
    // The references in force at Hotovo (from the previous test): 375 g, 1 900 g, carton in tare.
    expect(snaps[0]).toMatchObject({
      bottleG: '375',
      tareG: '1900',
      packaging: 'IN_TARE',
      expectedCrateG: '2650',
      expectedPackageG: '2650',
    });
  });

  it('the finished bottle belongs to a recipe version: a new version is unknown; a pinned crate uses its own', async () => {
    const g = await crateFactory(t, { capacity: 2 });
    await http()
      .post(`/api/admin/catalog/products/${g.kit.productCode}/weights`)
      .send(base({ recipeVersion: 1, massG: '370', bottlesWeighed: 5 }))
      .expect(201);
    await http()
      .post(`/api/admin/catalog/crate-types/${g.kit.crateTypeCode}/tare`)
      .send(base({ massG: '1000', configuration: 'S přepážkami' }))
      .expect(201);
    const pinned = await g.make('READY_TO_FILL'); // labelled under V1
    const code = async (id: string) =>
      (await t.prisma.inventoryItem.findUniqueOrThrow({ where: { id } })).code;
    await http()
      .post(`/api/admin/catalog/products/${g.kit.productCode}/recipes`)
      .send({
        requestId: randomUUID(),
        reason: 'nová verze receptury',
        crateTypeCode: g.kit.crateTypeCode,
        components: [
          { itemCode: 'NEW_BOTTLE', quantity: '1', unitCode: 'pcs' },
          { itemCode: g.kit.labelItemCode, quantity: '1', unitCode: 'pcs' },
          { itemCode: await code(g.kit.liquidItemId), quantity: '300', unitCode: 'ml' },
          { itemCode: await code(g.kit.pumpItemId), quantity: '1', unitCode: 'pcs' },
        ],
      })
      .expect(201);
    await http()
      .post(`/api/admin/catalog/products/${g.kit.productCode}/recipes/2/activate`)
      .send({ requestId: randomUUID(), reason: 'V2 schválena', expectedActiveVersion: 1 })
      .expect(200);
    let p = (
      await http().get(`/api/admin/catalog/products/${g.kit.productCode}/weights`).expect(200)
    ).body as ProductWeights;
    expect(p.current).toBeNull(); // V2 not measured yet: unknown, not V1's value
    expect(p.expectation).toMatchObject({ recipeVersion: 2, bottleG: null, expectedCrateG: null });
    expect(p.history.map((h) => h.recipeVersion)).toEqual([1]);
    expect(p.versions.map((v) => [v.version, v.status])).toEqual([
      [2, 'ACTIVE'],
      [1, 'ARCHIVED'],
    ]);
    // The crate pinned to V1 finishes now and uses V1's bottle (Hotovo is never blocked).
    await g.fillAndFinish(pinned);
    const snaps = (await http().get(`/api/admin/crates/${pinned.crateCode}/weights`).expect(200))
      .body as CrateWeightSnapshot[];
    expect(snaps[0]).toMatchObject({ bottleG: '370', expectedCrateG: '1740' });
    // A V2 crate finishing without a V2 measurement: unknown, Hotovo still succeeds.
    const fresh = await g.make();
    const v2 = (await http().get(`/api/admin/crates/${fresh.crateCode}/weights`).expect(200))
      .body as CrateWeightSnapshot[];
    expect(v2[0]).toMatchObject({ bottleG: null, expectedCrateG: null, tareG: '1000' });
    // V2 measured: becomes current; a draft or unknown version is refused.
    await http()
      .post(`/api/admin/catalog/products/${g.kit.productCode}/weights`)
      .send(base({ recipeVersion: 2, massG: '345', bottlesWeighed: 5 }))
      .expect(201);
    p = (await http().get(`/api/admin/catalog/products/${g.kit.productCode}/weights`).expect(200))
      .body;
    expect(p.current).toMatchObject({ recipeVersion: 2, massG: '345' });
    expect(p.expectation.expectedCrateG).toBe('1690');
    const unknownVersion = await http()
      .post(`/api/admin/catalog/products/${g.kit.productCode}/weights`)
      .send(base({ recipeVersion: 9, massG: '1', bottlesWeighed: 1 }));
    expect([unknownVersion.status, unknownVersion.body.code]).toEqual([
      422,
      'RECIPE_VERSION_NOT_PRODUCED',
    ]);
  });

  it('large references never block Hotovo: sums have a wider range than one measurement', async () => {
    const h = await crateFactory(t, { capacity: 2 });
    await http()
      .post(`/api/admin/catalog/products/${h.kit.productCode}/weights`)
      .send(base({ recipeVersion: 1, massG: '999999999.999', bottlesWeighed: 1 }))
      .expect(201);
    await http()
      .post(`/api/admin/catalog/crate-types/${h.kit.crateTypeCode}/tare`)
      .send(base({ massG: '999999999.999', configuration: 'mezní hodnota' }))
      .expect(201);
    const crate = await h.make(); // Hotovo succeeds
    const snaps = (await http().get(`/api/admin/crates/${crate.crateCode}/weights`).expect(200))
      .body as CrateWeightSnapshot[];
    expect(snaps[0]!.expectedCrateG).toBe('2999999999.997'); // beyond DECIMAL(12,3), exact
  });

  it('packaging items have weights; a packaging item is never added twice', async () => {
    const k = await crateFactory(t, { capacity: 2 });
    const carton = (
      await http()
        .post('/api/admin/catalog/components')
        .send({
          requestId: randomUUID(),
          reason: 'přepravní karton',
          packageCapacity: null,
          kind: 'PACKAGING',
          code: `KRT-${randomUUID().slice(0, 6).toUpperCase()}`,
          name: 'Přepravní karton',
          unitCode: 'pcs',
          lotTracked: false,
          categoryCode: null,
        })
        .expect(201)
    ).body as { code: string };
    const item = (
      await http()
        .post(`/api/admin/catalog/components/${carton.code}/weights`)
        .send(base({ massG: '450.5', sampleVolume: null }))
        .expect(201)
    ).body as ItemWeights;
    expect(item).toMatchObject({ mode: 'PER_UNIT', current: { massG: '450.5' } });
    await http()
      .post(`/api/admin/catalog/products/${k.kit.productCode}/weights`)
      .send(base({ recipeVersion: 1, massG: '400', bottlesWeighed: 3 }))
      .expect(201);
    await http()
      .post(`/api/admin/catalog/crate-types/${k.kit.crateTypeCode}/tare`)
      .send(base({ massG: '1000', configuration: 'bez kartonu' }))
      .expect(201);
    const pkg = (extra: Record<string, unknown>) =>
      http()
        .post(`/api/admin/catalog/crate-types/${k.kit.crateTypeCode}/dimensions`)
        .send(
          base({
            subject: 'SHIPPING_PACKAGE',
            lengthMm: 620,
            widthMm: 420,
            heightMm: 320,
            extraPackaging: 'CARTON',
            extraDescription: 'Katalogový karton',
            extraMassG: null,
            extraItemCode: carton.code,
            extraInTare: false,
            ...extra,
          }),
        );
    // The item's own weight AND a mass entered here would count the same carton twice.
    expect((await pkg({ extraMassG: '450.5' })).status).toBe(400);
    const m = (await pkg({}).expect(201)).body as CrateTypeMeasurements;
    expect(m.package.current!.extraItem).toEqual({
      code: carton.code,
      name: 'Přepravní karton',
      massG: '450.5',
    });
    let p = (
      await http().get(`/api/admin/catalog/products/${k.kit.productCode}/weights`).expect(200)
    ).body as ProductWeights;
    // 2 × 400 + 1 000 = 1 800; + the carton once = 2 250.5.
    expect(p.expectation).toMatchObject({
      expectedCrateG: '1800',
      packaging: { state: 'ADDED', extraMassG: '450.5' },
      expectedPackageG: '2250.5',
    });
    // In the tare: not added at all.
    await pkg({ extraInTare: true }).expect(201);
    p = (await http().get(`/api/admin/catalog/products/${k.kit.productCode}/weights`).expect(200))
      .body;
    expect(p.expectation).toMatchObject({
      packaging: { state: 'IN_TARE' },
      expectedPackageG: '1800',
    });
    const notPackaging = await pkg({ extraItemCode: 'NEW_BOTTLE', extraInTare: false });
    expect([notPackaging.status, notPackaging.body.code]).toEqual([422, 'NOT_A_PACKAGING_ITEM']);
  });
});
