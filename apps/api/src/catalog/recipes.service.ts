import {
  RECIPE_STAGE_OF_KIND,
  REQUIRED_RECIPE_KINDS,
  type ActivateRecipeRequest,
  type ArchiveRecipeRequest,
  type CreateRecipeDraftRequest,
  type MaterialRequirements,
  type RecipeComponent,
  type RecipeComponentKind,
  type RecipeStage,
  type RecipeVersion,
  type UpdateRecipeDraftRequest,
} from '@ayvo/types';
import { Injectable, NotFoundException } from '@nestjs/common';
import { AuditService } from '../audit/audit.service.js';
import { domainError } from '../common/domain-error.js';
import { assertUnitScale, formatQuantity, quantity } from '../common/quantity.js';
import { canonicalJson, OperationRequestsService } from '../database/operation-requests.service.js';
import { PrismaService } from '../database/prisma.service.js';
import {
  toCrateType,
  CrateTypesService,
  type CrateTypeRecord,
} from '../crates/crate-types.service.js';
import type { Prisma } from '../generated/prisma/client.js';
import { InventoryService } from '../inventory/inventory.service.js';
import { CatalogService, productArchived, toUnit, unitAllowedFor } from './catalog.service.js';
import { materialRequirements, RequirementTooLargeError } from './material-requirements.js';

const recipeInclude = {
  product: { include: { category: true } },
  basedOn: { select: { version: true } },
  revisions: { orderBy: { revision: 'desc' as const }, take: 1, include: { boms: true } },
} satisfies Prisma.RecipeVersionInclude;
type RecipeRow = Prisma.RecipeVersionGetPayload<{ include: typeof recipeInclude }>;
type BomWithLines = Awaited<ReturnType<InventoryService['bomsWithLines']>>[number];
/** A recipe version row with its current content, read through inventory and crates. */
type RecipeRecord = RecipeRow & { view: RecipeVersion };

/** Display and calculation order of the lines of one finished bottle. */
const KIND_ORDER: readonly string[] = REQUIRED_RECIPE_KINDS;
const STAGE_CODE: Record<RecipeStage, string> = { LABEL_APPLICATION: 'LA', FILL: 'FL' };

/** Validated content of one recipe revision. */
interface RecipeContent {
  crateTypeId: string | null;
  crateTypeCode: string | null;
  lines: {
    itemId: string;
    itemCode: string;
    unitId: string;
    unitCode: string;
    kind: RecipeComponentKind;
    quantity: Prisma.Decimal;
  }[];
}

type ProductRow = { id: string; code: string; category_code: string; status: string };

function toRecipe(
  r: RecipeRow,
  boms: readonly BomWithLines[],
  crate: CrateTypeRecord | null,
): RecipeVersion {
  const revision = r.revisions[0];
  const components: RecipeComponent[] = boms
    .flatMap((b) =>
      b.lines.map((l) => ({
        stage: b.stage as RecipeStage,
        itemCode: l.item.code,
        itemName: l.item.name,
        kind: l.item.kind as RecipeComponent['kind'],
        quantity: formatQuantity(l.quantity),
        unit: toUnit(l.item.baseUnit),
      })),
    )
    .sort((a, b) => KIND_ORDER.indexOf(a.kind) - KIND_ORDER.indexOf(b.kind));
  const crateType = crate ? toCrateType(crate) : null;
  return {
    product: {
      code: r.product.code,
      name: r.product.name,
      category: { code: r.product.category.code, name: r.product.category.name },
    },
    version: r.version,
    status: r.status,
    revision: revision?.revision ?? 1,
    basedOnVersion: r.basedOn?.version ?? null,
    createdAt: r.createdAt.toISOString(),
    activatedAt: r.activatedAt?.toISOString() ?? null,
    archivedAt: r.archivedAt?.toISOString() ?? null,
    crateType,
    components,
    missing: [
      ...REQUIRED_RECIPE_KINDS.filter((k) => !components.some((c) => c.kind === k)),
      ...(crateType ? [] : (['CRATE_TYPE'] as const)),
    ],
  };
}

/** The comparable content of a recipe (NO_CHANGES and the audit's before/after). */
const contentOf = (r: RecipeVersion) => ({
  crateType: r.crateType?.code ?? null,
  components: r.components
    .map((c) => ({ item: c.itemCode, quantity: c.quantity, unit: c.unit.code }))
    .sort((a, b) => a.item.localeCompare(b.item)),
});

