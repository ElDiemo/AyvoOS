import { z } from 'zod';

/**
 * Return intake R1 (doc 047 §4): receipts of the active site, their lines (one physical container
 * each), the individual identification of returned bottles, issues and defective pump counts.
 */

export const returnReceiptCodeSchema = z
  .string()
  .trim()
  .regex(/^RR-\d{6,}$/);
export const returnIssueCodeSchema = z
  .string()
  .trim()
  .regex(/^RI-\d{6,}$/);

export const openReturnReceiptRequestSchema = z.strictObject({
  requestId: z.uuid(),
  hotelCode: z.string().trim().min(1).max(40).nullable(),
});
export type OpenReturnReceiptRequest = z.infer<typeof openReturnReceiptRequestSchema>;

export const returnScanRequestSchema = z.strictObject({
  requestId: z.uuid(),
  scannedValue: z.string().trim().min(1).max(500),
});
export type ReturnScanRequest = z.infer<typeof returnScanRequestSchema>;

/** GOOD → "Vrácená, čeká na mytí"; DEFECTIVE → "Ke skartaci" (RETIRED, DEFECTIVE_AT_RETURN). */
export const returnBottleOutcomeSchema = z.enum(['GOOD', 'DEFECTIVE']);
export type ReturnBottleOutcome = z.infer<typeof returnBottleOutcomeSchema>;

export const returnBottleScanRequestSchema = z.strictObject({
  requestId: z.uuid(),
  scannedValue: z.string().trim().min(1).max(500),
  outcome: returnBottleOutcomeSchema,
});
export type ReturnBottleScanRequest = z.infer<typeof returnBottleScanRequestSchema>;

export const returnRequestSchema = z.strictObject({ requestId: z.uuid() });
export type ReturnRequest = z.infer<typeof returnRequestSchema>;

export const returnPumpCountRequestSchema = z
  .strictObject({
    requestId: z.uuid(),
    /** Defective pumps counted (+); a correction is negative and needs a reason. */
    defective: z
      .number()
      .int()
      .min(-1000)
      .max(1000)
      .refine((n) => n !== 0),
    reason: z.string().trim().max(500).nullable(),
  })
  .refine((r) => r.defective > 0 || !!r.reason, { message: 'A correction needs a reason' });
export type ReturnPumpCountRequest = z.infer<typeof returnPumpCountRequestSchema>;

export const emptyReturnLineRequestSchema = z.strictObject({
  requestId: z.uuid(),
  physicalCount: z.number().int().min(0).max(10_000),
});
export type EmptyReturnLineRequest = z.infer<typeof emptyReturnLineRequestSchema>;

export const identifyReturnIssueRequestSchema = z.strictObject({
  requestId: z.uuid(),
  scannedValue: z.string().trim().min(1).max(500),
  outcome: returnBottleOutcomeSchema,
});
export type IdentifyReturnIssueRequest = z.infer<typeof identifyReturnIssueRequestSchema>;

export const closeOutReturnIssueRequestSchema = z.strictObject({
  requestId: z.uuid(),
  resolution: z.enum(['NOT_AYVO', 'WRITTEN_OFF']),
  reason: z.string().trim().min(3).max(500),
});
export type CloseOutReturnIssueRequest = z.infer<typeof closeOutReturnIssueRequestSchema>;

export const returnIssueKindSchema = z.enum([
  'UNREADABLE',
  'NOT_DELIVERED',
  'NOT_IN_CIRCULATION',
  'OTHER_SITE',
  'COUNT_MISMATCH',
]);
export type ReturnIssueKind = z.infer<typeof returnIssueKindSchema>;

const isoSchema = z.iso.datetime();

export const returnIssueSummarySchema = z.object({
  code: z.string(),
  kind: returnIssueKindSchema,
  receipt: z.string(),
  lineId: z.string(),
  /** Only for NOT_DELIVERED / NOT_IN_CIRCULATION (a bottle of this site). */
  bottleCode: z.string().nullable(),
  details: z.record(z.string(), z.unknown()),
  recordedAt: isoSchema,
  resolution: z.enum(['IDENTIFIED', 'NOT_AYVO', 'WRITTEN_OFF']).nullable(),
  resolvedAt: isoSchema.nullable(),
  resolutionReason: z.string().nullable(),
});
export type ReturnIssueSummary = z.infer<typeof returnIssueSummarySchema>;

