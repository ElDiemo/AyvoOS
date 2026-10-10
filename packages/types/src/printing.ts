import { z } from 'zod';
import { bottleCreationBatchSchema } from './bottles.js';
import { labelTemplateVersionRefSchema, qrErrorCorrectionSchema } from './labels.js';

/** Label print jobs (label-production module). */

export const labelPrintJobStatusSchema = z.enum(['PENDING', 'GENERATING', 'COMPLETED', 'FAILED']);
export type LabelPrintJobStatus = z.infer<typeof labelPrintJobStatusSchema>;

export const labelPrintJobCodeSchema = z
  .string()
  .regex(/^PJ-\d{6,}$/, 'Expected a code like PJ-000001');

export const labelPrintJobSchema = z.object({
  code: z.string(),
  status: labelPrintJobStatusSchema,
  creationBatchCode: z.string(),
  labelTemplate: labelTemplateVersionRefSchema,
  labelCount: z.number().int().positive(),
  attempts: z.number().int().nonnegative(),
  createdAt: z.iso.datetime(),
  startedAt: z.iso.datetime().nullable(),
  completedAt: z.iso.datetime().nullable(),
  failedAt: z.iso.datetime().nullable(),
  failureReason: z.string().nullable(),
  fileByteSize: z.number().int().nullable(),
  /** Environment that created the job; non-production labels carry a DEV marker. */
  environment: z.enum(['development', 'test', 'production']),
  qrErrorCorrection: qrErrorCorrectionSchema,
  /** Same-origin download URL (admin only) when COMPLETED, else null. */
  downloadUrl: z.string().nullable(),
});
export type LabelPrintJob = z.infer<typeof labelPrintJobSchema>;

export const labelPrintJobListResponseSchema = z.object({ items: z.array(labelPrintJobSchema) });
export type LabelPrintJobListResponse = z.infer<typeof labelPrintJobListResponseSchema>;

/**
 * Response of POST /api/admin/bottle-registrations. The batch is committed independently of the
 * print job: if the pending print job could not be created, `printJob` is null and the batch is
 * still valid (create a print job from the batch page).
 */
export const bottleRegistrationResponseSchema = z.object({
  /** true when this request was a retry of an already completed registration (same requestId). */
  replayed: z.boolean(),
  batch: bottleCreationBatchSchema,
  printJob: labelPrintJobSchema.nullable(),
});
export type BottleRegistrationResponse = z.infer<typeof bottleRegistrationResponseSchema>;
