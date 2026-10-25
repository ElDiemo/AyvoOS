import { z } from 'zod';
import { reasonSchema } from './identity.js';
import { isoDateSchema } from './procurement.js';

/**
 * Finance — received documents (doc 039, N1): the original file (PDF/JPEG/PNG) plus the
 * accounting metadata as written on the document. No VAT computation, no payment, no posting.
 */
export const FINANCE_DOCUMENT_KINDS = [
  'INVOICE',
  'CREDIT_NOTE',
  'ADVANCE_INVOICE',
  'RECEIPT',
  'OTHER',
] as const;
export const financeDocumentKindSchema = z.enum(FINANCE_DOCUMENT_KINDS);
export type FinanceDocumentKind = z.infer<typeof financeDocumentKindSchema>;

export const financeDocumentStatusSchema = z.enum(['ACTIVE', 'VOIDED']);
export type FinanceDocumentStatus = z.infer<typeof financeDocumentStatusSchema>;

/** An amount as written: up to 2 decimals, optional sign (credit notes), "." as separator. */
export const financeAmountSchema = z
  .string()
  .trim()
  .regex(/^-?\d{1,17}(\.\d{1,2})?$/, 'Částka: číslo s nejvýše 2 desetinnými místy (tečka).');
export const currencySchema = z
  .string()
  .trim()
  .regex(/^[A-Z]{3}$/, 'Měna: tři velká písmena (např. CZK).');

const optionalDate = isoDateSchema.nullable().optional();
const optionalText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .transform((v) => (v === '' ? null : v))
    .nullable()
    .optional();

/** A handover month "YYYY-MM": which month's export for the accountant the document belongs to. */
export const handoverMonthSchema = z
  .string()
  .regex(/^\d{4}-(0[1-9]|1[0-2])$/, 'Měsíc ve tvaru RRRR-MM.');

/**
 * What a document needs before it can be exported (doc 039 §3). Until then it is "k doplnění":
 * saved and visible, never silently left out of the list.
 */
export const FINANCE_EXPORT_REQUIRED = [
  'supplierId',
  'documentNumber',
  'issuedOn',
  'handoverMonth',
] as const;
export type FinanceExportRequiredField = (typeof FINANCE_EXPORT_REQUIRED)[number];

/**
 * The editable metadata (upload, takeover and correction). Only the kind is required to save;
 * amount and currency: both or neither. A correction always sends the complete new state.
 */
const financeDocumentFieldsBase = z.object({
  supplierId: z.uuid().nullable().optional(),
  kind: financeDocumentKindSchema,
  documentNumber: optionalText(100),
  issuedOn: optionalDate,
  taxPointOn: optionalDate,
  dueOn: optionalDate,
  totalAmount: financeAmountSchema.nullable().optional(),
  currency: currencySchema.nullable().optional(),
  description: optionalText(500),
  handoverMonth: handoverMonthSchema.nullable().optional(),
});
const bothOrNeither = (f: { totalAmount?: string | null; currency?: string | null }) =>
  !f.totalAmount === !f.currency;
const amountMessage = { message: 'Částku a měnu vyplňte obě, nebo žádnou.', path: ['currency'] };

export const financeDocumentFieldsSchema = financeDocumentFieldsBase.refine(
  bothOrNeither,
  amountMessage,
);
export type FinanceDocumentFields = z.infer<typeof financeDocumentFieldsSchema>;

/** Multipart fields of POST /api/admin/finance/documents (plus the `file` part, PDF only). */
export const uploadFinanceDocumentFieldsSchema = financeDocumentFieldsBase
  .extend({ requestId: z.uuid() })
  .refine(bothOrNeither, amountMessage);
export type UploadFinanceDocumentFields = z.infer<typeof uploadFinanceDocumentFieldsSchema>;

/**
 * POST /api/admin/finance/documents/take-over: an existing supplier document of Sklad becomes a
 * finance document without a second copy of its file. Supplier, number and issue date are taken
 * from it (correctable later); the kind (default from the supplier document's kind) and the
 * handover month are chosen here.
 */
export const takeOverSupplierDocumentSchema = z.object({
  requestId: z.uuid(),
  supplierDocumentId: z.uuid(),
  kind: financeDocumentKindSchema.optional(),
  handoverMonth: handoverMonthSchema.nullable().optional(),
  description: optionalText(500),
});
export type TakeOverSupplierDocumentRequest = z.infer<typeof takeOverSupplierDocumentSchema>;

export const correctFinanceDocumentSchema = financeDocumentFieldsBase
  .extend({ expectedVersion: z.number().int().positive(), reason: reasonSchema })
  .refine(bothOrNeither, amountMessage);
