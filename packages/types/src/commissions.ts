import { z } from 'zod';

/**
 * Sales commissions PR 1a (doc 068 §3.1, §4.1; ADR 0046 §2a). The commission terms of a salesperson: the initial rate %, its length N in
 * whole months, and the maintenance rate % from month N+1. Managed only with
 * `sales:commission_terms_manage` (ADMIN only); a salesperson reads their own terms.
 */

/**
 * A rate as typed: digits, an optional decimal point or comma, at most 2 decimals, 0–100.
 * Refused, never rounded: '20.005' and '100.01' are errors; '0' / '0.00' is an explicit rate.
 * Returns the canonical text with two decimals ('5' → '5.00'), or null when invalid.
 */
export function parseCommissionRate(input: string): string | null {
  const m = /^(\d{1,3})(?:[.,](\d{1,2}))?$/.exec(input.trim());
  if (!m) return null;
  const whole = Number(m[1]);
  const frac = (m[2] ?? '').padEnd(2, '0');
  if (whole > 100 || (whole === 100 && frac !== '00')) return null;
  return `${whole}.${frac}`;
}

/** POST sales/commission-terms — a new version of one salesperson's terms (no edit, no delete). */
export const recordCommissionTermsSchema = z.strictObject({
  requestId: z.uuid(),
  salespersonId: z.uuid(),
  /** The valid version the admin saw; 0 when the salesperson had none (else CONCURRENT_CHANGE). */
  expectedVersion: z.number().int().min(0),
  /** Checked by the server with `parseCommissionRate` (TERMS_RATE_INVALID). */
  initialRate: z.string().max(20),
  /** Whole months ≥ 1, checked by the server (TERMS_MONTHS_INVALID). */
  initialMonths: z.number(),
  maintenanceRate: z.string().max(20),
  reason: z.string().trim().min(1, 'Uveďte důvod.').max(500),
  confirm: z.literal(true, 'Potvrďte.'),
});
export type RecordCommissionTermsRequest = z.infer<typeof recordCommissionTermsSchema>;

export const commissionTermsVersionSchema = z.object({
  version: z.number().int(),
  /** Exact, two decimals ('20.00'). */
  initialRate: z.string(),
  initialMonths: z.number().int(),
  maintenanceRate: z.string(),
  reason: z.string(),
  recordedAt: z.string(),
  recordedByName: z.string(),
});
export type CommissionTermsVersion = z.infer<typeof commissionTermsVersionSchema>;

const salespersonRefSchema = z.object({ id: z.string(), name: z.string() });

/** One salesperson's terms: the valid (newest) version, or null = "Chybí podmínky provize". */
export const commissionTermsSchema = z.object({
  salesperson: salespersonRefSchema,
  valid: commissionTermsVersionSchema.nullable(),
  /** Every version, newest first. Never edited, never deleted. */
  history: z.array(commissionTermsVersionSchema),
});
export type CommissionTerms = z.infer<typeof commissionTermsSchema>;

/** GET sales/commission-terms (manage): every eligible salesperson and their valid version. */
export const commissionTermsOverviewRowSchema = z.object({
  salesperson: salespersonRefSchema,
  valid: commissionTermsVersionSchema.nullable(),
});
export type CommissionTermsOverviewRow = z.infer<typeof commissionTermsOverviewRowSchema>;
export const commissionTermsOverviewSchema = z.array(commissionTermsOverviewRowSchema);

export const commissionTermsQuerySchema = z.strictObject({
  salesperson: z.uuid().optional(),
});
export type CommissionTermsQuery = z.infer<typeof commissionTermsQuerySchema>;

// --- PR 1b: attribution of a hotel and the portfolio (doc 068 §3.2–§3.3, §4.2) ----------------

/** A service month 'YYYY-MM' (the 1st of it in the database). */
export const commissionMonthSchema = z
  .string()
  .regex(/^\d{4}-(0[1-9]|1[0-2])$/, 'Zadejte měsíc ve tvaru RRRR-MM.');

/** Commission month k of a service month, counted from the hotel's commission start (k = 1). */
export function commissionMonthNumber(commissionStart: string, month: string): number {
  const [sy, sm] = commissionStart.split('-').map(Number) as [number, number];
  const [my, mm] = month.split('-').map(Number) as [number, number];
  return (my - sy) * 12 + (mm - sm) + 1;
}

/**
 * The phase of the rate in commission month k: the initial rate for k = 1…N, the maintenance
 * rate from N+1 (doc 068 C1). k < 1 is before the commission start.
 */
export function commissionPhase(
  k: number,
  initialMonths: number,
): 'BEFORE_START' | 'INITIAL' | 'MAINTENANCE' {
  if (k < 1) return 'BEFORE_START';
  return k <= initialMonths ? 'INITIAL' : 'MAINTENANCE';
}

export const attributionSourceSchema = z.enum(['CONTRACT', 'MANUAL']);
export type AttributionSource = z.infer<typeof attributionSourceSchema>;

/**
 * POST hotels/:code/sales-attribution — a new revision (no edit, no delete). Revision 1 takes
 * `commissionStart` (the first paid month, confirmed explicitly) and is in force from it; a later
 * revision takes `effectiveFrom` and never moves the start.
 */
