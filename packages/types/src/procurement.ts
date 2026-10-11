import { z } from 'zod';
import {
  decimalStringSchema,
  nonZeroDecimalSchema,
  positiveDecimalSchema,
  inventoryLotKindSchema,
} from './inventory.js';

/** Suppliers, supplier documents and goods receipts (procurement module, doc 018). */

export const supplierSchema = z.object({
  id: z.uuid(),
  name: z.string(),
  companyId: z.string().nullable(),
  vatId: z.string().nullable(),
  createdAt: z.iso.datetime(),
  archivedAt: z.iso.datetime().nullable(),
});
export type Supplier = z.infer<typeof supplierSchema>;

export const createSupplierRequestSchema = z.object({
  requestId: z.uuid(),
  name: z.string().trim().min(1).max(120),
  companyId: z.string().trim().min(1).max(32).nullable(),
  vatId: z.string().trim().min(1).max(32).nullable(),
});
export type CreateSupplierRequest = z.infer<typeof createSupplierRequestSchema>;

export const archiveSupplierRequestSchema = z.object({ requestId: z.uuid() });

export const supplierDocumentKindSchema = z.enum(['INVOICE', 'DELIVERY_NOTE', 'OTHER_APPROVED']);
export type SupplierDocumentKind = z.infer<typeof supplierDocumentKindSchema>;

/** Calendar date "YYYY-MM-DD". */
export const isoDateSchema = z.iso.date();

/** Fields of the multipart upload POST /api/admin/supplier-documents (plus a `file` part). */
export const uploadSupplierDocumentFieldsSchema = z.object({
  requestId: z.uuid(),
  supplierId: z.uuid(),
  kind: supplierDocumentKindSchema,
  documentNumber: z.string().trim().min(1).max(64),
  issuedOn: isoDateSchema,
  supersedesId: z.uuid().optional(),
});
export type UploadSupplierDocumentFields = z.infer<typeof uploadSupplierDocumentFieldsSchema>;

export const supplierDocumentSchema = z.object({
  id: z.uuid(),
  supplierId: z.uuid(),
  kind: supplierDocumentKindSchema,
  documentNumber: z.string(),
  issuedOn: isoDateSchema,
  originalFilename: z.string(),
  contentType: z.string(),
  byteSize: z.number().int(),
  supersedesId: z.uuid().nullable(),
  createdAt: z.iso.datetime(),
  /** Same-origin download URL (admin only). Storage paths never reach clients. */
  contentUrl: z.string(),
});
export type SupplierDocument = z.infer<typeof supplierDocumentSchema>;

export const goodsReceiptCodeSchema = z
  .string()
  .regex(/^GR-\d{6,}$/, 'Expected a code like GR-000001');

export const RECEIPT_LINES_MAX = 50;

/** Earliest accepted receipt date (also enforced by the database). */
export const RECEIPT_DATE_MIN = '2020-01-01T00:00:00.000Z';

/** Unit price: NUMERIC(19,4) in the database — up to 15 integer digits, 4 decimals, ≥ 0. */
export const unitPriceSchema = z
  .string()
  .trim()
  .regex(/^(0|[1-9]\d{0,14})(\.\d{1,4})?$/, 'Expected a price ≥ 0 with at most 4 decimals');
/** VAT rate in percent: NUMERIC(5,2), 0–100. */
export const vatRateSchema = z
  .string()
  .trim()
  .regex(/^(0|[1-9]\d{0,2})(\.\d{1,2})?$/, 'Expected a VAT rate with at most 2 decimals')
  .refine((v) => Number(v) <= 100, 'VAT rate must be between 0 and 100');

