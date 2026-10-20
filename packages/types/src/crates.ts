import { z } from 'zod';
import { pageSchema, PAGE_SIZE_MAX } from './bottles.js';
import { catalogCodeSchema } from './catalog.js';
import { qrErrorCorrectionSchema } from './labels.js';
import { labelPrintJobStatusSchema } from './printing.js';

/**
 * Physical returnable crates and their QR labels (doc 020 §3.4, ADR 0021 §6, doc 025 PR A1).
 * A crate has a permanent internal id, a human code "AYV-C-000001" and an opaque QR token (the
 * scan identity). Crates belong to a site (doc 022). Crate cycles (filling, ready crates) are a
 * later PR (doc 025 §9) — nothing here claims a cycle state.
 */

export const crateCodeSchema = z
  .string()
  .regex(/^AYV-C-\d{6,}$/, 'Expected a code like AYV-C-000001');
export const crateRegistrationCodeSchema = z
  .string()
  .regex(/^CR-\d{6,}$/, 'Expected a code like CR-000001');

export const CRATE_REGISTRATION_MAX = 1000;
/** Physical label size bounds (database CHECK). The size itself is not approved yet (doc 025 Q7). */
export const CRATE_LABEL_SIZE_MM = { min: 20, max: 300 } as const;
/** Smallest QR box accepted on a crate label (smallest size of the QR validation sheet, doc 016). */
export const CRATE_LABEL_MIN_QR_MM = 10;

export const crateStatusSchema = z.enum(['ACTIVE', 'RETIRED']);
export type CrateStatus = z.infer<typeof crateStatusSchema>;
export const crateEventTypeSchema = z.enum([
  'REGISTERED',
  'LABEL_PRINT_JOB_CREATED',
  'CYCLE_OPENED',
  'READY_TO_FILL',
  'FILLING_STARTED',
  'CRATE_FILLED',
  'RETURNED_TO_FILLING',
  'CYCLE_ABORTED',
  'MEMBER_REMOVED',
  'MEMBER_ADDED',
  'ALLOCATED_TO_ORDER',
  'RELEASED_FROM_ORDER',
  /** Its parcel is with the carrier (doc 029, doc 031) — not delivered. */
  'DISPATCHED',
  /** Its parcel was delivered, per the carrier (doc 031). */
  'DELIVERED',
]);
export type CrateEventType = z.infer<typeof crateEventTypeSchema>;

const crateTypeRefSchema = z.object({ code: z.string(), name: z.string(), capacity: z.number() });
const siteRefSchema = z.object({ code: z.string(), name: z.string() });
const locationRefSchema = z.object({ code: z.string(), name: z.string() });

/** POST /api/admin/crate-registrations — idempotent per requestId; at the active site. */
export const registerCratesRequestSchema = z.strictObject({
  requestId: z.uuid(),
  crateTypeCode: catalogCodeSchema,
  quantity: z.number().int().min(1).max(CRATE_REGISTRATION_MAX),
});
export type RegisterCratesRequest = z.infer<typeof registerCratesRequestSchema>;

export const crateRegistrationSchema = z.object({
  code: z.string(),
  crateType: crateTypeRefSchema,
  quantity: z.number().int(),
  site: siteRefSchema,
  /** Codes of the registered crates, in serial order. */
  crateCodes: z.array(z.string()),
  createdAt: z.iso.datetime(),
});
export type CrateRegistration = z.infer<typeof crateRegistrationSchema>;

