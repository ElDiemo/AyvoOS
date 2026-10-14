import { z } from 'zod';
import { reasonSchema } from './identity.js';
import { labelTemplateVersionRefSchema } from './labels.js';

/**
 * Labelling into crates (doc 025 A3, owner decisions B1–B4): approved label designs per product,
 * the labelling context of a station session (chosen once, re-validated on every scan), loading a
 * crate and the labelling scan (label applied → bottle into the crate, body + label consumed once).
 */

export const crateCycleStatusSchema = z.enum([
  'OPEN_ASSEMBLY',
  'READY_TO_FILL',
  'FILLING',
  'FILLED',
  'ABORTED',
]);
export type CrateCycleStatus = z.infer<typeof crateCycleStatusSchema>;

const ref = z.object({ code: z.string(), name: z.string() });

// --- approved label designs (catalog:product_manage) -------------------------------------------

export const productLabelApprovalSchema = z.object({
  id: z.uuid(),
  design: labelTemplateVersionRefSchema,
  reason: z.string(),
  approvedAt: z.iso.datetime(),
  approvedBy: z.string(),
  revokedAt: z.iso.datetime().nullable(),
  revokedBy: z.string().nullable(),
  revokeReason: z.string().nullable(),
});
export type ProductLabelApproval = z.infer<typeof productLabelApprovalSchema>;

export const approveProductLabelRequestSchema = z.strictObject({
  requestId: z.uuid(),
  labelTemplateVersionId: z.uuid(),
  reason: reasonSchema,
});
export type ApproveProductLabelRequest = z.infer<typeof approveProductLabelRequestSchema>;

export const revokeProductLabelRequestSchema = z.strictObject({
  requestId: z.uuid(),
  reason: reasonSchema,
});
export type RevokeProductLabelRequest = z.infer<typeof revokeProductLabelRequestSchema>;

// --- the station's labelling context ----------------------------------------------------------

/** What a labelling station may choose from (active products with an active recipe). */
export const labelingOptionsSchema = z.object({
  products: z.array(
    z.object({
      code: z.string(),
      name: z.string(),
      category: ref,
      recipeVersion: z.number().int(),
      designs: z.array(labelTemplateVersionRefSchema),
      bottleItem: ref,
      labelItem: ref.nullable(),
    }),
  ),
  /** Lots with stock at the station's warehouse, per bottle item code. */
  lots: z.array(
    z.object({ id: z.uuid(), code: z.string(), itemCode: z.string(), onHand: z.string() }),
  ),
});
export type LabelingOptions = z.infer<typeof labelingOptionsSchema>;

export const setLabelingContextRequestSchema = z.strictObject({
  requestId: z.uuid(),
  productCode: z.string().min(1).max(40),
  labelTemplateVersionId: z.uuid(),
  sourceLotId: z.uuid(),
});
export type SetLabelingContextRequest = z.infer<typeof setLabelingContextRequestSchema>;

export const scanRequestSchema = z.strictObject({
  requestId: z.uuid(),
  scannedValue: z.string().min(1).max(2048),
});
export type ScanRequest = z.infer<typeof scanRequestSchema>;

/**
 * A labelling scan names the context revision it was made in (the labelling state returns it):
 * a retry after the station's context or crate changed is refused (CONTEXT_CHANGED), so a
 * physical bottle never lands in another crate than the one it was scanned for.
 */
export const labelScanRequestSchema = scanRequestSchema.extend({
  contextRevision: z.number().int().min(0),
});
export type LabelScanRequest = z.infer<typeof labelScanRequestSchema>;

export const cycleStateSchema = z.object({
  status: crateCycleStatusSchema,
  memberCount: z.number().int(),
  capacity: z.number().int(),
  product: ref,
  recipeVersion: z.number().int(),
  design: labelTemplateVersionRefSchema,
});
export type CycleState = z.infer<typeof cycleStateSchema>;

export const labelingStateSchema = z.object({
  /** Changes with every context change or crate load; labelling scans must name it. */
  contextRevision: z.number().int(),
  product: ref.extend({ category: ref }).nullable(),
  /**
   * The recipe version a NEW crate cycle would snapshot (an open cycle keeps its own — shown in
   * crate.cycle.recipeVersion).
   */
  recipeVersion: z.number().int().nullable(),
  design: labelTemplateVersionRefSchema.nullable(),
  sourceLot: z.object({ id: z.uuid(), code: z.string(), onHand: z.string() }).nullable(),
  crate: z
    .object({ code: z.string(), capacity: z.number().int(), cycle: cycleStateSchema.nullable() })
    .nullable(),
});
export type LabelingState = z.infer<typeof labelingStateSchema>;

export const labelScanResultSchema = z.object({
  outcome: z.enum(['APPLIED', 'ALREADY_APPLIED']),
  bottle: z.object({ code: z.string() }),
  crate: z.object({ code: z.string() }),
  cycle: cycleStateSchema,
  sourceLot: z.object({ code: z.string(), onHand: z.string() }),
});
export type LabelScanResult = z.infer<typeof labelScanResultSchema>;
