import { z } from 'zod';
import { currencySchema } from './finance.js';

/**
 * Incoming payments and the payment state of invoices (N3B-2, doc 041 §8; owner 2026-10-27). A
 * payment comes from a credit bank transaction already read from the bank (BANK) or from a
 * simulated statement outside production (SIMULATION); each is recorded once, so loading the same
 * entries again never counts them twice. Matching is deterministic: automatic only on an exact
 * variable symbol of one open invoice; everything else waits for a person, with its reason.
 */

const amountSchema = z
  .string()
  .trim()
  .regex(/^\d{1,17}(\.\d{1,2})?$/, 'Částka: kladné číslo s nejvýše 2 desetinnými místy (tečka).')
  .refine((v) => !/^0+(\.0+)?$/.test(v), 'Částka musí být větší než nula.');

export const PAYMENT_MATCH_RESULTS = [
  'MATCHED',
  'PARTIAL_OVERPAYMENT',
  'NO_VARIABLE_SYMBOL',
  'UNKNOWN_VARIABLE_SYMBOL',
  'CURRENCY_MISMATCH',
  'ENVIRONMENT_MISMATCH',
  'INVOICE_CANCELLED',
  'INVOICE_ALREADY_PAID',
] as const;
export const paymentMatchResultSchema = z.enum(PAYMENT_MATCH_RESULTS);

/** Derived: how much of the payment is allocated to invoices. */
export const paymentStateSchema = z.enum(['UNALLOCATED', 'PARTIALLY_ALLOCATED', 'ALLOCATED']);
/** Derived: how much of an invoice is paid (overdue = past its due date and not paid). */
export const invoicePaymentStateSchema = z.object({
  state: z.enum(['UNPAID', 'PARTIALLY_PAID', 'PAID']),
  paid: z.string(),
  remaining: z.string(),
  overdue: z.boolean(),
});
export type InvoicePaymentState = z.infer<typeof invoicePaymentStateSchema>;

export const paymentAllocationSchema = z.object({
  invoiceNumber: z.string(),
  paymentCode: z.string(),
  amount: z.string(),
  kind: z.enum(['AUTO', 'MANUAL']),
  reason: z.string().nullable(),
  recordedAt: z.iso.datetime(),
  recordedByName: z.string(),
});
export type PaymentAllocation = z.infer<typeof paymentAllocationSchema>;

export const incomingPaymentSchema = z.object({
  code: z.string(),
  source: z.enum(['BANK', 'SIMULATION']),
  environment: z.enum(['PRODUCTION', 'SANDBOX', 'TEST', 'SIMULATION']),
  reference: z.string(),
  amount: z.string(),
  currency: z.string(),
  bookedOn: z.string(),
  variableSymbol: z.string().nullable(),
  counterpartyName: z.string().nullable(),
  counterpartyAccount: z.string().nullable(),
  message: z.string().nullable(),
  matchResult: paymentMatchResultSchema,
  state: paymentStateSchema,
  allocated: z.string(),
  unallocated: z.string(),
  allocations: z.array(paymentAllocationSchema),
  /** Open invoices of the same currency whose remaining amount equals the unallocated amount —
   * a hint for a person, never applied automatically. */
  suggestions: z.array(z.string()),
  recordedAt: z.iso.datetime(),
  recordedByName: z.string(),
});
export type IncomingPayment = z.infer<typeof incomingPaymentSchema>;

export const paymentsPageSchema = z.object({
  /** Whether a simulated statement may be loaded here (never in production). */
  simulationAvailable: z.boolean(),
  payments: z.array(incomingPaymentSchema),
});
export type PaymentsPage = z.infer<typeof paymentsPageSchema>;

/** POST /api/admin/finance/payments/simulate — a simulated statement (outside production only). */
export const simulateStatementSchema = z.strictObject({
  requestId: z.uuid(),
  entries: z
    .array(
      z.strictObject({
        /** The entry's own reference: the same reference is recorded once, ever. */
        reference: z.string().regex(/^[A-Z0-9][A-Z0-9-]{2,39}$/, 'Reference: A–Z, 0–9, pomlčka.'),
        amount: amountSchema,
        currency: currencySchema,
        bookedOn: z.iso.date(),
        variableSymbol: z
          .string()
          .regex(/^\d{1,10}$/)
          .nullable(),
        counterpartyName: z.string().trim().max(200).nullable(),
        message: z.string().trim().max(500).nullable(),
      }),
    )
    .min(1)
    .max(50)
    .refine(
      (e) => new Set(e.map((x) => x.reference)).size === e.length,
      'Každá reference jen jednou.',
    ),
});
export type SimulateStatementRequest = z.infer<typeof simulateStatementSchema>;

/** The result of loading entries: what was new, what had been loaded before (never counted again). */
export const paymentLoadResultSchema = z.object({
  created: z.array(z.string()),
  alreadyLoaded: z.number().int(),
  matched: z.number().int(),
  toReview: z.number().int(),
});
export type PaymentLoadResult = z.infer<typeof paymentLoadResultSchema>;

/** POST /api/admin/finance/payments/:code/allocations — by hand, with a reason. */
export const allocatePaymentSchema = z.strictObject({
  requestId: z.uuid(),
  invoiceNumber: z.string().regex(/^T\d{4}-\d{5}$/),
  amount: amountSchema,
  reason: z.string().trim().min(3, 'Uveďte důvod.').max(500),
});
export type AllocatePaymentRequest = z.infer<typeof allocatePaymentSchema>;

export const paymentCodeSchema = z.string().regex(/^PP-\d{6,}$/);
