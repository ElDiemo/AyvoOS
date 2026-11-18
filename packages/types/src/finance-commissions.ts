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

/**
 * POST /api/admin/finance/commissions/statements (finance:commissions_manage, doc 069 §5d) —
 * approves one salesperson's statement of a closed month exactly as previewed (the fingerprint).
 * The same requestId replays the stored result without reading the core.
 */
export const approveCommissionStatementSchema = z.strictObject({
  requestId: z.uuid(),
  month: commissionMonthSchema,
  salespersonId: z.uuid(),
  currency: z.literal('CZK'),
  mode: commissionModeSchema,
  fingerprint: z.string().regex(/^[0-9a-f]{64}$/),
});
export type ApproveCommissionStatement = z.infer<typeof approveCommissionStatementSchema>;

/** An approved statement (immutable; doc 069 §5, §5d step 5). */
export const commissionStatementSchema = z.object({
  id: z.uuid(),
  month: z.string(),
  mode: commissionModeSchema,
  salesperson: z.object({ id: z.uuid(), name: z.string() }),
  currency: z.string(),
  previousPeriod: z.string().nullable(),
  openingBalance: money,
  total: money,
  closingBalance: money,
  amountToInvoice: money,
  carriedForward: money,
  items: z.array(commissionItemSchema),
  fingerprint: z.string(),
  sourcesReadAt: z.string(),
  approvedAt: z.string(),
  approvedByName: z.string(),
  /** PR 2d: the salesperson's one invoice and the planned payout day; null until recorded. */
  salespersonInvoice: z
    .object({
      invoiceNumber: z.string(),
      issuedOn: z.string(),
      receivedOn: z.string(),
      base: money,
      currency: z.string(),
      payoutOn: z.string(),
      recordedAt: z.string(),
      recordedByName: z.string(),
    })
    .nullable(),
});
export type CommissionStatement = z.infer<typeof commissionStatementSchema>;

/** GET /api/admin/finance/commissions/statements?month=&mode= — the approved ones of a month. */
export const commissionStatementsQuerySchema = z.strictObject({
  month: commissionMonthSchema,
  mode: commissionModeSchema.default('TEST'),
});
export type CommissionStatementsQuery = z.infer<typeof commissionStatementsQuerySchema>;
export const commissionStatementListSchema = z.object({
  month: z.string(),
  mode: commissionModeSchema,
  statements: z.array(commissionStatementSchema),
});
export type CommissionStatementList = z.infer<typeof commissionStatementListSchema>;

/**
 * GET /api/admin/finance/commissions/mine?month=&mode= (sales:work, doc 069 §5d "Salesperson
 * view"): only the caller's own approved statement — its state and one amount. Never a hotel's
 * invoice number, payment or another person. Before approval: PROCESSING ("Zpracovává se").
 */
export const commissionMineQuerySchema = commissionStatementsQuerySchema;
export const COMMISSION_MINE_STATES = [
  'PROCESSING',
  'TO_INVOICE',
  'NOTHING_TO_INVOICE',
  /** PR 2d: the invoice is recorded; the payout is planned (never "Vyplaceno" here). */
  'INVOICE_RECEIVED',
] as const;
export const commissionMineSchema = z.object({
  month: z.string(),
  mode: commissionModeSchema,
  state: z.enum(COMMISSION_MINE_STATES),
  currency: z.string().nullable(),
  /** TO_INVOICE: the one amount the salesperson invoices (> 0); otherwise null. */
  amountToInvoice: money.nullable(),
  /** NOTHING_TO_INVOICE: the negative balance carried to the next statement (O13); else null. */
  balanceCarriedForward: money.nullable(),
  approvedAt: z.string().nullable(),
  /** INVOICE_RECEIVED: the planned payout day (YYYY-MM-DD); otherwise null. */
  payoutPlannedOn: z.string().nullable(),
});
export type CommissionMine = z.infer<typeof commissionMineSchema>;

/**
 * POST /api/admin/finance/commissions/statements/:id/salesperson-invoice
 * (finance:commissions_manage; doc 069 §5, doc 068 I3, C12): the salesperson's one invoice on an
 * approved statement with a positive amount to invoice — its number, dates and the base without
 * VAT (= the amount to invoice). The payout day is planned from the actual receipt; nothing is
 * paid. The same requestId replays the stored result.
 */
export const recordSalespersonInvoiceSchema = z.strictObject({
  requestId: z.uuid(),
  invoiceNumber: z.string().trim().min(1, 'Uveďte číslo faktury.').max(40),
  issuedOn: z.iso.date(),
  receivedOn: z.iso.date(),
  base: money,
  currency: z.literal('CZK'),
});
export type RecordSalespersonInvoice = z.infer<typeof recordSalespersonInvoiceSchema>;
