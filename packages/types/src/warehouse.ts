import { z } from 'zod';
import { bottleStatusSchema } from './bottles.js';
import { decimalStringSchema } from './inventory.js';

/** Physical label application (warehouse module, doc 018 §7). */

export const labelApplicationRequestSchema = z.object({
  requestId: z.uuid(),
  /** The lot the operator selected for this working session (never guessed by the server). */
  lotId: z.uuid(),
  /** Raw scanner input: the complete QR URL; only surrounding whitespace/CR/LF is removed. */
  scannedValue: z.string().max(512),
});
export type LabelApplicationRequest = z.infer<typeof labelApplicationRequestSchema>;

export const labelApplicationOutcomeSchema = z.enum(['APPLIED', 'ALREADY_APPLIED']);
export type LabelApplicationOutcome = z.infer<typeof labelApplicationOutcomeSchema>;

export const labelApplicationResultSchema = z.object({
  outcome: labelApplicationOutcomeSchema,
  /** true when this response is the stored result of an earlier identical request. */
  replayed: z.boolean(),
  bottle: z.object({
    code: z.string(),
    status: bottleStatusSchema,
    labelAppliedAt: z.iso.datetime(),
  }),
  /** The lot that supplied this bottle body (for ALREADY_APPLIED: the original lot). */
  consumedLot: z.object({ id: z.uuid(), code: z.string() }),
  /** Remaining new bottles in the session's selected lot. */
  selectedLot: z.object({ id: z.uuid(), code: z.string(), onHand: decimalStringSchema }),
});
export type LabelApplicationResult = z.infer<typeof labelApplicationResultSchema>;

/** Stable, language-neutral rejection codes; the UI maps them to localized messages. */
export const labelApplicationErrorCodeSchema = z.enum([
  'NOT_AYVO_QR',
  'WRONG_ENVIRONMENT',
  'UNKNOWN_LABEL',
  'LABEL_NOT_PRINTED',
  'NOT_APPLICABLE',
  'LOT_EXHAUSTED',
  'WRONG_LOT',
  'IDEMPOTENCY_CONFLICT',
]);
export type LabelApplicationErrorCode = z.infer<typeof labelApplicationErrorCodeSchema>;

/** Error body of every domain rejection: { statusCode, code, message }. */
export const domainErrorSchema = z.object({
  statusCode: z.number().int(),
  code: z.string(),
  message: z.string(),
});
export type DomainErrorBody = z.infer<typeof domainErrorSchema>;

export const recentLabelApplicationSchema = z.object({
  bottleCode: z.string(),
  appliedAt: z.iso.datetime(),
  lotCode: z.string(),
});
export const recentLabelApplicationListSchema = z.object({
  items: z.array(recentLabelApplicationSchema),
});
export type RecentLabelApplication = z.infer<typeof recentLabelApplicationSchema>;

/** One installed (or removed) replaceable component of a bottle (doc 018 §15). */
export const bottleComponentSchema = z.object({
  type: z.enum(['LABEL']),
  /** LABEL: the exact QR URL scanned at installation, and its print job. */
  labelQrUrl: z.string().nullable(),
  printJobCode: z.string().nullable(),
  installedAt: z.iso.datetime(),
  removedAt: z.iso.datetime().nullable(),
  removalReason: z.string().nullable(),
  disposition: z
    .enum(['REUSED', 'SCRAPPED', 'QUARANTINED', 'CLEANING_REQUIRED', 'RETURNED_TO_SUPPLIER'])
    .nullable(),
});
export type BottleComponent = z.infer<typeof bottleComponentSchema>;

/**
 * GET /api/admin/bottles/:code/physical — the physical facts of a bottle: when its label was
 * applied, from which lot/receipt its body came, and its component history.
 */
export const bottlePhysicalSchema = z.object({
  labelApplication: z
    .object({
      appliedAt: z.iso.datetime(),
      lot: z.object({ id: z.uuid(), code: z.string() }),
      receipt: z.object({ code: z.string(), lineNo: z.number().int() }).nullable(),
      supplier: z.object({ id: z.uuid(), name: z.string() }).nullable(),
    })
    .nullable(),
  components: z.array(bottleComponentSchema),
});
export type BottlePhysical = z.infer<typeof bottlePhysicalSchema>;
