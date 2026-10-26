import { z } from 'zod';
import { isoDateSchema } from './procurement.js';

/**
 * Bank transactions of the company accounts, read from Raiffeisenbank Premium API (N3B-1,
 * doc 041). Read only: nothing is ever sent to the bank. Transactions are not paired with invoices
 * here — that comes on top of the issued-invoice model; an unpaired incoming payment is not an
 * overdue receivable. Secrets of the bank connection are never part of any answer.
 */

export const BANK_ENVIRONMENTS = ['PRODUCTION', 'SANDBOX', 'TEST'] as const;
export const bankEnvironmentSchema = z.enum(BANK_ENVIRONMENTS);
export type BankEnvironment = z.infer<typeof bankEnvironmentSchema>;

/** Why a run failed — each has a Czech explanation in the UI; the bank's raw body is never shown. */
export const BANK_SYNC_ERRORS = [
  'NOT_CONFIGURED',
  'CERTIFICATE_UNUSABLE',
  'CERTIFICATE_REJECTED',
  'INSUFFICIENT_RIGHTS',
  'ACCOUNT_NOT_FOUND',
  'REQUEST_REJECTED',
  'RATE_LIMITED',
  'BANK_UNAVAILABLE',
  'UNEXPECTED_RESPONSE',
  'TOO_MANY_PAGES',
  'TOO_MUCH_DATA',
  'ABANDONED',
] as const;
export const bankSyncErrorSchema = z.enum(BANK_SYNC_ERRORS);
export type BankSyncError = z.infer<typeof bankSyncErrorSchema>;

export const bankSyncRunSchema = z.object({
  id: z.uuid(),
  environment: bankEnvironmentSchema,
  accountNumber: z.string(),
  currency: z.string(),
  fromDate: isoDateSchema,
  toDate: isoDateSchema,
  status: z.enum(['RUNNING', 'SUCCEEDED', 'FAILED']),
  startedAt: z.iso.datetime(),
  startedByName: z.string(),
  finishedAt: z.iso.datetime().nullable(),
  pages: z.number().int().nullable(),
  received: z.number().int().nullable(),
  newCount: z.number().int().nullable(),
  changedCount: z.number().int().nullable(),
  errorCode: bankSyncErrorSchema.nullable(),
  errorDetail: z.string().nullable(),
});
export type BankSyncRun = z.infer<typeof bankSyncRunSchema>;

export const bankAccountStatusSchema = z.object({
  accountNumber: z.string(),
  currency: z.string(),
  lastRun: bankSyncRunSchema.nullable(),
  lastSuccess: bankSyncRunSchema.nullable(),
});
export type BankAccountStatus = z.infer<typeof bankAccountStatusSchema>;

/** The connection as configured on the server — names and dates only, never a secret value. */
export const bankStatusSchema = z.object({
  provider: z.literal('RB_PREMIUM'),
  /** null = no bank connection is configured in this installation. */
  environment: bankEnvironmentSchema.nullable(),
  certificate: z.object({
    state: z.enum(['NOT_CONFIGURED', 'READABLE', 'UNREADABLE']),
    /** The certificate's own expiry (the bank also blocks it yearly until it is unblocked). */
    notAfter: z.iso.datetime().nullable(),
  }),
  accounts: z.array(bankAccountStatusSchema),
  recentRuns: z.array(bankSyncRunSchema),
});
export type BankStatus = z.infer<typeof bankStatusSchema>;

export const bankTransactionListQuerySchema = z.object({
  account: z
    .string()
    .regex(/^[0-9]{1,10}\/[A-Z]{3}$/)
    .optional(),
  from: isoDateSchema.optional(),
  to: isoDateSchema.optional(),
  direction: z.enum(['CRDT', 'DBIT']).optional(),
  page: z.coerce.number().int().min(1).max(10_000).default(1),
});
export type BankTransactionListQuery = z.infer<typeof bankTransactionListQuerySchema>;

export const bankTransactionSchema = z.object({
  id: z.uuid(),
  environment: bankEnvironmentSchema,
  accountNumber: z.string(),
  currency: z.string(),
  entryReference: z.string(),
  /** > 1: the bank later sent different content for this entry; every version is kept. */
  version: z.number().int(),
  /** Exact decimal string as the bank sent it (signed). */
  amount: z.string(),
  amountCurrency: z.string(),
  creditDebit: z.enum(['CRDT', 'DBIT']),
  bookingDate: z.iso.datetime().nullable(),
  valueDate: z.iso.datetime().nullable(),
  bankTransactionCode: z.string(),
  counterparty: z.object({
    name: z.string().nullable(),
    /** National format "prefix-number/bank" when the bank gives it. */
    account: z.string().nullable(),
    iban: z.string().nullable(),
  }),
  variableSymbol: z.string().nullable(),
  constantSymbol: z.string().nullable(),
  specificSymbol: z.string().nullable(),
  message: z.string().nullable(),
  /** Not paired with anything yet: pairing comes with issued invoices (N3A-2). */
  processing: z.literal('NOT_PAIRED'),
  firstSeenAt: z.iso.datetime(),
});
export type BankTransaction = z.infer<typeof bankTransactionSchema>;

export const bankTransactionPageSchema = z.object({
  items: z.array(bankTransactionSchema),
  page: z.number().int(),
  pageSize: z.number().int(),
  total: z.number().int(),
});
export type BankTransactionPage = z.infer<typeof bankTransactionPageSchema>;

export const bankSyncResultSchema = z.object({ runs: z.array(bankSyncRunSchema) });
export type BankSyncResult = z.infer<typeof bankSyncResultSchema>;