export const returnIdentifiedBottleSchema = z.object({
  bottleCode: z.string(),
  outcome: z.enum(['RETURNED', 'RETIRED']),
  /** The delivered cycle's crate (may differ from the line's crate in a mixed return). */
  crateCode: z.string(),
  orderCode: z.string(),
  at: isoSchema,
  resolvesIssue: z.string().nullable(),
});
export type ReturnIdentifiedBottle = z.infer<typeof returnIdentifiedBottleSchema>;

export const returnLineDetailSchema = z.object({
  id: z.string(),
  kind: z.enum(['CRATE', 'CONTAINER']),
  crateCode: z.string().nullable(),
  orderCode: z.string().nullable(),
  hotelName: z.string().nullable(),
  scannedAt: isoSchema,
  emptiedAt: isoSchema.nullable(),
  physicalCount: z.number().int().nullable(),
  /** Pieces recorded on this line: identifications + piece issues, each piece once (§4.8). */
  recordedCount: z.number().int(),
  bottles: z.array(returnIdentifiedBottleSchema),
  issues: z.array(returnIssueSummarySchema),
  /** CRATE only — the cycle's history, information only (never compared with physicalCount). */
  history: z
    .object({
      shipped: z.number().int(),
      identified: z.number().int(),
      withoutConfirmedReturn: z.number().int(),
    })
    .nullable(),
});
export type ReturnLineDetail = z.infer<typeof returnLineDetailSchema>;

export const returnReceiptSummarySchema = z.object({
  code: z.string(),
  state: z.enum(['OPEN', 'CLOSED']),
  hotelName: z.string().nullable(),
  openedAt: isoSchema,
  closedAt: isoSchema.nullable(),
  lines: z.number().int(),
  identified: z.number().int(),
  openIssues: z.number().int(),
});
export type ReturnReceiptSummary = z.infer<typeof returnReceiptSummarySchema>;

export const returnReceiptDetailSchema = returnReceiptSummarySchema.extend({
  hotelCode: z.string().nullable(),
  defectivePumps: z.number().int(),
  lineDetails: z.array(returnLineDetailSchema),
});
export type ReturnReceiptDetail = z.infer<typeof returnReceiptDetailSchema>;

export const returnReceiptListSchema = z.object({ items: z.array(returnReceiptSummarySchema) });
export type ReturnReceiptList = z.infer<typeof returnReceiptListSchema>;

export const returnHotelOptionSchema = z.object({ code: z.string(), name: z.string() });
export type ReturnHotelOption = z.infer<typeof returnHotelOptionSchema>;

/** Bottle scan / issue identification result. An issue-recording refusal is committed (200). */
export const returnBottleScanResultSchema = z.object({
  outcome: z.enum(['IDENTIFIED', 'ISSUE_RECORDED']),
  /** IDENTIFIED: the first result of a repeated scan of the same bottle on the same line. */
  repeated: z.boolean(),
  /** ISSUE_RECORDED: why. */
  code: z.enum(['NOT_DELIVERED', 'NOT_IN_CIRCULATION', 'BOTTLE_OF_ANOTHER_SITE']).nullable(),
  bottleCode: z.string().nullable(),
  result: z.enum(['RETURNED', 'RETIRED']).nullable(),
  issue: z.object({ code: z.string(), kind: returnIssueKindSchema }).nullable(),
});
export type ReturnBottleScanResult = z.infer<typeof returnBottleScanResultSchema>;

export const returnCrateScanResultSchema = z.object({
  outcome: z.enum(['CRATE_RETURNED', 'ALREADY_SCANNED']),
  lineId: z.string(),
  crateCode: z.string(),
  orderCode: z.string(),
});
export type ReturnCrateScanResult = z.infer<typeof returnCrateScanResultSchema>;

export const returnLineResultSchema = z.object({ lineId: z.string() });
export type ReturnLineResult = z.infer<typeof returnLineResultSchema>;

export const returnIssueResultSchema = z.object({
  issue: z.object({ code: z.string(), kind: returnIssueKindSchema }),
});
export type ReturnIssueResult = z.infer<typeof returnIssueResultSchema>;

export const returnsOverviewSchema = z.object({
  waitingForWash: z.array(
    z.object({ bottleCode: z.string(), since: z.string(), receipt: z.string() }),
  ),
  openIssues: z.array(returnIssueSummarySchema),
});
export type ReturnsOverview = z.infer<typeof returnsOverviewSchema>;