export type CorrectFinanceDocumentRequest = z.infer<typeof correctFinanceDocumentSchema>;

export const voidFinanceDocumentSchema = z.object({
  expectedVersion: z.number().int().positive(),
  reason: reasonSchema,
});
export type VoidFinanceDocumentRequest = z.infer<typeof voidFinanceDocumentSchema>;

export const financeDocumentListQuerySchema = z.object({
  q: z.string().trim().max(100).optional(),
  supplierId: z.uuid().optional(),
  status: financeDocumentStatusSchema.optional(),
  handoverMonth: handoverMonthSchema.optional(),
  /** "true": only documents still missing something needed for the export. */
  incomplete: z.enum(['true']).optional(),
  issuedFrom: isoDateSchema.optional(),
  issuedTo: isoDateSchema.optional(),
  page: z.coerce.number().int().min(1).max(10_000).default(1),
});
export type FinanceDocumentListQuery = z.infer<typeof financeDocumentListQuerySchema>;

export const financeDocumentSourceSchema = z.enum(['UPLOAD', 'SUPPLIER_DOCUMENT']);
export type FinanceDocumentSource = z.infer<typeof financeDocumentSourceSchema>;

export const financeDocumentSchema = z.object({
  id: z.uuid(),
  code: z.string(),
  supplier: z.object({ id: z.uuid(), name: z.string() }).nullable(),
  kind: financeDocumentKindSchema,
  documentNumber: z.string().nullable(),
  issuedOn: isoDateSchema.nullable(),
  taxPointOn: isoDateSchema.nullable(),
  dueOn: isoDateSchema.nullable(),
  totalAmount: z.string().nullable(),
  currency: z.string().nullable(),
  description: z.string().nullable(),
  handoverMonth: handoverMonthSchema.nullable(),
  /** What is still needed for the export (empty: complete). */
  missing: z.array(z.enum(FINANCE_EXPORT_REQUIRED)),
  status: financeDocumentStatusSchema,
  version: z.number().int(),
  source: financeDocumentSourceSchema,
  /** The referenced supplier document of Sklad (source SUPPLIER_DOCUMENT) and its site. */
  supplierDocument: z.object({ id: z.uuid(), siteCode: z.string() }).nullable(),
  originalFilename: z.string(),
  contentType: z.string(),
  byteSize: z.number().int(),
  sha256: z.string(),
  createdAt: z.iso.datetime(),
  createdBy: z.string(),
});
export type FinanceDocument = z.infer<typeof financeDocumentSchema>;

export const financeDocumentEventSchema = z.object({
  version: z.number().int(),
  type: z.enum(['RECEIVED', 'CORRECTED', 'VOIDED']),
  reason: z.string().nullable(),
  actor: z.string(),
  occurredAt: z.iso.datetime(),
  /**
   * What changed against the previous version (field → [before, after]); empty for RECEIVED.
   * `supplierId` changes carry the supplier names.
   */
  changes: z.record(z.string(), z.tuple([z.unknown(), z.unknown()])),
});
export type FinanceDocumentEvent = z.infer<typeof financeDocumentEventSchema>;

export const financeDocumentDetailSchema = financeDocumentSchema.extend({
  history: z.array(financeDocumentEventSchema),
});
export type FinanceDocumentDetail = z.infer<typeof financeDocumentDetailSchema>;

export const FINANCE_PAGE_SIZE = 50;
export const financeDocumentPageSchema = z.object({
  items: z.array(financeDocumentSchema),
  total: z.number().int(),
  page: z.number().int(),
  pageSize: z.number().int(),
});
export type FinanceDocumentPage = z.infer<typeof financeDocumentPageSchema>;

/** A supplier document of Sklad that may be taken over (the user may read its site's paperwork). */
export const takeOverCandidateSchema = z.object({
  id: z.uuid(),
  supplier: z.object({ id: z.uuid(), name: z.string() }),
  kind: z.string(),
  documentNumber: z.string(),
  issuedOn: isoDateSchema,
  originalFilename: z.string(),
  byteSize: z.number().int(),
  siteCode: z.string(),
  /** A newer supplier document supersedes this one. */
  superseded: z.boolean(),
  /** The valid finance document that already took it over. */
  takenOverBy: z.string().nullable(),
});
export type TakeOverCandidate = z.infer<typeof takeOverCandidateSchema>;

/** Suppliers offered when receiving a document (names only; managed in Sklad). */
export const financeSupplierSchema = z.object({ id: z.uuid(), name: z.string() });
export type FinanceSupplier = z.infer<typeof financeSupplierSchema>;