const notDraft = (r: { version: number; status: string }) =>
  domainError(
    409,
    'RECIPE_NOT_DRAFT',
    `Version ${r.version} is ${r.status}: only a draft changes — create a new version instead`,
  );

/**
 * Versioned product recipes (doc 023 §4) — the bill of materials of ONE finished bottle, stored
 * as recipe-owned, immutable BOM versions per stage (doc 020 §3.3: no second component table).
 *
 * A version starts as a DRAFT; editing a draft appends a revision (history is kept); activation
 * freezes it. Only a complete, valid draft is activated; at most one version per product is
 * ACTIVE; an ACTIVE or ARCHIVED version never changes (a change is a new version). Archiving only
 * moves the status: lines, BOMs and every reference stay readable.
 *
 * Lock order (every operation): operation request → product row → recipe version row(s). The
 * product lock serialises all version changes of one product, so two concurrent activations can
 * never both succeed; the database enforces the same rules again (doc 023 §6).
 */
@Injectable()
export class RecipesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly operations: OperationRequestsService,
    private readonly audit: AuditService,
    private readonly inventory: InventoryService,
    private readonly catalog: CatalogService,
    private readonly crateTypes: CrateTypesService,
  ) {}

  async get(productCode: string, version: number): Promise<RecipeVersion> {
    return (await this.load(this.prisma, productCode, version)).view;
  }

  /** Material needed for `bottles` finished bottles of a complete version (doc 023 §5). */
  async requirements(
    productCode: string,
    version: number,
    bottles: number,
  ): Promise<MaterialRequirements> {
    const recipe = await this.get(productCode, version);
    if (recipe.missing.length > 0 || !recipe.crateType) {
      throw domainError(
        422,
        'RECIPE_INCOMPLETE',
        `Version ${version} is incomplete (missing: ${recipe.missing.join(', ')})`,
      );
    }
    try {
      return {
        product: recipe.product,
        version: recipe.version,
        status: recipe.status,
        ...materialRequirements({
          components: recipe.components,
          crateType: recipe.crateType,
          bottles,
        }),
      };
    } catch (error) {
      if (error instanceof RequirementTooLargeError) {
        throw domainError(422, 'QUANTITY_TOO_LARGE', 'The result exceeds an exact quantity');
      }
      throw error;
    }
  }

  /** A new DRAFT: with its content, or as a copy of an existing version ("new version"). */
  async createDraft(
    actorId: string,
    productCode: string,
    input: CreateRecipeDraftRequest,
  ): Promise<RecipeVersion> {
    const { result } = await this.operations.run(
      'RECIPE_DRAFT_CREATE',
      input.requestId,
      { actorId, productCode, ...input },
      async (tx) => {
        const product = await this.lockProduct(tx, productCode);
        if (product.status !== 'ACTIVE') throw productArchived();
        let basedOn: RecipeRecord | null = null;
        let wanted: UpdateRecipeDraftRequest['components'];
        let crateTypeCode: string | null;
        if ('basedOnVersion' in input) {
          basedOn = await this.find(tx, product.id, input.basedOnVersion);
          if (!basedOn) {
            throw domainError(422, 'UNKNOWN_BASE_VERSION', 'The version to copy does not exist');
          }
          const base = basedOn.view;
          crateTypeCode = base.crateType?.code ?? null;
          wanted = base.components.map((c) => ({
            itemCode: c.itemCode,
            quantity: c.quantity,
            unitCode: c.unit.code,
          }));
        } else {
          crateTypeCode = input.crateTypeCode;
          wanted = input.components;
        }
        const content = await this.validate(tx, product, crateTypeCode, wanted);
        const last = await tx.recipeVersion.findFirst({
          where: { productId: product.id },
          orderBy: { version: 'desc' },
          select: { version: true },
        });
        const version = (last?.version ?? 0) + 1;
        if (version > 9999) {
          throw domainError(422, 'TOO_MANY_VERSIONS', 'A product has at most 9999 versions');
        }
        const created = await tx.recipeVersion.create({
          data: {
            productId: product.id,
            categoryCode: product.category_code,
            version,
            basedOnId: basedOn?.id ?? null,
            createdBy: actorId,
            operationRequestId: input.requestId,
          },
        });
        await this.writeRevision(
          tx,
          product,
          created.id,
          version,
          1,
          content,
          actorId,
          input.requestId,
        );
        const recipe = (await this.load(tx, productCode, version)).view;
        await this.audit.record(
          {
            type: 'RECIPE_DRAFT_CREATED',
            actorUserId: actorId,
            reason: input.reason,
            payload: {
              product: productCode,
              version,
              basedOnVersion: basedOn?.version ?? null,
              content: contentOf(recipe),
              requestId: input.requestId,
            },
          },
          tx,
        );
        return recipe;
      },
    );
    return result;
  }

  /** Replaces a DRAFT's content by appending its next revision. */
  async updateDraft(
    actorId: string,
    productCode: string,
    version: number,
    input: UpdateRecipeDraftRequest,
  ): Promise<RecipeVersion> {
    const { result } = await this.operations.run(
      'RECIPE_DRAFT_UPDATE',
      input.requestId,
      { actorId, productCode, version, ...input },
      async (tx) => {
        const product = await this.lockProduct(tx, productCode);
        if (product.status !== 'ACTIVE') throw productArchived();
        const current = await this.lockVersion(tx, product, version);
        if (current.status !== 'DRAFT') throw notDraft(current);
        const before = current.view;
        const content = await this.validate(tx, product, input.crateTypeCode, input.components);
        const after = {
          crateType: content.crateTypeCode,
          components: content.lines
            .map((l) => ({
              item: l.itemCode,
              quantity: formatQuantity(l.quantity),
              unit: l.unitCode,
            }))
            .sort((a, b) => a.item.localeCompare(b.item)),
        };
        if (canonicalJson(after) === canonicalJson(contentOf(before))) {
          throw domainError(422, 'NO_CHANGES', 'The draft already has exactly this content');
        }
        const revision = before.revision + 1;
        await this.writeRevision(
          tx,
          product,
          current.id,
          version,
          revision,
          content,
          actorId,
          input.requestId,
        );
        const recipe = (await this.load(tx, productCode, version)).view;
        await this.audit.record(
          {
            type: 'RECIPE_DRAFT_UPDATED',
            actorUserId: actorId,
            reason: input.reason,
            payload: {
              product: productCode,
              version,
              revision,
              before: contentOf(before),
              after: contentOf(recipe),
              requestId: input.requestId,
            },
          },
          tx,
        );
        return recipe;
      },
    );
    return result;
  }

  /**
   * Activates a complete DRAFT. The version the client expects to be active must still be the
   * active one (ACTIVE_VERSION_CHANGED otherwise); it is archived in the same transaction.
   */
  async activate(
    actorId: string,
    productCode: string,
    version: number,
    input: ActivateRecipeRequest,
  ): Promise<RecipeVersion> {
    const { result } = await this.operations.run(
      'RECIPE_ACTIVATE',
      input.requestId,
      { actorId, productCode, version, ...input },
      async (tx) => {
        const product = await this.lockProduct(tx, productCode);
        if (product.status !== 'ACTIVE') throw productArchived();
        const target = await this.lockVersion(tx, product, version);
        if (target.status !== 'DRAFT') throw notDraft(target);
        const active = await tx.recipeVersion.findFirst({
          where: { productId: product.id, status: 'ACTIVE' },
        });
        if ((active?.version ?? null) !== input.expectedActiveVersion) {
          throw domainError(
            409,
            'ACTIVE_VERSION_CHANGED',
            `The active version is ${active?.version ?? 'none'}, not ${input.expectedActiveVersion ?? 'none'}`,
          );
        }
        const recipe = target.view;
        if (recipe.missing.length > 0) {
          throw domainError(
            422,
            'RECIPE_INCOMPLETE',
            `Only a complete version is activated (missing: ${recipe.missing.join(', ')})`,
          );
        }
        // Re-validate against today's catalogue (an item may have been archived meanwhile).
        await this.validate(
          tx,
          product,
          recipe.crateType?.code ?? null,
          recipe.components.map((c) => ({
            itemCode: c.itemCode,
            quantity: c.quantity,
            unitCode: c.unit.code,
          })),
        );
        const now = new Date();
        if (active) {
          await tx.recipeVersion.update({
            where: { id: active.id },
            data: { status: 'ARCHIVED', archivedAt: now, archivedBy: actorId },
          });
          await this.audit.record(
            {
              type: 'RECIPE_ARCHIVED',
              actorUserId: actorId,
              reason: input.reason,
              payload: {
                product: productCode,
                version: active.version,
                previousStatus: 'ACTIVE',
                replacedBy: version,
                requestId: input.requestId,
              },
            },
            tx,
          );
        }
        await tx.recipeVersion.update({
          where: { id: target.id },
          data: { status: 'ACTIVE', activatedAt: now, activatedBy: actorId },
        });
        await this.audit.record(
          {
            type: 'RECIPE_ACTIVATED',
            actorUserId: actorId,
            reason: input.reason,
            payload: {
              product: productCode,
              version,
              revision: recipe.revision,
              replacedVersion: active?.version ?? null,
              requestId: input.requestId,
            },
          },
          tx,
        );
        return (await this.load(tx, productCode, version)).view;
      },
    );
    return result;
  }

  /** Archives a DRAFT or the ACTIVE version. Nothing else changes; history stays readable. */
  async archive(
    actorId: string,
    productCode: string,
    version: number,
    input: ArchiveRecipeRequest,
  ): Promise<RecipeVersion> {
    const { result } = await this.operations.run(
      'RECIPE_ARCHIVE',
      input.requestId,
      { actorId, productCode, version, ...input },
      async (tx) => {
        const product = await this.lockProduct(tx, productCode);
        const target = await this.lockVersion(tx, product, version);
        if (target.status === 'ARCHIVED') {
          throw domainError(409, 'RECIPE_ARCHIVED', `Version ${version} is already archived`);
        }
        await tx.recipeVersion.update({
          where: { id: target.id },
          data: { status: 'ARCHIVED', archivedAt: new Date(), archivedBy: actorId },
        });
        await this.audit.record(
          {
            type: 'RECIPE_ARCHIVED',
            actorUserId: actorId,
            reason: input.reason,
            payload: {
              product: productCode,
              version,
              previousStatus: target.status,
              replacedBy: null,
              requestId: input.requestId,
            },
          },
          tx,
        );
        return (await this.load(tx, productCode, version)).view;
      },
    );
    return result;
  }

  // --- internals ---------------------------------------------------------------------------------

  private async lockProduct(tx: Prisma.TransactionClient, code: string): Promise<ProductRow> {
    const rows = await tx.$queryRaw<ProductRow[]>`
      SELECT "id", "code", "category_code", "status"::text FROM "products"
      WHERE "code" = ${code} FOR UPDATE`;
    if (!rows[0]) throw new NotFoundException('Product not found');
    return rows[0];
  }

  private async lockVersion(tx: Prisma.TransactionClient, product: ProductRow, version: number) {
    await tx.$queryRaw`
      SELECT 1 FROM "recipe_versions"
      WHERE "product_id" = ${product.id}::uuid AND "version" = ${version} FOR UPDATE`;
    return this.load(tx, product.code, version);
  }

  private async find(
    db: Prisma.TransactionClient,
    productId: string,
    version: number,
  ): Promise<RecipeRecord | null> {
    const row = await db.recipeVersion.findUnique({
      where: { productId_version: { productId, version } },
      include: recipeInclude,
    });
    if (!row) return null;
    const revision = row.revisions[0];
    const boms = revision
      ? await this.inventory.bomsWithLines(
          revision.boms.map((b) => b.bomVersionId),
          db,
        )
      : [];
    const crate = revision?.crateTypeId
      ? await this.crateTypes.byId(revision.crateTypeId, db)
      : null;
    return { ...row, view: toRecipe(row, boms, crate) };
  }

  private async load(db: Prisma.TransactionClient, productCode: string, version: number) {
    const product = await db.product.findUnique({
      where: { code: productCode },
      select: { id: true },
    });
    if (!product) throw new NotFoundException('Product not found');
    const recipe = await this.find(db, product.id, version);
    if (!recipe) throw new NotFoundException('Recipe version not found');
    return recipe;
  }

  /**
   * Validates a recipe's content for the product (doc 023 §4): known, active items of the four
   * recipe kinds, each item and kind once, the line unit = the item's base unit (no conversion)
   * and allowed for the kind, quantities in the unit's scale, exactly 1 bottle body, liquid and
   * label made for the product's category, the crate type carrying that category. An incomplete
   * list is fine for a draft; activation checks completeness.
   */
  private async validate(
    tx: Prisma.TransactionClient,
    product: ProductRow,
    crateTypeCode: string | null,
    components: UpdateRecipeDraftRequest['components'],
  ): Promise<RecipeContent> {
    let crateTypeId: string | null = null;
    if (crateTypeCode !== null) {
      const crate = await this.crateTypes.byCode(crateTypeCode, tx);
      if (!crate) throw domainError(422, 'UNKNOWN_CRATE_TYPE', 'Unknown crate type');
      if (!crate.categories.some((c) => c.categoryCode === product.category_code)) {
        throw domainError(
          422,
          'CRATE_TYPE_CATEGORY_MISMATCH',
          `Crate type ${crate.code} does not carry category ${product.category_code}`,
        );
      }
      crateTypeId = crate.id;
    }
    const codes = components.map((c) => c.itemCode);
    if (new Set(codes).size !== codes.length) {
      throw domainError(422, 'DUPLICATE_COMPONENT', 'A component appears more than once');
    }
    const items = new Map(
      (await this.catalog.componentsByCode(codes, tx)).map((i) => [i.code, i] as const),
    );
    const kinds = new Set<string>();
    const lines = components.map((c) => {
      const item = items.get(c.itemCode);
      if (!item) throw domainError(422, 'UNKNOWN_ITEM', `Unknown item ${c.itemCode}`);
      if (item.archivedAt) {
        throw domainError(422, 'ITEM_ARCHIVED', `Item ${item.code} is archived`);
      }
      if (!(REQUIRED_RECIPE_KINDS as readonly string[]).includes(item.kind)) {
        throw domainError(
          422,
          'COMPONENT_NOT_ALLOWED',
          `A ${item.kind} item is not a component of a finished bottle`,
        );
      }
      const kind = item.kind as RecipeComponentKind;
      if (kinds.has(kind)) {
        throw domainError(
          422,
          'DUPLICATE_COMPONENT_KIND',
          `A finished bottle has one ${kind} line`,
        );
      }
      kinds.add(kind);
      if (c.unitCode !== item.baseUnit.code) {
        throw domainError(
          422,
          'UNIT_MISMATCH',
          `${item.code} is kept in ${item.baseUnit.code}, not ${c.unitCode} (no unit conversion)`,
        );
      }
      if (!unitAllowedFor(item.kind, item.baseUnit)) {
        throw domainError(
          422,
          'UNIT_NOT_ALLOWED',
          `${item.code} has a unit not allowed for ${kind}`,
        );
      }
      const q = quantity(c.quantity);
      if (q.lte(0)) throw domainError(422, 'INVALID_QUANTITY', 'Quantity must be positive');
      assertUnitScale(q, item.baseUnit.decimalPlaces, `Quantity of ${item.code}`);
      if (kind === 'NEW_BOTTLE' && !q.eq(1)) {
        throw domainError(
          422,
          'BOTTLE_BODY_QUANTITY',
          'A finished bottle has exactly one bottle body',
        );
      }
      if (kind === 'NEW_BOTTLE' && item.lotTracking !== 'REQUIRED') {
        throw domainError(
          422,
          'LOT_TRACKING_REQUIRED',
          `${item.code} is not lot-tracked: a bottle body is consumed from a chosen lot`,
        );
      }
      const category = item.component?.categoryCode ?? null;
      const needsCategory = kind === 'BULK_LIQUID' || kind === 'LABEL_MEDIA';
      if ((needsCategory || category !== null) && category !== product.category_code) {
        throw domainError(
          422,
          'COMPONENT_CATEGORY_MISMATCH',
          `${item.code} is not made for category ${product.category_code}`,
        );
      }
      return {
        itemId: item.id,
        itemCode: item.code,
        unitId: item.baseUnitId,
        unitCode: item.baseUnit.code,
        kind,
        quantity: q,
      };
    });
    return { crateTypeId, crateTypeCode, lines };
  }

  /** Appends one revision: its crate type and one recipe-owned BOM version per used stage. */
  private async writeRevision(
    tx: Prisma.TransactionClient,
    product: ProductRow,
    recipeVersionId: string,
    version: number,
    revision: number,
    content: RecipeContent,
    actorId: string,
    requestId: string,
  ): Promise<void> {
    await tx.recipeRevision.create({
      data: {
        recipeVersionId,
        revision,
        categoryCode: product.category_code,
        crateTypeId: content.crateTypeId,
        createdBy: actorId,
        operationRequestId: requestId,
      },
    });
    for (const stage of ['LABEL_APPLICATION', 'FILL'] as const) {
      const lines = content.lines
        .filter((l) => RECIPE_STAGE_OF_KIND[l.kind] === stage)
        .sort((a, b) => KIND_ORDER.indexOf(a.kind) - KIND_ORDER.indexOf(b.kind));
      if (lines.length === 0) continue;
      const bom = await this.inventory.createBomVersion(tx, {
        code: `R-${product.code}-V${version}-${STAGE_CODE[stage]}`,
        version: revision,
        stage,
        lines,
      });
      await tx.recipeRevisionBom.create({
        data: { recipeVersionId, revision, stage, bomVersionId: bom.id },
      });
    }
  }
}
