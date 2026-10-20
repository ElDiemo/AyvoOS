import type {
  CrateDimension,
  CrateExpectation,
  CrateTypeMeasurements,
  CrateWeightSnapshot,
  ItemWeight,
  ItemWeights,
  PackagingState,
  ProductWeight,
  ProductWeights,
  RecordDimensionsRequest,
  RecordItemWeightRequest,
  RecordProductWeightRequest,
  RecordTareRequest,
  TareWeight,
} from '@ayvo/types';
import { Injectable, NotFoundException } from '@nestjs/common';
import { domainError } from '../common/domain-error.js';
import { CrateTypesService } from '../crates/crate-types.service.js';
import { OperationRequestsService } from '../database/operation-requests.service.js';
import { PrismaService } from '../database/prisma.service.js';
import { Prisma } from '../generated/prisma/client.js';
import { InventoryService } from '../inventory/inventory.service.js';
import { RecipesService } from './recipes.service.js';

const Decimal = Prisma.Decimal;
type Decimal = Prisma.Decimal;

/**
 * Kinds that carry a reference weight (doc 025 §10): bottle body, pump, label, liquid and — owner
 * 2026-10-17 — packaging (a counted packaging item such as a shipping carton).
 */
const WEIGHED_KINDS = new Set(['NEW_BOTTLE', 'PUMP', 'LABEL_MEDIA', 'BULK_LIQUID', 'PACKAGING']);
const byRecorded = [{ recordedAt: 'desc' as const }, { id: 'desc' as const }];
const recorder = { recorder: { select: { displayName: true } } };

/** Exact grams as a plain decimal string (no exponent, trailing zeros trimmed). */
export function grams(value: Decimal): string {
  return value.toFixed(3).replace(/\.?0+$/, '');
}

/** A derived mass rounded to 0.001 g (half up) — only where a division is involved. */
function roundG(value: Decimal): Decimal {
  return value.toDecimalPlaces(3, Decimal.ROUND_HALF_UP);
}

const dateOnly = (d: Date) => d.toISOString().slice(0, 10);

function meta(row: {
  id: string;
  measuredOn: Date;
  method: string;
  recordedAt: Date;
  recorder: { displayName: string };
  correctionOfId: string | null;
  correctionReason: string | null;
}) {
  return {
    id: row.id,
    measuredOn: dateOnly(row.measuredOn),
    method: row.method,
    recordedAt: row.recordedAt.toISOString(),
    recordedBy: row.recorder.displayName,
    correctionOf: row.correctionOfId,
    correctionReason: row.correctionReason,
  };
}

type PackageRow = {
  extraPackaging: string | null;
  extraMassG: Decimal | null;
  extraItemId: string | null;
  extraInTare: boolean | null;
  extraDescription: string | null;
};

/** The references in force at one moment: the latest of each recorded at or before it. */
type References = {
  bottle: { id: string; massG: Decimal } | null;
  tare: { id: string; massG: Decimal } | null;
  pkg: (PackageRow & { id: string }) | null;
  /** The weight of the package's packaging item, when it is a catalogue item. */
  pkgItem: { id: string; massG: Decimal } | null;
};

/**
 * Weights and dimensions (doc 025 §10, PR W1): measured references of components, finished
 * bottles (per recipe version) and crate types, kept append-only (a correction is a new row; the
 * latest row is the current value). Unknown = no row, never 0, never an estimate. Expected crate
 * weights are references, not weighings. Nothing here touches stock, units, consumption or
 * production states; a missing value never blocks production or Hotovo.
 */
