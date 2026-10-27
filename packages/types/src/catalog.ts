import { z } from 'zod';
import { reasonSchema } from './identity.js';
import {
  inventoryItemCodeSchema,
  positiveDecimalSchema,
  decimalStringSchema,
} from './inventory.js';

/**
 * Product catalogue and recipes v0.1 (doc 023). Company-wide master data: components (profiles of
 * inventory items), crate types, products and versioned recipes (= the bill of materials of ONE
 * finished bottle). No stock quantity lives here — stock stays in the ledger of each site's
 * warehouses. Quantities are exact decimal strings (doc 018 §2).
 */

/** Same pattern as inventory item and crate type codes (database CHECK). */
export const catalogCodeSchema = inventoryItemCodeSchema;
/** Product codes are shorter: they name the recipe's BOM codes (`R-<PRODUCT>-V<n>-LA`). */
export const productCodeSchema = z.string().regex(/^[A-Z0-9][A-Z0-9_-]{1,23}$/);
export const productCategoryCodeSchema = z.string().regex(/^[A-Z][A-Z0-9_]{1,39}$/);
export const unitCodeSchema = z.string().regex(/^[a-z]{1,10}$/);
export const recipeVersionNumberSchema = z.coerce.number().int().min(1).max(9999);
const nameSchema = z.string().trim().min(1).max(200);

/** Inventory item kinds a catalogue component can have. */
export const COMPONENT_KINDS = [
  'NEW_BOTTLE',
  'LABEL_MEDIA',
  'BULK_LIQUID',
  'PUMP',
  'PACKAGING',
] as const;
export const componentKindSchema = z.enum(COMPONENT_KINDS);
export type ComponentKind = z.infer<typeof componentKindSchema>;
/**
 * Kinds a component is READ with: also those a newer version creates (its enum values are already
 * in the database, rollback compatibility) — never accepted in a request of this version.
 */
export const COMPONENT_READ_KINDS = [...COMPONENT_KINDS, 'CONSUMABLE'] as const;
export const componentReadKindSchema = z.enum(COMPONENT_READ_KINDS);
export type ComponentReadKind = z.infer<typeof componentReadKindSchema>;

/**
 * One finished bottle needs exactly one line of each of these kinds (owner, 2026-10-13): the
 * bottle body, its liquid, a pump and a label. Quantities are recipe data (330 ml is never a
 * constant); the bottle body is always exactly 1 pcs.
 */
export const REQUIRED_RECIPE_KINDS = ['NEW_BOTTLE', 'LABEL_MEDIA', 'BULK_LIQUID', 'PUMP'] as const;
export type RecipeComponentKind = (typeof REQUIRED_RECIPE_KINDS)[number];

/** Recipe stage of each recipe component kind (doc 020 §3.3). */
export const RECIPE_STAGE_OF_KIND: Record<RecipeComponentKind, RecipeStage> = {
  NEW_BOTTLE: 'LABEL_APPLICATION',
  LABEL_MEDIA: 'LABEL_APPLICATION',
  BULK_LIQUID: 'FILL',
  PUMP: 'FILL',
};
export const recipeStageSchema = z.enum(['LABEL_APPLICATION', 'FILL']);
export type RecipeStage = z.infer<typeof recipeStageSchema>;

export const recipeStatusSchema = z.enum(['DRAFT', 'ACTIVE', 'ARCHIVED']);
export type RecipeStatus = z.infer<typeof recipeStatusSchema>;

const unitSchema = z.object({ code: z.string(), name: z.string(), decimalPlaces: z.number() });

/** GET /api/admin/catalog/units — the reference units (doc 018), for the catalogue forms. */
export const catalogUnitSchema = unitSchema.extend({
  dimension: z.enum(['COUNT', 'VOLUME', 'MASS']),
});
export type CatalogUnit = z.infer<typeof catalogUnitSchema>;
export const productCategorySchema = z.object({ code: z.string(), name: z.string() });
export type ProductCategory = z.infer<typeof productCategorySchema>;

// --- components --------------------------------------------------------------------------------