export const recordHotelAttributionSchema = z.strictObject({
  requestId: z.uuid(),
  /** The revision the admin saw; 0 when the hotel had none (else CONCURRENT_CHANGE). */
  expectedRevision: z.number().int().min(0),
  /** null = explicitly nobody (a house account). */
  salespersonId: z.uuid().nullable(),
  source: attributionSourceSchema,
  /** With CONTRACT: the signed draft of this hotel and its signed revision. */
  contractDraftCode: z.string().max(40).optional(),
  contractRevision: z.number().int().min(1).optional(),
  /** Revision 1 only: the first paid month. */
  commissionStart: commissionMonthSchema.optional(),
  /** Revision 1 only: the admin confirms the first paid month (COMMISSION_START_NOT_CONFIRMED). */
  confirmCommissionStart: z.boolean().optional(),
  /** Revision 2 and later: the first service month of the new salesperson. */
  effectiveFrom: commissionMonthSchema.optional(),
  reason: z.string().trim().min(1, 'Uveďte důvod.').max(500),
  confirm: z.literal(true, 'Potvrďte.'),
});
export type RecordHotelAttributionRequest = z.infer<typeof recordHotelAttributionSchema>;

const personRefSchema = z.object({ id: z.string(), name: z.string() });

/**
 * The rates bound to the hotel (the snapshot of a terms version). The rates are null when the
 * caller may not read them: only the salesperson themselves and `sales:commission_terms_manage`
 * (ADMIN) read terms (doc 068 C2).
 */
export const hotelTermsBindingSchema = z.object({
  termsVersion: z.number().int(),
  initialRate: z.string().nullable(),
  initialMonths: z.number().int().nullable(),
  maintenanceRate: z.string().nullable(),
});
export type HotelTermsBinding = z.infer<typeof hotelTermsBindingSchema>;

export const hotelAttributionRevisionSchema = z.object({
  revision: z.number().int(),
  effectiveFrom: z.string(),
  salesperson: personRefSchema.nullable(),
  source: attributionSourceSchema,
  contract: z
    .object({ draftCode: z.string(), revision: z.number().int(), startOn: z.string() })
    .nullable(),
  prospectCode: z.string().nullable(),
  prefilledSalesperson: personRefSchema.nullable(),
  commissionStart: z.string(),
  /** CONTRACT: the confirmed first paid month is not the month of the contract's start. */
  startDiffersFromContract: z.boolean(),
  reason: z.string(),
  recordedAt: z.string(),
  recordedByName: z.string(),
  /** null = "Chybí podmínky provize" (or nobody attributed). */
  binding: hotelTermsBindingSchema.nullable(),
});
export type HotelAttributionRevision = z.infer<typeof hotelAttributionRevisionSchema>;

/** A signed draft of this hotel offered as the acquisition source (the prefill). */
export const attributionCandidateSchema = z.object({
  draftCode: z.string(),
  revision: z.number().int(),
  signedOn: z.string(),
  startOn: z.string(),
  prospectCode: z.string().nullable(),
  prospectName: z.string().nullable(),
  /** The prospect's owner now, if still a salesperson; the admin may pick another. */
  prefilledSalesperson: personRefSchema.nullable(),
  /** The month of `startOn`: offered, never proof of the first paid month (doc 068 §8.3). */
  prefilledMonth: z.string(),
});
export type AttributionCandidate = z.infer<typeof attributionCandidateSchema>;

export const attributionSalespersonSchema = personRefSchema.extend({
  /** The valid terms that would be bound now; null = missing (no binding is written). */
  validTerms: hotelTermsBindingSchema.nullable(),
});

/** GET hotels/:code/sales-attribution (sales:manage + hotels:read). */
export const hotelAttributionSchema = z.object({
  hotel: z.object({ code: z.string(), name: z.string() }),
  /** The newest revision (0 = none). */
  revision: z.number().int(),
  commissionStart: z.string().nullable(),
  /** Newest first. Never edited, never deleted. */
  history: z.array(hotelAttributionRevisionSchema),
  candidates: z.array(attributionCandidateSchema),
  salespeople: z.array(attributionSalespersonSchema),
});
export type HotelAttribution = z.infer<typeof hotelAttributionSchema>;

export const portfolioQuerySchema = z.strictObject({
  month: commissionMonthSchema,
  salesperson: z.uuid().optional(),
});
export type PortfolioQuery = z.infer<typeof portfolioQuerySchema>;

/**
 * One hotel attributed for the month. No amount, invoice or payment: those come only from
 * Finance (PR 2/3, C10). `rate` is the rate of commission month k from the bound snapshot.
 */
export const portfolioRowSchema = z.object({
  hotel: z.object({ code: z.string(), name: z.string(), city: z.string() }),
  salesperson: personRefSchema.nullable(),
  since: z.string(),
  source: attributionSourceSchema,
  contractDraftCode: z.string().nullable(),
  commissionStart: z.string(),
  k: z.number().int(),
  /** NO_SALESPERSON: explicitly nobody (a house account) — manager's view only. */
  state: z.enum(['BEFORE_START', 'INITIAL', 'MAINTENANCE', 'MISSING_TERMS', 'NO_SALESPERSON']),
  rate: z.string().nullable(),
  termsVersion: z.number().int().nullable(),
});
export type PortfolioRow = z.infer<typeof portfolioRowSchema>;

/** GET sales/portfolio. A salesperson: own hotels only. A manager: also counts per person. */
export const portfolioSchema = z.object({
  month: z.string(),
  rows: z.array(portfolioRowSchema),
  /** Manager only (null otherwise): hotels per salesperson in the month. */
  totals: z
    .array(z.object({ salesperson: personRefSchema.nullable(), hotels: z.number().int() }))
    .nullable(),
});
export type Portfolio = z.infer<typeof portfolioSchema>;
