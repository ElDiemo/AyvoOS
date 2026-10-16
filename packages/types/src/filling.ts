import { z } from 'zod';
import { reasonSchema } from './identity.js';
import { cycleStateSchema } from './labeling.js';

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
