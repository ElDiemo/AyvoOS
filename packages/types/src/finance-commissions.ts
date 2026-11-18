import { z } from 'zod';
import { commissionMonthSchema } from './commissions.js';

/**
 * The Finance commission closing (doc 069 §5; owner approved doc 069 §3–§6 and O1–O16 for the
 * first DEV version, 2026-11-18). Amounts are exact decimal strings with 2 places; a negative
 * amount is a correction or a carried balance, never an amount to invoice (§5c).
 */

/** O1: the statement mode. LIVE accepts only listed live invoice kinds — none exist yet. */
export const COMMISSION_MODES = ['TEST', 'LIVE'] as const;
export const commissionModeSchema = z.enum(COMMISSION_MODES);
export type CommissionMode = z.infer<typeof commissionModeSchema>;

/** GET /api/admin/finance/commissions/preview (finance:commissions_manage). */
export const commissionPreviewQuerySchema = z.strictObject({
  month: commissionMonthSchema,
  mode: commissionModeSchema.default('TEST'),
});
export type CommissionPreviewQuery = z.infer<typeof commissionPreviewQuerySchema>;

const money = z.string().regex(/^-?\d+\.\d{2}$/);

export const commissionItemSchema = z.object({
  kind: z.enum(['REGULAR', 'CORRECTION']),
  /** REGULAR | CANCELLED | REATTRIBUTED:<revision> (doc 069 §5b). */
  cause: z.string(),
  invoiceNumber: z.string(),
  lineNo: z.number().int(),
  hotelCode: z.string(),
  /** The billed month of the line (YYYY-MM). */
  serviceMonth: z.string(),
  base: money,
  k: z.number().int(),
  rate: z.string(),
  amount: money,
  attributionRevision: z.number().int(),
  termsVersion: z.number().int(),
});
export type CommissionItem = z.infer<typeof commissionItemSchema>;

export const COMMISSION_FLAG_CODES = [
  'TERMS_MISSING',
  'CURRENCY_UNSUPPORTED',
  'BEFORE_COMMISSION_START',
  'EARLIER_PERIOD_OPEN',
] as const;
export const commissionFlagSchema = z.object({
  code: z.enum(COMMISSION_FLAG_CODES),
  invoiceNumber: z.string(),
  hotelCode: z.string(),
  serviceMonth: z.string(),
  /** EARLIER_PERIOD_OPEN: the month the pending item or flag is due in. */
  dueMonth: z.string().nullable(),
});
export type CommissionFlag = z.infer<typeof commissionFlagSchema>;

export const commissionStatementPreviewSchema = z.object({
  salesperson: z.object({ id: z.uuid(), name: z.string() }),
  currency: z.string(),
  /** The salesperson's latest approved statement before this one (§5a), or null. */
  previousPeriod: z.string().nullable(),
  openingBalance: money,
  total: money,
  closingBalance: money,
  amountToInvoice: money,
  carriedForward: money,
  items: z.array(commissionItemSchema),
  flags: z.array(commissionFlagSchema),
  /** What the admin confirms on approval (STATEMENT_STALE otherwise). */
  fingerprint: z.string().regex(/^[0-9a-f]{64}$/),
});
export type CommissionStatementPreview = z.infer<typeof commissionStatementPreviewSchema>;

/** A line of a month ≤ M nobody gets yet: no attribution, or a month before the start. */
export const commissionUnresolvedLineSchema = z.object({
  reason: z.enum(['UNASSIGNED', 'BEFORE_COMMISSION_START']),
  invoiceNumber: z.string(),
  hotelCode: z.string(),
  serviceMonth: z.string(),
});

export const commissionPreviewSchema = z.object({
  month: z.string(),
  mode: commissionModeSchema,
  statements: z.array(commissionStatementPreviewSchema),
  unresolved: z.array(commissionUnresolvedLineSchema),
});
export type CommissionPreview = z.infer<typeof commissionPreviewSchema>;