export const crateSummarySchema = z.object({
  code: z.string(),
  crateType: crateTypeRefSchema,
  status: crateStatusSchema,
  site: siteRefSchema,
  registrationCode: z.string(),
  /**
   * Last physically recorded location (a warehouse of the site), or null when no operation has
   * recorded one yet ("Neevidováno") — never an estimate.
   */
  lastLocation: locationRefSchema.nullable(),
  /** The open crate cycle (doc 025 A3), or null: no open circulation. */
  cycle: z
    .object({
      status: z.enum([
        'OPEN_ASSEMBLY',
        'READY_TO_FILL',
        'FILLING',
        'FILLED',
        'ABORTED',
        'ALLOCATED',
        'DISPATCHED',
        'DELIVERED',
      ]),
      memberCount: z.number().int(),
      /** "Naplněno" (doc 025 §3.2), shown beside "Obsah" (memberCount). */
      filledCount: z.number().int(),
      capacity: z.number().int(),
      product: z.object({ code: z.string(), name: z.string() }),
      recipeVersion: z.number().int(),
    })
    .nullable(),
  /** Time of the latest crate event. */
  lastEventAt: z.iso.datetime(),
  createdAt: z.iso.datetime(),
});
export type CrateSummary = z.infer<typeof crateSummarySchema>;

export const crateListQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(PAGE_SIZE_MAX).default(50),
  /** Crate code or number: "AYV-C-000012", "000012" or "12". */
  search: z.string().trim().max(32).optional(),
  crateType: catalogCodeSchema.optional(),
  /** Derived list state (doc 025 §3.2): EMPTY = no open cycle. */
  state: z
    .enum([
      'EMPTY',
      'OPEN_ASSEMBLY',
      'READY_TO_FILL',
      'FILLING',
      'FILLED',
      'ALLOCATED',
      'DISPATCHED',
      'DELIVERED',
    ])
    .optional(),
});
export type CrateListQuery = z.infer<typeof crateListQuerySchema>;
export const crateListStateSchema = crateListQuerySchema.shape.state.unwrap();
export type CrateListState = z.infer<typeof crateListStateSchema>;
export const cratePageSchema = pageSchema(crateSummarySchema).extend({
  /** Crates of the active site per derived state (independent of the other filters). */
  stateCounts: z.record(crateListStateSchema, z.number().int()),
});
export type CratePage = z.infer<typeof cratePageSchema>;

/** POST /api/admin/crate-label-print-jobs — idempotent per requestId; crates of the active site. */
export const createCrateLabelPrintJobRequestSchema = z.strictObject({
  requestId: z.uuid(),
  crateCodes: z
    .array(crateCodeSchema)
    .min(1)
    .max(CRATE_REGISTRATION_MAX)
    .refine((codes) => new Set(codes).size === codes.length, 'Each crate only once'),
  widthMm: z.number().int().min(CRATE_LABEL_SIZE_MM.min).max(CRATE_LABEL_SIZE_MM.max),
  heightMm: z.number().int().min(CRATE_LABEL_SIZE_MM.min).max(CRATE_LABEL_SIZE_MM.max),
});
export type CreateCrateLabelPrintJobRequest = z.infer<typeof createCrateLabelPrintJobRequestSchema>;

export const crateLabelPrintJobSchema = z.object({
  code: z.string(),
  status: labelPrintJobStatusSchema,
  labelCount: z.number().int().positive(),
  widthMm: z.number().int(),
  heightMm: z.number().int(),
  /** Codes of the printed crates, in page order. */
  crateCodes: z.array(z.string()),
  attempts: z.number().int().nonnegative(),
  createdAt: z.iso.datetime(),
  createdBy: z.string(),
  startedAt: z.iso.datetime().nullable(),
  completedAt: z.iso.datetime().nullable(),
  failureReason: z.string().nullable(),
  environment: z.enum(['development', 'test', 'production']),
  qrErrorCorrection: qrErrorCorrectionSchema,
  /** Same-origin download URL when COMPLETED, else null. */
  downloadUrl: z.string().nullable(),
  /**
   * The server would render this stored job now (PENDING, FAILED, or GENERATING abandoned for
   * longer than the stale limit) — the same rule as its claim. A running job is not retryable.
   */
  retryable: z.boolean(),
});
export type CrateLabelPrintJob = z.infer<typeof crateLabelPrintJobSchema>;

