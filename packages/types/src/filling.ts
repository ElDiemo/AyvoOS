import { z } from 'zod';
import { bottleStatusSchema } from './bottles.js';
import { reasonSchema } from './identity.js';
import { crateCycleStatusSchema, cycleStateSchema } from './labeling.js';
import { labelTemplateVersionRefSchema } from './labels.js';

/**
 * Filling into the same crate (doc 025 A4, owner decisions B2–B5): a filling station (mode +
 * category) loads the crate that was assembled at labelling, the operator explicitly chooses the
 * liquid lot (it applies from the next bottle), and each "Potvrdit naplnění" scan checks the
 * bottle is an eligible member of THAT crate, then records the fill and consumes the cycle
 * recipe's FILL BOM (liquid from the chosen lot + pump) exactly once. Only an explicit Hotovo with
 * a full, completely filled crate makes it ready (FILLED, "Připravená").
 */

const ref = z.object({ code: z.string(), name: z.string() });

export const fillingStateSchema = z.object({
  /** Changes with every crate load or liquid lot switch; filling scans and Hotovo name it. */
  contextRevision: z.number().int(),
  /** The station's product category. */
  category: ref,
  crate: z
    .object({ code: z.string(), capacity: z.number().int(), cycle: cycleStateSchema.nullable() })
    .nullable(),
  /** The liquid and the pump of the loaded crate's recipe (its FILL BOM), when a crate is loaded. */
  liquidItem: ref.extend({ unitCode: z.string(), quantity: z.string() }).nullable(),
  pumpItem: ref.nullable(),
  /** The explicitly chosen liquid lot; applies to the following bottles (owner B5). */
  liquidLot: z.object({ id: z.uuid(), code: z.string(), onHand: z.string() }).nullable(),
  /** Lots of the recipe's liquid with stock at the station's warehouse. */
  lots: z.array(z.object({ id: z.uuid(), code: z.string(), onHand: z.string() })),
});
export type FillingState = z.infer<typeof fillingStateSchema>;

export const setLiquidLotRequestSchema = z.strictObject({
  requestId: z.uuid(),
  liquidLotId: z.uuid(),
});
export type SetLiquidLotRequest = z.infer<typeof setLiquidLotRequestSchema>;

export const fillScanResultSchema = z.object({
  outcome: z.enum(['FILLED', 'ALREADY_FILLED']),
  bottle: z.object({ code: z.string() }),
  crate: z.object({ code: z.string() }),
  cycle: cycleStateSchema,
  /** The lot this bottle's liquid came from (for ALREADY_FILLED: the lot recorded earlier). */
  liquidLot: z.object({ code: z.string(), onHand: z.string() }),
});
export type FillScanResult = z.infer<typeof fillScanResultSchema>;

/** Hotovo: the crate loaded at the station, in the context revision the operator saw. */
export const finishCrateRequestSchema = z.strictObject({
  requestId: z.uuid(),
  contextRevision: z.number().int().min(0),
});
export type FinishCrateRequest = z.infer<typeof finishCrateRequestSchema>;

export const finishCrateResultSchema = z.object({
  crate: z.object({ code: z.string() }),
  cycle: cycleStateSchema,
});
export type FinishCrateResult = z.infer<typeof finishCrateResultSchema>;

// --- supervised corrections (production:cycle_correct, doc 025 §4.2) ---------------------------

/** A bottle named by its code (AYV-B-…) or its scanned QR URL. */
const bottleRefSchema = z.string().trim().min(1).max(2048);

export const removeCrateMemberRequestSchema = z.strictObject({
  requestId: z.uuid(),
  bottle: bottleRefSchema,
  reason: reasonSchema,
});
export type RemoveCrateMemberRequest = z.infer<typeof removeCrateMemberRequestSchema>;

/**
 * "Doplnit / Přeložit lahev": a labelled bottle outside any crate, with the cycle's snapshot,
 * into a free place of an open cycle — or, for finished bottles, into an empty crate (the first
 * one opens a FILLING cycle with its snapshot). Never a consumption.
 */
