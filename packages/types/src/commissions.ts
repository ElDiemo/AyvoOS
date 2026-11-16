import { z } from 'zod';

/**
 * Sales commissions PR 1a (doc 068 §3.1, §4.1; ADR 0046 §2a — PROTOTYPE, the model awaits the
 * owner's approval). The commission terms of a salesperson: the initial rate %, its length N in
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