export const createGoodsReceiptRequestSchema = z.object({
  requestId: z.uuid(),
  supplierId: z.uuid(),
  supplierReference: z.string().trim().min(1).max(64),
  receivedAt: z.iso.datetime(),
  note: z.string().trim().max(500).nullable(),
  /** At least one INVOICE or DELIVERY_NOTE of this supplier (checked by the API and the DB). */
  documentIds: z.array(z.uuid()).min(1).max(10),
  lines: z
    .array(
      z
        .object({
          itemId: z.uuid(),
          quantity: positiveDecimalSchema,
          /** Supplier lot code; empty/null creates an internal lot for lot-tracked items. */
          supplierLotCode: z.string().trim().min(1).max(64).nullable(),
          unitPrice: unitPriceSchema.nullable(),
          currency: z
            .string()
            .regex(/^[A-Z]{3}$/)
            .nullable(),
          vatRate: vatRateSchema.nullable(),
        })
        .refine((l) => (l.unitPrice === null) === (l.currency === null), {
          message: 'Give the unit price together with its currency',
          path: ['currency'],
        })
        .refine((l) => l.vatRate === null || l.unitPrice !== null, {
          message: 'A VAT rate needs a unit price',
          path: ['vatRate'],
        }),
    )
    .min(1)
    .max(RECEIPT_LINES_MAX),
});
export type CreateGoodsReceiptRequest = z.infer<typeof createGoodsReceiptRequestSchema>;

export const goodsReceiptCorrectionSchema = z.object({
  id: z.uuid(),
  quantityDelta: decimalStringSchema,
  reason: z.string(),
  occurredAt: z.iso.datetime(),
  createdAt: z.iso.datetime(),
});

export const goodsReceiptLineSchema = z.object({
  lineNo: z.number().int(),
  item: z.object({ id: z.uuid(), code: z.string(), name: z.string(), unitCode: z.string() }),
  quantity: decimalStringSchema,
  /** quantity + Σ corrections */
  netQuantity: decimalStringSchema,
  lot: z.object({ id: z.uuid(), code: z.string(), kind: inventoryLotKindSchema }).nullable(),
  unitPrice: decimalStringSchema.nullable(),
  currency: z.string().nullable(),
  vatRate: decimalStringSchema.nullable(),
  corrections: z.array(goodsReceiptCorrectionSchema),
});

export const goodsReceiptSchema = z.object({
  code: z.string(),
  type: z.enum(['PURCHASE']),
  supplier: z.object({ id: z.uuid(), name: z.string() }),
  supplierReference: z.string(),
  receivedAt: z.iso.datetime(),
  note: z.string().nullable(),
  createdAt: z.iso.datetime(),
  /** No INVOICE linked yet: stock is available, the purchase is not financially complete. */
  invoicePending: z.boolean(),
  documents: z.array(supplierDocumentSchema.extend({ linkedAt: z.iso.datetime() })),
  lines: z.array(goodsReceiptLineSchema),
});
export type GoodsReceipt = z.infer<typeof goodsReceiptSchema>;

export const goodsReceiptSummarySchema = goodsReceiptSchema
  .pick({
    code: true,
    supplier: true,
    supplierReference: true,
    receivedAt: true,
    invoicePending: true,
  })
  .extend({ lineCount: z.number().int() });
export type GoodsReceiptSummary = z.infer<typeof goodsReceiptSummarySchema>;

export const goodsReceiptListQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(50),
  invoice: z.enum(['pending', 'any']).default('any'),
});
export type GoodsReceiptListQuery = z.infer<typeof goodsReceiptListQuerySchema>;

export const goodsReceiptPageSchema = z.object({
  items: z.array(goodsReceiptSummarySchema),
  page: z.number().int(),
  pageSize: z.number().int(),
  total: z.number().int(),
});
export type GoodsReceiptPage = z.infer<typeof goodsReceiptPageSchema>;

/** POST /api/admin/goods-receipts/:code/documents — append-only (e.g. the invoice arriving later). */
export const linkReceiptDocumentRequestSchema = z.object({
  requestId: z.uuid(),
  documentId: z.uuid(),
});
export type LinkReceiptDocumentRequest = z.infer<typeof linkReceiptDocumentRequestSchema>;

/** POST /api/admin/goods-receipts/:code/corrections — compensating, never rewrites the receipt. */
export const createReceiptCorrectionRequestSchema = z.object({
  requestId: z.uuid(),
  lineNo: z.number().int().min(1),
  quantityDelta: nonZeroDecimalSchema,
  reason: z.string().trim().min(3).max(500),
});
export type CreateReceiptCorrectionRequest = z.infer<typeof createReceiptCorrectionRequestSchema>;