@Injectable()
export class WeightsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly operations: OperationRequestsService,
    private readonly inventory: InventoryService,
    private readonly recipes: RecipesService,
    private readonly crateTypes: CrateTypesService,
  ) {}

  // --- components -----------------------------------------------------------------------------

  async itemWeights(code: string): Promise<ItemWeights> {
    const item = await this.inventory.findItemByCode(code);
    if (!item) throw new NotFoundException('Component not found');
    const rows = await this.prisma.itemReferenceWeight.findMany({
      where: { itemId: item.id },
      include: recorder,
      orderBy: byRecorded,
    });
    const history = rows.map(toItemWeight);
    return {
      item: {
        code: item.code,
        name: item.name,
        kind: item.kind,
        unit: { code: item.baseUnit.code, dimension: item.baseUnit.dimension },
      },
      mode: !WEIGHED_KINDS.has(item.kind)
        ? 'NOT_APPLICABLE'
        : item.baseUnit.dimension === 'COUNT'
          ? 'PER_UNIT'
          : item.baseUnit.dimension === 'VOLUME' && item.kind === 'BULK_LIQUID'
            ? 'SAMPLE'
            : 'NOT_APPLICABLE',
      current: history[0] ?? null,
      history,
    };
  }

  async recordItemWeight(
    actorId: string,
    code: string,
    input: RecordItemWeightRequest,
  ): Promise<ItemWeights> {
    await this.operations.run(
      'MEASUREMENT_RECORD',
      input.requestId,
      { actorId, record: 'item', code, ...input, requestId: undefined },
      async (tx) => {
        const item = await this.inventory.findItemByCode(code, tx);
        if (!item) throw new NotFoundException('Component not found');
        const dim = item.baseUnit.dimension;
        if (!WEIGHED_KINDS.has(item.kind) || dim === 'MASS') {
          throw domainError(422, 'WEIGHT_NOT_APPLICABLE', 'No reference weight for this item');
        }
        if ((dim === 'VOLUME') !== (input.sampleVolume !== null)) {
          throw domainError(
            422,
            dim === 'VOLUME' ? 'SAMPLE_VOLUME_REQUIRED' : 'SAMPLE_VOLUME_NOT_ALLOWED',
            'A liquid is weighed as a sample of a stated volume; a counted item per unit',
          );
        }
        await this.assertCorrection(tx, 'item', input.correctionOf, { itemId: item.id });
        assertNotFuture(input.measuredOn);
        await tx.itemReferenceWeight.create({
          data: {
            itemId: item.id,
            massG: input.massG,
            sampleVolume: input.sampleVolume,
            measuredOn: new Date(`${input.measuredOn}T00:00:00Z`),
            method: input.method,
            correctionOfId: input.correctionOf,
            correctionReason: input.correctionReason,
            recordedBy: actorId,
            operationRequestId: input.requestId,
          },
        });
        return { code };
      },
    );
    return this.itemWeights(code);
  }

  // --- products (per recipe version) ----------------------------------------------------------

  async productWeights(code: string): Promise<ProductWeights> {
    const product = await this.prisma.product.findUnique({
      where: { code },
      select: { id: true, code: true, name: true },
    });
    if (!product) throw new NotFoundException('Product not found');
    const [rows, versions, active] = await Promise.all([
      this.prisma.productReferenceWeight.findMany({
        where: { productId: product.id },
        include: { ...recorder, recipeVersion: { select: { version: true } } },
        orderBy: byRecorded,
      }),
      this.prisma.recipeVersion.findMany({
        where: { productId: product.id, status: { in: ['ACTIVE', 'ARCHIVED'] } },
        select: { version: true, status: true },
        orderBy: { version: 'desc' },
      }),
      this.recipes.activeVersion(this.prisma, product.id),
    ]);
    const history = rows.map(toProductWeight);
    // The active version's own reference: a new version without its measurement is unknown.
    const current = active
      ? (history.find((h) => h.recipeVersion === active.version) ?? null)
      : null;
    return {
      product: { code: product.code, name: product.name },
      versions: versions.map((v) => ({
        version: v.version,
        status: v.status as 'ACTIVE' | 'ARCHIVED',
      })),
      current,
      history,
      expectation: await this.expectation(product.id),
    };
  }

  async recordProductWeight(
    actorId: string,
    code: string,
    input: RecordProductWeightRequest,
  ): Promise<ProductWeights> {
    await this.operations.run(
      'MEASUREMENT_RECORD',
      input.requestId,
      { actorId, record: 'product', code, ...input, requestId: undefined },
      async (tx) => {
        const product = await tx.product.findUnique({ where: { code }, select: { id: true } });
        if (!product) throw new NotFoundException('Product not found');
        const version = await tx.recipeVersion.findFirst({
          where: {
            productId: product.id,
            version: input.recipeVersion,
            status: { in: ['ACTIVE', 'ARCHIVED'] },
          },
          select: { id: true },
        });
        if (!version) {
          throw domainError(
            422,
            'RECIPE_VERSION_NOT_PRODUCED',
            'A finished bottle is weighed for a recipe version that was put into production',
          );
        }
        await this.assertCorrection(tx, 'product', input.correctionOf, {
          productId: product.id,
          recipeVersionId: version.id,
        });
        assertNotFuture(input.measuredOn);
        await tx.productReferenceWeight.create({
          data: {
            productId: product.id,
            recipeVersionId: version.id,
            massG: input.massG,
            bottlesWeighed: input.bottlesWeighed,
            measuredOn: new Date(`${input.measuredOn}T00:00:00Z`),
            method: input.method,
            correctionOfId: input.correctionOf,
            correctionReason: input.correctionReason,
            recordedBy: actorId,
            operationRequestId: input.requestId,
          },
        });
        return { code };
      },
    );
    return this.productWeights(code);
  }

  // --- crate types ----------------------------------------------------------------------------

  async crateTypeMeasurements(code: string): Promise<CrateTypeMeasurements> {
    const type = await this.crateTypes.byCode(code);
    if (!type) throw new NotFoundException('Crate type not found');
    const [tares, dims] = await Promise.all([
      this.prisma.crateTypeTareWeight.findMany({
        where: { crateTypeId: type.id },
        include: recorder,
        orderBy: byRecorded,
      }),
      this.prisma.crateTypeDimension.findMany({
        where: { crateTypeId: type.id },
        include: { ...recorder, extraItem: { select: { id: true, code: true, name: true } } },
        orderBy: byRecorded,
      }),
    ]);
    // The current weight of each packaging item named by a package record.
    const itemIds = [...new Set(dims.flatMap((d) => (d.extraItemId ? [d.extraItemId] : [])))];
    const itemWeights = new Map<string, Decimal>();
    for (const id of itemIds) {
      const w = await this.prisma.itemReferenceWeight.findFirst({
        where: { itemId: id },
        orderBy: byRecorded,
      });
      if (w) itemWeights.set(id, w.massG);
    }
    const tare = tares.map(toTare);
    const toDim = (d: (typeof dims)[number]) => toDimension(d, itemWeights);
    const crate = dims.filter((d) => d.subject === 'CRATE').map(toDim);
    const pkg = dims.filter((d) => d.subject === 'SHIPPING_PACKAGE').map(toDim);
    return {
      crateType: { code: type.code, name: type.name, capacity: type.capacity },
      tare: { current: tare[0] ?? null, history: tare },
      crate: { current: crate[0] ?? null, history: crate },
      package: { current: pkg[0] ?? null, history: pkg },
    };
  }

  async recordTare(
    actorId: string,
    code: string,
    input: RecordTareRequest,
  ): Promise<CrateTypeMeasurements> {
    await this.operations.run(
      'MEASUREMENT_RECORD',
      input.requestId,
      { actorId, record: 'tare', code, ...input, requestId: undefined },
      async (tx) => {
        const type = await this.crateTypes.byCode(code, tx);
        if (!type) throw new NotFoundException('Crate type not found');
        await this.assertCorrection(tx, 'tare', input.correctionOf, { crateTypeId: type.id });
        assertNotFuture(input.measuredOn);
        await tx.crateTypeTareWeight.create({
          data: {
            crateTypeId: type.id,
            massG: input.massG,
            configuration: input.configuration,
            measuredOn: new Date(`${input.measuredOn}T00:00:00Z`),
            method: input.method,
            correctionOfId: input.correctionOf,
            correctionReason: input.correctionReason,
            recordedBy: actorId,
            operationRequestId: input.requestId,
          },
        });
        return { code };
      },
    );
    return this.crateTypeMeasurements(code);
  }

  async recordDimensions(
    actorId: string,
    code: string,
    input: RecordDimensionsRequest,
  ): Promise<CrateTypeMeasurements> {
    await this.operations.run(
      'MEASUREMENT_RECORD',
      input.requestId,
      { actorId, record: 'dimensions', code, ...input, requestId: undefined },
      async (tx) => {
        const type = await this.crateTypes.byCode(code, tx);
        if (!type) throw new NotFoundException('Crate type not found');
        let extraItemId: string | null = null;
        if (input.extraItemCode) {
          const item = await this.inventory.findItemByCode(input.extraItemCode, tx);
          if (!item || item.kind !== 'PACKAGING') {
            throw domainError(
              422,
              'NOT_A_PACKAGING_ITEM',
              'The extra packaging is not a packaging item',
            );
          }
          extraItemId = item.id;
        }
        await this.assertCorrection(tx, input.subject, input.correctionOf, {
          crateTypeId: type.id,
        });
        assertNotFuture(input.measuredOn);
        await tx.crateTypeDimension.create({
          data: {
            crateTypeId: type.id,
            subject: input.subject,
            lengthMm: input.lengthMm,
            widthMm: input.widthMm,
            heightMm: input.heightMm,
            extraPackaging: input.extraPackaging,
            extraDescription: input.extraDescription,
            extraMassG: input.extraMassG,
            extraItemId,
            extraInTare: input.extraInTare,
            measuredOn: new Date(`${input.measuredOn}T00:00:00Z`),
            method: input.method,
            correctionOfId: input.correctionOf,
            correctionReason: input.correctionReason,
            recordedBy: actorId,
            operationRequestId: input.requestId,
          },
        });
        return { code };
      },
    );
    return this.crateTypeMeasurements(code);
  }

  // --- expected weights -----------------------------------------------------------------------

  /**
   * All references in force at `at`, chosen in ONE statement (one database snapshot) with the
   * same cut-off for every reference — a measurement recorded concurrently never mixes in for
   * one part while missing for another. The finished bottle is that of the given recipe version.
   */
  private async referencesAt(
    db: Prisma.TransactionClient,
    q: { productId: string; recipeVersionId: string; crateTypeId: string; at: Date },
  ): Promise<References> {
    const [row] = await db.$queryRaw<
      { bottle: string | null; tare: string | null; pkg: string | null; pkg_item: string | null }[]
    >`
      WITH pkg AS (
        SELECT d."id", d."extra_item_id" FROM "crate_type_dimensions" d
         WHERE d."crate_type_id" = ${q.crateTypeId}::uuid AND d."subject" = 'SHIPPING_PACKAGE'
           AND d."recorded_at" <= ${q.at}
         ORDER BY d."recorded_at" DESC, d."id" DESC LIMIT 1)
      SELECT
        (SELECT w."id" FROM "product_reference_weights" w
          WHERE w."product_id" = ${q.productId}::uuid AND w."recipe_version_id" = ${q.recipeVersionId}::uuid
            AND w."recorded_at" <= ${q.at}
          ORDER BY w."recorded_at" DESC, w."id" DESC LIMIT 1) AS bottle,
        (SELECT t."id" FROM "crate_type_tare_weights" t
          WHERE t."crate_type_id" = ${q.crateTypeId}::uuid AND t."recorded_at" <= ${q.at}
          ORDER BY t."recorded_at" DESC, t."id" DESC LIMIT 1) AS tare,
        (SELECT "id" FROM pkg) AS pkg,
        (SELECT i."id" FROM "item_reference_weights" i
          WHERE i."item_id" = (SELECT "extra_item_id" FROM pkg) AND i."recorded_at" <= ${q.at}
          ORDER BY i."recorded_at" DESC, i."id" DESC LIMIT 1) AS pkg_item`;
    // The chosen rows are immutable: reading them afterwards returns exactly what was chosen.
    const [bottle, tare, pkg, pkgItem] = await Promise.all([
      row?.bottle ? db.productReferenceWeight.findUnique({ where: { id: row.bottle } }) : null,
      row?.tare ? db.crateTypeTareWeight.findUnique({ where: { id: row.tare } }) : null,
      row?.pkg ? db.crateTypeDimension.findUnique({ where: { id: row.pkg } }) : null,
      row?.pkg_item ? db.itemReferenceWeight.findUnique({ where: { id: row.pkg_item } }) : null,
    ]);
    return { bottle, tare, pkg, pkgItem };
  }

  /**
   * The expected (reference) weight of one full crate of the product's ACTIVE recipe now:
   * bottles × that version's finished-bottle reference + tare; the shipping package adds extra
   * packaging only when the tare does not include it. Components are a separate cross-check.
   */
  private async expectation(productId: string): Promise<CrateExpectation> {
    const db = this.prisma;
    const recipe = await this.recipes.activeVersion(db, productId);
    const empty: CrateExpectation = {
      recipeVersion: null,
      crateType: null,
      bottleG: null,
      tareG: null,
      expectedCrateG: null,
      packaging: { state: 'NOT_RECORDED', extraMassG: null, description: null },
      expectedPackageG: null,
      missing: ['RECIPE'],
      components: { lines: [], sumG: null, unknown: [] },
    };
    if (!recipe) return empty;
    const crateTypeId = await this.recipes.crateTypeOf(db, recipe.id);
    const type = crateTypeId ? await this.crateTypes.byId(crateTypeId, db) : null;
    if (!type) return { ...empty, recipeVersion: recipe.version };
    const refs = await this.referencesAt(db, {
      productId,
      recipeVersionId: recipe.id,
      crateTypeId: type.id,
      at: new Date(),
    });
    return {
      recipeVersion: recipe.version,
      crateType: { code: type.code, name: type.name, capacity: type.capacity },
      bottleG: refs.bottle ? grams(refs.bottle.massG) : null,
      tareG: refs.tare ? grams(refs.tare.massG) : null,
      ...expectedWeights(type.capacity, refs),
      components: await this.components(db, recipe.id),
    };
  }

  /** Per-bottle component masses of a recipe (both stages) — a cross-check, never added on top. */
  private async components(db: Prisma.TransactionClient, recipeVersionId: string) {
    const lines = [
      ...(await this.recipes.stageBomLines(db, recipeVersionId, 'LABEL_APPLICATION')),
      ...(await this.recipes.stageBomLines(db, recipeVersionId, 'FILL')),
    ];
    const items = await this.inventory.itemsWithUnit({ codes: lines.map((l) => l.item.code) }, db);
    const unitOf = new Map(items.map((i) => [i.id, i.baseUnit] as const));
    const result: CrateExpectation['components']['lines'] = [];
    const unknown: string[] = [];
    let sum: Decimal | null = new Decimal(0);
    for (const line of lines) {
      const unit = unitOf.get(line.itemId)!;
      let mass: Decimal | null = null;
      if (unit.dimension === 'MASS' && unit.code === 'g') {
        mass = new Decimal(line.quantity); // the quantity already is grams
      } else {
        const ref = await db.itemReferenceWeight.findFirst({
          where: { itemId: line.itemId },
          orderBy: byRecorded,
        });
        if (ref && unit.dimension === 'COUNT') mass = ref.massG.mul(line.quantity);
        if (ref && unit.dimension === 'VOLUME' && ref.sampleVolume) {
          // A weighed sample: mass × (bottle volume / sample volume) — never 1 ml = 1 g.
          mass = roundG(ref.massG.mul(line.quantity).div(ref.sampleVolume));
        }
      }
      if (mass === null) unknown.push(line.item.name);
      sum = mass === null || sum === null ? null : sum.add(mass);
      result.push({
        item: { code: line.item.code, name: line.item.name, kind: line.item.kind },
        quantity: grams(new Decimal(line.quantity)),
        unitCode: unit.code,
        massG: mass === null ? null : grams(mass),
      });
    }
    return { lines: result, sumG: sum === null || lines.length === 0 ? null : grams(sum), unknown };
  }

  // --- Hotovo snapshot ------------------------------------------------------------------------

  /**
   * Keeps the references in force at a Hotovo (its CRATE_FILLED event) — every one with the
   * same cut-off, the finished bottle of the cycle's own pinned recipe version — and the expected
   * weights derived from them. Unknown stays null; never blocks Hotovo; later measurements never
   * change it. Runs in the Hotovo transaction.
   */
  async snapshotHotovo(
    tx: Prisma.TransactionClient,
    cycle: {
      id: string;
      productId: string;
      recipeVersionId: string;
      crateTypeId: string;
      capacity: number;
    },
    operationId: string,
    takenAt: Date,
  ): Promise<void> {
    const event = await tx.crateEvent.findFirst({
      where: { cycleId: cycle.id, type: 'CRATE_FILLED', operationRequestId: operationId },
      select: { id: true },
    });
    if (!event) return;
    const refs = await this.referencesAt(tx, {
      productId: cycle.productId,
      recipeVersionId: cycle.recipeVersionId,
      crateTypeId: cycle.crateTypeId,
      at: takenAt,
    });
    const expected = expectedWeights(cycle.capacity, refs);
    await tx.crateCycleWeightSnapshot.create({
      data: {
        cycleId: cycle.id,
        crateEventId: event.id,
        bottles: cycle.capacity,
        productWeightId: refs.bottle?.id ?? null,
        tareWeightId: refs.tare?.id ?? null,
        packageId: refs.pkg?.id ?? null,
        packageItemWeightId: refs.pkgItem?.id ?? null,
        expectedCrateG: expected.expectedCrateG,
        expectedPackageG: expected.expectedPackageG,
        takenAt,
      },
    });
  }

  /**
   * The calculated reference of one dispatched crate (doc 029): its Hotovo snapshot when that
   * knows the finished package, otherwise the references in force at `at` (and labelled so).
   * Never an actual weighing; a historical snapshot is never rewritten.
   */
  async parcelReference(
    tx: Prisma.TransactionClient,
    cycle: {
      id: string;
      productId: string;
      recipeVersionId: string;
      crateTypeId: string;
      capacity: number;
    },
    at: Date,
  ): Promise<{
    massG: Decimal | null;
    source: 'HOTOVO_SNAPSHOT' | 'REFERENCE_AT_SHIPMENT' | null;
    snapshotId: string | null;
    packageDimensionId: string | null;
  }> {
    const snapshot = await tx.crateCycleWeightSnapshot.findFirst({
      where: { cycleId: cycle.id },
      orderBy: [{ takenAt: 'desc' }, { id: 'desc' }],
      select: { id: true, expectedPackageG: true, packageId: true },
    });
    if (snapshot?.expectedPackageG) {
      return {
        massG: snapshot.expectedPackageG,
        source: 'HOTOVO_SNAPSHOT',
        snapshotId: snapshot.id,
        packageDimensionId: snapshot.packageId,
      };
    }
    const refs = await this.referencesAt(tx, {
      productId: cycle.productId,
      recipeVersionId: cycle.recipeVersionId,
      crateTypeId: cycle.crateTypeId,
      at,
    });
    const expected = expectedWeights(cycle.capacity, refs).expectedPackageG;
    return {
      massG: expected ? new Decimal(expected) : null,
      source: expected ? 'REFERENCE_AT_SHIPMENT' : null,
      snapshotId: snapshot?.id ?? null,
      packageDimensionId: snapshot?.packageId ?? refs.pkg?.id ?? null,
    };
  }

  /** The Hotovo snapshots of a crate of the site, newest first. */
  async snapshotsOfCrate(crateId: string): Promise<CrateWeightSnapshot[]> {
    const rows = await this.prisma.crateCycleWeightSnapshot.findMany({
      where: { cycle: { crateId } },
      include: { productWeight: true, tareWeight: true, package: true, packageItemWeight: true },
      orderBy: [{ takenAt: 'desc' }, { id: 'desc' }],
    });
    return rows.map((r) => {
      const packaging = packagingOf(r.package, r.packageItemWeight);
      return {
        takenAt: r.takenAt.toISOString(),
        bottles: r.bottles,
        bottleG: r.productWeight ? grams(r.productWeight.massG) : null,
        bottleMeasuredOn: r.productWeight ? dateOnly(r.productWeight.measuredOn) : null,
        tareG: r.tareWeight ? grams(r.tareWeight.massG) : null,
        tareMeasuredOn: r.tareWeight ? dateOnly(r.tareWeight.measuredOn) : null,
        packaging: packaging.state,
        extraMassG: packaging.extra ? grams(packaging.extra) : null,
        expectedCrateG: r.expectedCrateG ? grams(r.expectedCrateG) : null,
        expectedPackageG: r.expectedPackageG ? grams(r.expectedPackageG) : null,
      };
    });
  }

  private async assertCorrection(
    tx: Prisma.TransactionClient,
    subject: 'item' | 'product' | 'tare' | 'CRATE' | 'SHIPPING_PACKAGE',
    id: string | null,
    owner: { itemId?: string; productId?: string; recipeVersionId?: string; crateTypeId?: string },
  ): Promise<void> {
    if (!id) return;
    const found =
      subject === 'item'
        ? await tx.itemReferenceWeight.count({ where: { id, itemId: owner.itemId } })
        : subject === 'product'
          ? await tx.productReferenceWeight.count({
              where: { id, productId: owner.productId, recipeVersionId: owner.recipeVersionId },
            })
          : subject === 'tare'
            ? await tx.crateTypeTareWeight.count({ where: { id, crateTypeId: owner.crateTypeId } })
            : await tx.crateTypeDimension.count({
                where: { id, crateTypeId: owner.crateTypeId, subject },
              });
    if (found === 0) {
      throw domainError(
        422,
        'CORRECTION_TARGET_INVALID',
        'The corrected record is not of this subject',
      );
    }
  }
}