export const crateEventSchema = z.object({
  type: crateEventTypeSchema,
  occurredAt: z.iso.datetime(),
  /** The user; null for an event recorded from the carrier (source CARRIER, doc 031). */
  actor: z.string().nullable(),
  source: z.enum(['USER', 'CARRIER']),
  location: locationRefSchema.nullable(),
  registrationCode: z.string().nullable(),
  printJobCode: z.string().nullable(),
  /** Corrections and their bottles (doc 025 §4.2): bottle code, reason, assignment source. */
  bottle: z.string().nullable(),
  reason: z.string().nullable(),
  /** The order of an allocation or its release (doc 028). */
  order: z.string().nullable(),
});
export type CrateEvent = z.infer<typeof crateEventSchema>;

export const crateDetailSchema = crateSummarySchema.extend({
  /** The exact URL encoded in the crate's QR code (stable: reprints encode the same URL). */
  qrUrl: z.string(),
  /** Oldest first. */
  events: z.array(crateEventSchema),
  /** Newest first. */
  printJobs: z.array(crateLabelPrintJobSchema),
});
export type CrateDetail = z.infer<typeof crateDetailSchema>;

/**
 * GET /api/public/crates/:token — anonymous. Only that this is an AYVO returnable crate (doc 020
 * §3.4): never its code, site, location, hotel, order, contents, count or history.
 */
export const publicCrateSchema = z.object({ kind: z.literal('AYVO_RETURNABLE_CRATE') });
export type PublicCrate = z.infer<typeof publicCrateSchema>;

/** Text printed on a crate label (ASCII only: standard PDF fonts). */
export interface CrateLabelText {
  code: string;
  /** e.g. "CRATE-40 · 40" — type code and capacity, auxiliary only. */
  detail: string;
}

export interface CrateLabelLayout {
  orientation: 'side' | 'stacked';
  /** Top band reserved for the "DEV - NOT FOR PRODUCTION" marker (kept in every environment). */
  bandMm: number;
  qr: { xMm: number; yMm: number; sizeMm: number };
  text: { xMm: number; yMm: number; widthMm: number; heightMm: number };
}

const MARGIN_MM = 3;
const GAP_MM = 2;
const MIN_TEXT_WIDTH_MM = 24;
const STACKED_TEXT_MM = 12;

/**
 * Where QR and text go on a crate label of the given size (top-left origin, millimetres), or
 * null when the QR would be smaller than CRATE_LABEL_MIN_QR_MM. Shared by the PDF renderer and
 * the browser, so the form can say how big the QR will be before anything is created.
 */
export function crateLabelLayout(widthMm: number, heightMm: number): CrateLabelLayout | null {
  const bandMm = Math.min(5, heightMm * 0.15);
  const top = bandMm + MARGIN_MM / 2;
  const usableHeight = heightMm - top - MARGIN_MM;
  const sideQr = Math.min(usableHeight, widthMm - 2 * MARGIN_MM - GAP_MM - MIN_TEXT_WIDTH_MM);
  if (sideQr >= CRATE_LABEL_MIN_QR_MM && widthMm >= heightMm) {
    const textX = MARGIN_MM + sideQr + GAP_MM;
    return {
      orientation: 'side',
      bandMm,
      qr: { xMm: MARGIN_MM, yMm: top, sizeMm: sideQr },
      text: { xMm: textX, yMm: top, widthMm: widthMm - textX - MARGIN_MM, heightMm: sideQr },
    };
  }
  const stackedQr = Math.min(widthMm - 2 * MARGIN_MM, usableHeight - GAP_MM - STACKED_TEXT_MM);
  if (stackedQr < CRATE_LABEL_MIN_QR_MM) return null;
  const textY = top + stackedQr + GAP_MM;
  return {
    orientation: 'stacked',
    bandMm,
    qr: { xMm: (widthMm - stackedQr) / 2, yMm: top, sizeMm: stackedQr },
    text: {
      xMm: MARGIN_MM,
      yMm: textY,
      widthMm: widthMm - 2 * MARGIN_MM,
      heightMm: heightMm - textY - MARGIN_MM,
    },
  };
}