/** POST /api/admin/catalog/components — a new inventory item with its catalogue profile. */
export const createComponentRequestSchema = z.strictObject({
  requestId: z.uuid(),
  code: catalogCodeSchema,
  /** 120 characters, like every inventory item name (database CHECK, doc 018). */
  name: z.string().trim().min(1).max(120),
  kind: componentKindSchema,
  /** Base unit: `pcs` (shown as "ks") or a volume unit such as `ml` for liquids. */
  unitCode: unitCodeSchema,
  /** Required for a bottle body (it is consumed from the lot the operator selects). */
  lotTracked: z.boolean(),
  /** The product category the component is made for; required for liquids and labels. */
  categoryCode: productCategoryCodeSchema.nullable(),
  /** Bottles per package (packaging only); null = not known yet. */
  packageCapacity: z.number().int().min(1).max(100000).nullable(),
  reason: reasonSchema,
});
export type CreateComponentRequest = z.infer<typeof createComponentRequestSchema>;

export const catalogComponentSchema = z.object({
  code: z.string(),
  name: z.string(),
  kind: componentReadKindSchema,
  unit: unitSchema,
  lotTracked: z.boolean(),
  category: productCategorySchema.nullable(),
  packageCapacity: z.number().int().nullable(),
  archived: z.boolean(),
});
export type CatalogComponent = z.infer<typeof catalogComponentSchema>;

// --- crate types -------------------------------------------------------------------------------

/** POST /api/admin/catalog/crate-types — capacity is data (ADR 0021), never a constant. */
export const createCrateTypeRequestSchema = z.strictObject({
  requestId: z.uuid(),
  code: catalogCodeSchema,
  name: nameSchema,
  capacity: z.number().int().min(1).max(1000),
  categoryCodes: z
    .array(productCategoryCodeSchema)
    .min(1)
    .max(10)
    .refine((c) => new Set(c).size === c.length, 'Categories must be unique'),
  reason: reasonSchema,
});
export type CreateCrateTypeRequest = z.infer<typeof createCrateTypeRequestSchema>;

export const crateTypeSchema = z.object({
  code: z.string(),
  name: z.string(),
  capacity: z.number().int(),
  categories: z.array(productCategorySchema),
});
export type CrateType = z.infer<typeof crateTypeSchema>;

// --- products ----------------------------------------------------------------------------------

/** POST /api/admin/catalog/products */
export const createProductRequestSchema = z.strictObject({
  requestId: z.uuid(),
  code: productCodeSchema,
  name: nameSchema,
  categoryCode: productCategoryCodeSchema,
  /** Nominal content, e.g. "330" ml — product data, separate from the recipe's liquid line. */
  nominalQuantity: positiveDecimalSchema,
  nominalUnitCode: unitCodeSchema,
  reason: reasonSchema,
});
export type CreateProductRequest = z.infer<typeof createProductRequestSchema>;

export const recipeVersionSummarySchema = z.object({
  version: z.number().int(),
  status: recipeStatusSchema,
  revision: z.number().int(),
  basedOnVersion: z.number().int().nullable(),
  createdAt: z.iso.datetime(),
  activatedAt: z.iso.datetime().nullable(),
  archivedAt: z.iso.datetime().nullable(),
});
export type RecipeVersionSummary = z.infer<typeof recipeVersionSummarySchema>;

export const productStatusSchema = z.enum(['ACTIVE', 'ARCHIVED']);
export type ProductStatus = z.infer<typeof productStatusSchema>;

/** POST /api/admin/catalog/products/:code/rename — corrects the name (code, category and nominal quantity never change). */
export const renameProductRequestSchema = z.strictObject({
  requestId: z.uuid(),
  name: nameSchema,
  reason: reasonSchema,
});
export type RenameProductRequest = z.infer<typeof renameProductRequestSchema>;

/** POST /api/admin/catalog/products/:code/archive — only without an ACTIVE recipe version. */
export const archiveProductRequestSchema = z.strictObject({
  requestId: z.uuid(),
  reason: reasonSchema,
});
export type ArchiveProductRequest = z.infer<typeof archiveProductRequestSchema>;

export const productSchema = z.object({
  code: z.string(),
  name: z.string(),
  status: productStatusSchema,
  archivedAt: z.iso.datetime().nullable(),
  category: productCategorySchema,
  nominalQuantity: decimalStringSchema,
  nominalUnit: unitSchema,
  createdAt: z.iso.datetime(),
  activeVersion: z.number().int().nullable(),
  versions: z.array(recipeVersionSummarySchema),
});
export type Product = z.infer<typeof productSchema>;

// --- recipes -----------------------------------------------------------------------------------