export const addCrateMemberRequestSchema = z.strictObject({
  requestId: z.uuid(),
  bottle: bottleRefSchema,
  reason: reasonSchema,
});
export type AddCrateMemberRequest = z.infer<typeof addCrateMemberRequestSchema>;

export const cycleReasonRequestSchema = z.strictObject({
  requestId: z.uuid(),
  reason: reasonSchema,
});
export type CycleReasonRequest = z.infer<typeof cycleReasonRequestSchema>;

export const cycleCorrectionResultSchema = z.object({
  crate: z.object({ code: z.string() }),
  /** The crate's open cycle after the correction, or null (aborted: the crate is empty). */
  cycle: cycleStateSchema.nullable(),
});
export type CycleCorrectionResult = z.infer<typeof cycleCorrectionResultSchema>;

// --- overview (doc 025 A5): crate content and bottles outside a crate --------------------------

export const crateContentSchema = z.object({
  crate: z.object({ code: z.string(), capacity: z.number().int() }),
  /** The open cycle with its snapshot, or null ("Prázdná"). */
  cycle: z
    .object({
      status: crateCycleStatusSchema,
      product: ref,
      category: z.string(),
      recipeVersion: z.number().int(),
      design: labelTemplateVersionRefSchema,
      memberCount: z.number().int(),
      filledCount: z.number().int(),
      capacity: z.number().int(),
      openedAt: z.iso.datetime(),
      readyToFillAt: z.iso.datetime().nullable(),
      filledAt: z.iso.datetime().nullable(),
    })
    .nullable(),
  /** The open cycle's members in ordinal order. */
  members: z.array(
    z.object({
      ordinal: z.number().int(),
      bottle: z.object({ code: z.string(), status: bottleStatusSchema }),
      source: z.enum(['LABELING', 'REPACKED', 'REPLACEMENT']),
      assignedAt: z.iso.datetime(),
      /** The liquid lot of a filled member. */
      liquidLot: z.string().nullable(),
    }),
  ),
  /** Earlier, aborted circulations of this crate (newest first). */
  aborted: z.array(
    z.object({
      product: ref,
      openedAt: z.iso.datetime(),
      abortedAt: z.iso.datetime(),
      reason: z.string(),
    }),
  ),
});
export type CrateContent = z.infer<typeof crateContentSchema>;

export const outsideBottleSchema = z.object({
  code: z.string(),
  status: bottleStatusSchema,
  /** Null for a bottle labelled before crates were recorded (no binding, owner B3). */
  product: ref.nullable(),
  recipeVersion: z.number().int().nullable(),
  design: z.string().nullable(),
  liquidLot: z.string().nullable(),
  /** The crate it last left, when, and why. */
  lastCrate: z.string().nullable(),
  leftAt: z.iso.datetime().nullable(),
  reason: z.string().nullable(),
});
export type OutsideBottle = z.infer<typeof outsideBottleSchema>;

export const outsideBottleGroupSchema = z.enum(['finished', 'labelledEmpty', 'legacy']);
export type OutsideBottleGroup = z.infer<typeof outsideBottleGroupSchema>;

/**
 * GET /api/admin/bottles-outside-crates — one group, one bounded page (doc 025 §3.3, A5); an
 * optional exact search by bottle code or scanned QR URL. Always the active site only.
 */
export const outsideBottlesQuerySchema = z.object({
  group: outsideBottleGroupSchema.default('finished'),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(50),
  search: z.string().trim().max(2048).optional(),
});
export type OutsideBottlesQuery = z.infer<typeof outsideBottlesQuerySchema>;

export const outsideBottlesPageSchema = z.object({
  group: outsideBottleGroupSchema,
  items: z.array(outsideBottleSchema),
  page: z.number().int(),
  pageSize: z.number().int(),
  /** Matching bottles of this group (with the search). */
  total: z.number().int(),
  /** All bottles of each group outside a crate (without the search). */
  totals: z.record(outsideBottleGroupSchema, z.number().int()),
});
export type OutsideBottlesPage = z.infer<typeof outsideBottlesPageSchema>;