/**
 * How a shipping package record adds to the crate (doc 025 §10). The extra packaging's mass is
 * either entered on the record or — for a catalogue PACKAGING item — that item's weight; never
 * both (the database refuses it), so the same packaging is added at most once.
 */
export function packagingOf(
  pkg: PackageRow | null,
  itemWeight: { massG: Decimal } | null,
): { state: PackagingState; add: Decimal | null; extra: Decimal | null } {
  if (!pkg) return { state: 'NOT_RECORDED', add: null, extra: null };
  if (pkg.extraPackaging === 'NONE') return { state: 'NONE', add: new Decimal(0), extra: null };
  const extra = pkg.extraItemId ? (itemWeight?.massG ?? null) : pkg.extraMassG;
  if (pkg.extraInTare) return { state: 'IN_TARE', add: new Decimal(0), extra };
  if (extra === null) return { state: 'MASS_UNKNOWN', add: null, extra: null };
  return { state: 'ADDED', add: extra, extra };
}

/**
 * Expected crate = bottles × finished-bottle reference + tare (exact, no rounding); expected
 * package = crate + extra packaging when not in the tare. Any unknown part makes the sum unknown.
 */
export function expectedWeights(
  bottles: number,
  refs: References,
): Pick<CrateExpectation, 'expectedCrateG' | 'packaging' | 'expectedPackageG' | 'missing'> {
  const missing: CrateExpectation['missing'] = [];
  if (!refs.bottle) missing.push('BOTTLE');
  if (!refs.tare) missing.push('TARE');
  const crate =
    refs.bottle && refs.tare ? refs.bottle.massG.mul(bottles).add(refs.tare.massG) : null;
  const packaging = packagingOf(refs.pkg, refs.pkgItem);
  if (packaging.state === 'NOT_RECORDED') missing.push('PACKAGE');
  if (packaging.state === 'MASS_UNKNOWN') missing.push('PACKAGE_MASS');
  const pkgTotal = crate && packaging.add ? crate.add(packaging.add) : null;
  return {
    expectedCrateG: crate ? grams(crate) : null,
    packaging: {
      state: packaging.state,
      extraMassG: packaging.extra ? grams(packaging.extra) : null,
      description: refs.pkg?.extraDescription ?? null,
    },
    expectedPackageG: pkgTotal ? grams(pkgTotal) : null,
    missing,
  };
}