/** One line of a recipe: the quantity per ONE finished bottle in the item's base unit. */
export const recipeComponentInputSchema = z.strictObject({
  itemCode: catalogCodeSchema,
  quantity: positiveDecimalSchema,
  /** Must equal the item's base unit — there is no implicit unit conversion. */
  unitCode: unitCodeSchema,
});
const recipeContentSchema = {
  /** The returnable crate type the finished bottles go into (required to activate). */
  crateTypeCode: catalogCodeSchema.nullable(),
  /** May be incomplete in a draft; duplicates and invalid lines are refused. */
  components: z.array(recipeComponentInputSchema).max(20),
};

/**
 * POST /api/admin/catalog/products/:code/recipes — a new DRAFT version: either with its content,
 * or as a copy of an existing version of the same product ("new version").
 */
export const createRecipeDraftRequestSchema = z.union([
  z.strictObject({ requestId: z.uuid(), reason: reasonSchema, ...recipeContentSchema }),
  z.strictObject({
    requestId: z.uuid(),
    reason: reasonSchema,
    basedOnVersion: recipeVersionNumberSchema,
  }),
]);
export type CreateRecipeDraftRequest = z.infer<typeof createRecipeDraftRequestSchema>;

/** PUT /api/admin/catalog/products/:code/recipes/:version — replaces a DRAFT's content. */
export const updateRecipeDraftRequestSchema = z.strictObject({
  requestId: z.uuid(),
  reason: reasonSchema,
  ...recipeContentSchema,
});
export type UpdateRecipeDraftRequest = z.infer<typeof updateRecipeDraftRequestSchema>;

/**
 * POST …/recipes/:version/activate. `expectedActiveVersion` is the version the client believes
 * is active now (null: none); a different one → 409 ACTIVE_VERSION_CHANGED. A previously active
 * version is archived in the same transaction.
 */
export const activateRecipeRequestSchema = z.strictObject({
  requestId: z.uuid(),
  reason: reasonSchema,
  expectedActiveVersion: z.number().int().min(1).max(9999).nullable(),
});
export type ActivateRecipeRequest = z.infer<typeof activateRecipeRequestSchema>;

/** POST …/recipes/:version/archive — a DRAFT or the ACTIVE version; history stays readable. */
export const archiveRecipeRequestSchema = z.strictObject({
  requestId: z.uuid(),
  reason: reasonSchema,
});
export type ArchiveRecipeRequest = z.infer<typeof archiveRecipeRequestSchema>;

export const recipeComponentSchema = z.object({
  stage: recipeStageSchema,
  itemCode: z.string(),
  itemName: z.string(),
  kind: componentReadKindSchema,
  quantity: decimalStringSchema,
  unit: unitSchema,
});
export type RecipeComponent = z.infer<typeof recipeComponentSchema>;

export const recipeVersionSchema = recipeVersionSummarySchema.extend({
  product: z.object({ code: z.string(), name: z.string(), category: productCategorySchema }),
  crateType: crateTypeSchema.nullable(),
  components: z.array(recipeComponentSchema),
  /** What activation still needs (empty = complete). */
  missing: z.array(z.enum([...REQUIRED_RECIPE_KINDS, 'CRATE_TYPE'])),
});
export type RecipeVersion = z.infer<typeof recipeVersionSchema>;

// --- material requirements ---------------------------------------------------------------------

/** Upper bound of one calculation (an input guard, not a business rule). */
export const MAX_REQUIREMENT_BOTTLES = 1_000_000;

/** GET …/recipes/:version/requirements?bottles=N */
export const materialRequirementsQuerySchema = z.strictObject({
  bottles: z.coerce.number().int().min(1).max(MAX_REQUIREMENT_BOTTLES),
});

export const materialRequirementsSchema = z.object({
  product: z.object({ code: z.string(), name: z.string(), category: productCategorySchema }),
  version: z.number().int(),
  status: recipeStatusSchema,
  bottles: z.number().int(),
  components: z.array(
    recipeComponentSchema.extend({
      /** Per bottle × bottles, exact. */
      totalQuantity: decimalStringSchema,
    }),
  ),
  crates: z.object({
    crateType: z.object({ code: z.string(), name: z.string(), capacity: z.number().int() }),
    /** ⌈bottles / capacity⌉ — never rounded down. */
    count: z.number().int(),
    /** Crates filled to capacity. */
    full: z.number().int(),
    /** Bottles in the one partially filled crate (0 = every crate is full). */
    partialCrateBottles: z.number().int(),
  }),
});
export type MaterialRequirements = z.infer<typeof materialRequirementsSchema>;
