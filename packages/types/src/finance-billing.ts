import { z } from 'zod';
import { currencySchema } from './finance.js';
import { isoDateSchema } from './procurement.js';

/**
 * Hotel billing settings (doc 040, N3A-1; ADR 0039 §10): the billed company (customer), one
 * billing agreement per hotel with versioned terms, and the default price list. No amounts are
 * computed and no VAT, numbering or invoice exists here (N3A-2). Versions are append-only and
 * bitemporal: `effectiveFrom` = the first month the terms apply to, `recordedAt` = when they were
 * written; a correction is a new version (the newest revision wins — revisions follow the commit
 * order and are never tied).
 */

/** A price per room and month: exact decimal string, 0 or more, at most 2 decimals ("." separator). */
export const billingPriceSchema = z
  .string()
  .trim()
  .regex(
    /^\d{1,17}(\.\d{1,2})?$/,
    'Cena: číslo 0 nebo větší s nejvýše 2 desetinnými místy (tečka).',
  );

/** A billing month "YYYY-MM" (its first day is the effective date). */
export const billingMonthSchema = z
  .string()
  .regex(/^\d{4}-(0[1-9]|1[0-2])$/, 'Měsíc ve tvaru RRRR-MM.');

const reasonSchema = z.string().trim().min(1, 'Uveďte důvod.').max(500);
const text = (max: number) => z.string().trim().min(1).max(max);
const optionalText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .transform((v) => (v === '' ? null : v))
    .nullable()
    .optional()
    .transform((v) => v ?? null);

export const BILLING_TIMINGS = ['ADVANCE', 'ARREARS'] as const;
export const billingTimingSchema = z.enum(BILLING_TIMINGS);
export type BillingTiming = z.infer<typeof billingTimingSchema>;

// --- customers ------------------------------------------------------------------------------

export const billingCustomerFieldsSchema = z
  .object({
    legalName: text(200),
    /** As written (a Czech IČO: 8 digits); never an identity of a hotel. */
    companyId: optionalText(30),
    vatId: optionalText(30),
    addressLine1: text(200),
    addressLine2: optionalText(200),
    postalCode: text(20),
    city: text(100),
    countryCode: z
      .string()
      .trim()
      .regex(/^[A-Z]{2}$/, 'Země: dvě velká písmena (např. CZ).'),
    billingEmail: z.email('Neplatný e-mail pro faktury.').max(254),
  })
  .refine((c) => c.countryCode !== 'CZ' || c.companyId === null || /^\d{8}$/.test(c.companyId), {
    message: 'IČO v ČR má 8 číslic.',
    path: ['companyId'],
  });
export type BillingCustomerFields = z.infer<typeof billingCustomerFieldsSchema>;

export const createBillingCustomerSchema = z.object({
  requestId: z.uuid(),
  customer: billingCustomerFieldsSchema,
});
export type CreateBillingCustomerRequest = z.infer<typeof createBillingCustomerSchema>;

export const newBillingCustomerVersionSchema = z.object({
  requestId: z.uuid(),
  customer: billingCustomerFieldsSchema,
  reason: reasonSchema,
});
export type NewBillingCustomerVersionRequest = z.infer<typeof newBillingCustomerVersionSchema>;

export const billingCustomerVersionSchema = z.object({
  version: z.number().int(),
  customer: z.object({
    legalName: z.string(),
    companyId: z.string().nullable(),
    vatId: z.string().nullable(),
    addressLine1: z.string(),
    addressLine2: z.string().nullable(),
    postalCode: z.string(),
    city: z.string(),
    countryCode: z.string(),
    billingEmail: z.string(),
  }),
  reason: z.string().nullable(),
  recordedAt: z.iso.datetime(),
  recordedByName: z.string(),
});
export type BillingCustomerVersion = z.infer<typeof billingCustomerVersionSchema>;

export const billingCustomerSchema = z.object({
  id: z.uuid(),
  code: z.string(),
  current: billingCustomerVersionSchema,
});
export type BillingCustomer = z.infer<typeof billingCustomerSchema>;

export const billingCustomerDetailSchema = billingCustomerSchema.extend({
  versions: z.array(billingCustomerVersionSchema),
});
export type BillingCustomerDetail = z.infer<typeof billingCustomerDetailSchema>;

// --- default price list -----------------------------------------------------------------------

export const newPriceListVersionSchema = z.object({
  requestId: z.uuid(),
  currency: currencySchema,
  pricePerRoomMonth: billingPriceSchema,
  effectiveFrom: billingMonthSchema,
  reason: reasonSchema,
});
export type NewPriceListVersionRequest = z.infer<typeof newPriceListVersionSchema>;

export const priceListVersionSchema = z.object({
  id: z.uuid(),
  /** Unique, in commit order: of two versions effective the same month the higher one applies. */
  revision: z.number().int(),
  currency: z.string(),
  pricePerRoomMonth: z.string(),
  effectiveFrom: billingMonthSchema,
  reason: z.string(),
  recordedAt: z.iso.datetime(),
  recordedByName: z.string(),
});
export type PriceListVersion = z.infer<typeof priceListVersionSchema>;

// --- hotel billing agreements ---------------------------------------------------------------

