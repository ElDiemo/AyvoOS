import { z } from 'zod';
import { billingMonthSchema } from './finance-billing.js';
import { invoicePaymentStateSchema, paymentAllocationSchema } from './finance-payments.js';

/**
 * TEST invoices (N3A-2b, doc 040 §9; owner 2026-10-27): a testable chain from the hotel billing
 * settings to an invoice with its PDF and QR Platba — only outside production, only kind TEST, never
 * sent anywhere. One invoice = one customer, one currency and one month; a line per hotel agreement
 * (one line = a separate invoice, several = a summary of the same customer).
 */

export const invoiceNumberSchema = z.string().regex(/^T\d{4}-\d{5}$/);

const money = z.string();

export const invoiceSummarySchema = z.object({
  number: z.string(),
  kind: z.literal('TEST'),
  variableSymbol: z.string(),
  customer: z.object({ code: z.string(), legalName: z.string(), version: z.number().int() }),
  /** "YYYY-MM" */
  period: z.string(),
  issuedOn: z.string(),
  dueOn: z.string(),
  currency: z.string(),
  total: money,
  hotels: z.array(z.object({ code: z.string(), name: z.string() })),
  status: z.enum(['VALID', 'CANCELLED']),
  cancellation: z
    .object({ reason: z.string(), cancelledAt: z.iso.datetime(), cancelledByName: z.string() })
    .nullable(),
  issuedAt: z.iso.datetime(),
  issuedByName: z.string(),
  pdfSha256: z.string(),
  /** Derived from the allocations of incoming payments (N3B-2). */
  paymentState: invoicePaymentStateSchema,
});
export type InvoiceSummary = z.infer<typeof invoiceSummarySchema>;

/**
 * GET /api/admin/finance/invoices — an optional filter (doc 042 §3b): only the invoices with a line
 * of this hotel agreement (`invoice_lines.agreement_id`; at most one valid invoice per month).
 */
export const INVOICES_OF_HOTEL_LIMIT = 20;

export const invoiceListQuerySchema = z.object({
  agreement: z
    .string()
    .regex(/^BA-\d{6,}$/)
    .optional(),
  /** Invoices with a line of exactly this hotel, newest first, at most INVOICES_OF_HOTEL_LIMIT. */
  hotelId: z.uuid().optional(),
});
export type InvoiceListQuery = z.infer<typeof invoiceListQuerySchema>;

/**
 * GET /api/admin/finance/invoices/overview (doc 042 §3a): sums the database computes for the
 * Finance overview — no list is loaded. Valid (not cancelled) invoices still to be paid, per
 * currency; overdue = past due in Prague and not paid (as `paymentState`). Payments to review =
 * incoming payments with an amount not yet allocated; changed at the bank = recorded payments whose
 * bank transaction the bank changed since (`bankChangedSinceRecorded`, also when fully allocated) —
 * counted apart, so neither definition hides the other (review FIN90-R1).
 */
export const invoicesOverviewSchema = z.object({
  invoices: z.array(
    z.object({
      currency: z.string(),
      open: z.object({ count: z.number().int(), remaining: money }),
      overdue: z.object({ count: z.number().int(), remaining: money }),
    }),
  ),
  paymentsToReview: z.number().int(),
  paymentsChangedAtBank: z.number().int(),
});
export type InvoicesOverview = z.infer<typeof invoicesOverviewSchema>;

export const invoiceDetailSchema = invoiceSummarySchema.extend({
  lines: z.array(
    z.object({
      lineNo: z.number().int(),
      agreementCode: z.string(),
      hotel: z.object({ code: z.string(), name: z.string() }),
      billedRooms: z.number().int(),
      unitPrice: money,
      amount: money,
    }),
  ),
  allocations: z.array(paymentAllocationSchema),
  /** As printed in the PDF and its QR Platba. */
  payment: z.object({
    account: z.string().nullable(),
    iban: z.string(),
    amount: money,
    currency: z.string(),
    variableSymbol: z.string(),
    dueOn: z.string(),
  }),
});
export type InvoiceDetail = z.infer<typeof invoiceDetailSchema>;

/**
 * POST /api/admin/finance/invoices/test — a TEST invoice for agreements of one customer, bound to
 * the terms the user saw (review BILL86-R1): for each agreement the revision of its terms, the
 * customer version, the price (and the price-list version it came from) and the billed rooms of the
 * loaded preview. If anything differs when issuing, nothing is issued (409 TERMS_CHANGED).
 */
export const createTestInvoiceSchema = z.strictObject({
  requestId: z.uuid(),
  month: billingMonthSchema,
  lines: z
    .array(
      z.strictObject({
        agreementCode: z.string().regex(/^BA-\d{6,}$/),
        agreementRevision: z.number().int().min(1),
        customerVersion: z.number().int().min(1),
        priceListVersionId: z.uuid().nullable(),
        unitPrice: z.string().regex(/^\d{1,17}\.\d{2}$/),
        billedRooms: z.number().int().min(1),
      }),
    )
    .min(1)
    .max(50)
    .refine(
      (l) => new Set(l.map((x) => x.agreementCode)).size === l.length,
      'Každou smlouvu uveďte jen jednou.',
    ),
});
export type CreateTestInvoiceRequest = z.infer<typeof createTestInvoiceSchema>;

export const cancelInvoiceSchema = z.strictObject({
  requestId: z.uuid(),
  reason: z.string().trim().min(3, 'Uveďte důvod.').max(500),
});
export type CancelInvoiceRequest = z.infer<typeof cancelInvoiceSchema>;