function assertNotFuture(day: string): void {
  const tomorrow = new Date(Date.now() + 86_400_000).toISOString().slice(0, 10);
  if (day > tomorrow) {
    throw domainError(422, 'MEASURED_IN_FUTURE', 'A measurement date cannot be in the future');
  }
}

type WithRecorder = { recorder: { displayName: string } };

function toItemWeight(r: Prisma.ItemReferenceWeightGetPayload<object> & WithRecorder): ItemWeight {
  return {
    ...meta(r),
    massG: grams(r.massG),
    sampleVolume: r.sampleVolume ? grams(r.sampleVolume) : null,
  };
}

function toProductWeight(
  r: Prisma.ProductReferenceWeightGetPayload<object> &
    WithRecorder & { recipeVersion: { version: number } },
): ProductWeight {
  return {
    ...meta(r),
    recipeVersion: r.recipeVersion.version,
    massG: grams(r.massG),
    bottlesWeighed: r.bottlesWeighed,
  };
}

function toTare(r: Prisma.CrateTypeTareWeightGetPayload<object> & WithRecorder): TareWeight {
  return { ...meta(r), massG: grams(r.massG), configuration: r.configuration };
}

function toDimension(
  r: Prisma.CrateTypeDimensionGetPayload<object> &
    WithRecorder & { extraItem: { id: string; code: string; name: string } | null },
  itemWeights: Map<string, Decimal>,
): CrateDimension {
  const itemMass = r.extraItem ? itemWeights.get(r.extraItem.id) : undefined;
  return {
    ...meta(r),
    subject: r.subject,
    lengthMm: r.lengthMm,
    widthMm: r.widthMm,
    heightMm: r.heightMm,
    extraPackaging: r.extraPackaging,
    extraDescription: r.extraDescription,
    extraMassG: r.extraMassG ? grams(r.extraMassG) : null,
    extraItem: r.extraItem
      ? { code: r.extraItem.code, name: r.extraItem.name, massG: itemMass ? grams(itemMass) : null }
      : null,
    extraInTare: r.extraInTare,
  };
}