export const billingAgreementTermsSchema = z
  .object({
    effectiveFrom: billingMonthSchema,
    customerId: z.uuid(),
    contractNumber: optionalText(100),
    billedRooms: z
      .number()
      .int()
      .min(1, 'Počet účtovaných pokojů musí být alespoň 1.')
      .max(100_000),
    /** null = the default price list of the currency; "0.00" is an explicit price. */
    ownPricePerRoomMonth: billingPriceSchema.nullable(),
    currency: currencySchema,
    paymentTermsDays: z.number().int().min(0).max(365),
    billingTiming: billingTimingSchema,
    validFrom: isoDateSchema,
    validTo: isoDateSchema.nullable(),
    reason: reasonSchema,
  })
  .refine((t) => t.validTo === null || t.validTo >= t.validFrom, {
    message: 'Platnost do nesmí být před platností od.',
    path: ['validTo'],
  });
export type BillingAgreementTerms = z.infer<typeof billingAgreementTermsSchema>;

export const createBillingAgreementSchema = z.object({
  requestId: z.uuid(),
  hotelId: z.uuid(),
  terms: billingAgreementTermsSchema,
});
export type CreateBillingAgreementRequest = z.infer<typeof createBillingAgreementSchema>;

export const newBillingAgreementVersionSchema = z.object({
  requestId: z.uuid(),
  terms: billingAgreementTermsSchema,
});
export type NewBillingAgreementVersionRequest = z.infer<typeof newBillingAgreementVersionSchema>;

export const billingAgreementVersionSchema = z.object({
  id: z.uuid(),
  /** Unique, in commit order: of two versions effective the same month the higher one applies. */
  revision: z.number().int(),
  effectiveFrom: billingMonthSchema,
  customer: z.object({ id: z.uuid(), code: z.string() }),
  contractNumber: z.string().nullable(),
  billedRooms: z.number().int(),
  ownPricePerRoomMonth: z.string().nullable(),
  currency: z.string(),
  paymentTermsDays: z.number().int(),
  billingTiming: billingTimingSchema,
  validFrom: isoDateSchema,
  validTo: isoDateSchema.nullable(),
  reason: z.string(),
  recordedAt: z.iso.datetime(),
  recordedByName: z.string(),
});
export type BillingAgreementVersion = z.infer<typeof billingAgreementVersionSchema>;

export const billingAgreementSchema = z.object({
  id: z.uuid(),
  code: z.string(),
  /** The core hotel (id) with its code and name as of the agreement's creation. */
  hotel: z.object({ id: z.uuid(), code: z.string(), name: z.string() }),
  createdAt: z.iso.datetime(),
  createdByName: z.string(),
});
export type BillingAgreement = z.infer<typeof billingAgreementSchema>;

export const billingAgreementDetailSchema = billingAgreementSchema.extend({
  /** Every version, newest revision first. */
  versions: z.array(billingAgreementVersionSchema),
});
export type BillingAgreementDetail = z.infer<typeof billingAgreementDetailSchema>;

// --- terms effective for a month (read only; no amounts) ------------------------------------

export const effectiveTermsQuerySchema = z.object({
  month: billingMonthSchema,
  /** Reconstruct the state as it was known at this moment (default: now). */
  asOf: z.iso.datetime().optional(),
});
export type EffectiveTermsQuery = z.infer<typeof effectiveTermsQuerySchema>;

/**
 * Why the terms of a month are not complete. They are listed for completion — a hotel is never
 * skipped silently and nothing is guessed (doc 040 §4).
 */
export const BILLING_GAPS = [
  'NO_EFFECTIVE_VERSION',
  'PRICE_MISSING',
  'PARTIAL_PERIOD_RULE_MISSING',
] as const;
export const billingGapSchema = z.enum(BILLING_GAPS);
export type BillingGap = z.infer<typeof billingGapSchema>;

export const effectiveTermsSchema = z.object({
  agreement: billingAgreementSchema,
  /** IN_EFFECT: the agreement covers the month (fully or partly); NOT_IN_EFFECT: outside its validity. */
  status: z.enum(['IN_EFFECT', 'NOT_IN_EFFECT']),
  version: billingAgreementVersionSchema.nullable(),
  customer: billingCustomerVersionSchema.extend({ id: z.uuid(), code: z.string() }).nullable(),
  price: z.object({
    source: z.enum(['OWN', 'DEFAULT', 'MISSING']),
    perRoomMonth: z.string().nullable(),
    priceListVersionId: z.uuid().nullable(),
  }),
  gaps: z.array(billingGapSchema),
});
export type EffectiveTerms = z.infer<typeof effectiveTermsSchema>;

export const effectiveTermsPageSchema = z.object({
  month: billingMonthSchema,
  asOf: z.iso.datetime(),
  items: z.array(effectiveTermsSchema),
});
export type EffectiveTermsPage = z.infer<typeof effectiveTermsPageSchema>;

// --- the core's contract: hotels (read only) ---------------------------------------------------

export const financeContractHotelSchema = z.object({
  id: z.uuid(),
  code: z.string(),
  name: z.string(),
  addressLine1: z.string(),
  addressLine2: z.string().nullable(),
  postalCode: z.string(),
  city: z.string(),
  countryCode: z.string(),
});
export type FinanceContractHotel = z.infer<typeof financeContractHotelSchema>;

export const financeHotelLookupSchema = z.object({
  ids: z.array(z.uuid()).min(1).max(500),
});
