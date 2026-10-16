import { z } from 'zod';

/**
 * Inventory foundation (doc 018): exact quantities, items, lots, stock, ledger.
 *
 * Quantities are decimal STRINGS ("12", "0.5", "-1.000") — never JavaScript numbers — with at most
 * three decimals (PostgreSQL NUMERIC(19,3)). Whether a quantity fits its unit (pieces are whole)
 * is checked by the API against the unit's decimal places, and again by the database.
 */
export const QUANTITY_DECIMALS = 3;
const DECIMAL = /^-?(0|[1-9]\d{0,15})(\.\d{1,3})?$/;

export const decimalStringSchema = z
  .string()
  .trim()
  .regex(DECIMAL, 'Expected a number with at most 3 decimals, e.g. "12" or "0.5"');
export const positiveDecimalSchema = decimalStringSchema.refine(
  (v) => !v.startsWith('-') && !/^0(\.0+)?$/.test(v),
  'Must be greater than zero',
);
export const nonNegativeDecimalSchema = decimalStringSchema.refine(
  (v) => !v.startsWith('-'),
  'Must not be negative',
);
export const nonZeroDecimalSchema = decimalStringSchema.refine(
  (v) => !/^-?0(\.0+)?$/.test(v),
  'Must not be zero',
);

export const inventoryItemKindSchema = z.enum([
  'NEW_BOTTLE',
  'PUMP',
  'LABEL_MEDIA',
  'BULK_LIQUID',
  'PACKAGING',
  'COMPONENT',
]);
export type InventoryItemKind = z.infer<typeof inventoryItemKindSchema>;

export const inventoryUnitSchema = z.object({
  code: z.string(),
  name: z.string(),
  decimalPlaces: z.number().int().min(0).max(3),
});
export type InventoryUnit = z.infer<typeof inventoryUnitSchema>;

export const inventoryItemSettingsSchema = z.object({
  version: z.number().int().positive(),
  reorderPoint: decimalStringSchema.nullable(),
  targetLevel: decimalStringSchema.nullable(),
  preferredSupplier: z.object({ id: z.uuid(), name: z.string() }).nullable(),
  leadTimeDays: z.number().int().nullable(),
  purchaseMultiple: decimalStringSchema.nullable(),
  validFrom: z.iso.datetime(),
});
export type InventoryItemSettings = z.infer<typeof inventoryItemSettingsSchema>;

export const inventoryItemSchema = z.object({
  id: z.uuid(),
  /** Language-neutral SKU, e.g. "NEW_BOTTLE". */
  code: z.string(),
  name: z.string(),
  kind: inventoryItemKindSchema,
  unit: inventoryUnitSchema,
  lotTracked: z.boolean(),
  archivedAt: z.iso.datetime().nullable(),
  settings: inventoryItemSettingsSchema.nullable(),
});
export type InventoryItem = z.infer<typeof inventoryItemSchema>;

export const inventoryItemCodeSchema = z.string().regex(/^[A-Z0-9][A-Z0-9_-]{1,39}$/);

/** POST /api/admin/inventory/items/:code/settings — appends a new settings version. */
export const updateItemSettingsRequestSchema = z.object({
  requestId: z.uuid(),
  reorderPoint: nonNegativeDecimalSchema.nullable(),
  targetLevel: nonNegativeDecimalSchema.nullable(),
  preferredSupplierId: z.uuid().nullable(),
  leadTimeDays: z.number().int().min(0).max(365).nullable(),
  purchaseMultiple: positiveDecimalSchema.nullable(),
});
export type UpdateItemSettingsRequest = z.infer<typeof updateItemSettingsRequestSchema>;

export const inventoryLotKindSchema = z.enum(['SUPPLIER', 'INTERNAL']);

export const inventoryLotSchema = z.object({
  id: z.uuid(),
  /** Supplier lot code, or "GR-000001/1" for an internal lot. */
  code: z.string(),
  kind: inventoryLotKindSchema,
  supplier: z.object({ id: z.uuid(), name: z.string() }).nullable(),
  onHand: decimalStringSchema,
  createdAt: z.iso.datetime(),
});
export type InventoryLot = z.infer<typeof inventoryLotSchema>;

/**
 * Stock of one item at one location. on hand = Σ ledger; reserved is 0 until reservations exist;
 * on order is not tracked yet (null); the suggestion is advisory — nothing is ever ordered.
 */
export const stockItemSchema = z.object({
  item: inventoryItemSchema,
  onHand: decimalStringSchema,
  reserved: decimalStringSchema,
  available: decimalStringSchema,
  onOrder: decimalStringSchema.nullable(),
  lowStock: z.boolean(),
  suggestedQuantity: decimalStringSchema.nullable(),
  lots: z.array(inventoryLotSchema),
});
export type StockItem = z.infer<typeof stockItemSchema>;

export const stockOverviewSchema = z.object({
  location: z.object({ code: z.string(), name: z.string() }),
  items: z.array(stockItemSchema),
});
export type StockOverview = z.infer<typeof stockOverviewSchema>;

/**
 * GET /api/admin/inventory/stock-summary — availability for planning (SALES, doc 021): item,
 * available, reserved and the low-stock flag only. No lots, suppliers, prices, documents,
 * receipts, corrections or movements.
 */
export const stockSummarySchema = z.object({
  location: z.object({ code: z.string(), name: z.string() }),
  items: z.array(
    z.strictObject({
      item: z.strictObject({ code: z.string(), name: z.string(), unitCode: z.string() }),
      available: decimalStringSchema,
      reserved: decimalStringSchema,
      lowStock: z.boolean(),
    }),
  ),
});
export type StockSummary = z.infer<typeof stockSummarySchema>;

export const inventoryMovementTypeSchema = z.enum([
  'RECEIPT',
  'RECEIPT_CORRECTION',
  'LABEL_APPLICATION',
  'FILL',
]);
export type InventoryMovementType = z.infer<typeof inventoryMovementTypeSchema>;

/** One ledger row with a readable description of its source. */
export const inventoryMovementSchema = z.object({
  id: z.uuid(),
  type: inventoryMovementTypeSchema,
  item: z.object({ code: z.string(), name: z.string(), unitCode: z.string() }),
  lot: z.object({ id: z.uuid(), code: z.string() }).nullable(),
  quantityDelta: decimalStringSchema,
  balanceAfter: decimalStringSchema,
  occurredAt: z.iso.datetime(),
  recordedAt: z.iso.datetime(),
  source: z.object({
    receiptCode: z.string().nullable(),
    receiptLineNo: z.number().int().nullable(),
    correctionReason: z.string().nullable(),
    bottleCode: z.string().nullable(),
  }),
});
export type InventoryMovement = z.infer<typeof inventoryMovementSchema>;

export const inventoryMovementPageSchema = z.object({
  items: z.array(inventoryMovementSchema),
  page: z.number().int(),
  pageSize: z.number().int(),
  total: z.number().int(),
});
export type InventoryMovementPage = z.infer<typeof inventoryMovementPageSchema>;

export const movementListQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(50),
  item: inventoryItemCodeSchema.optional(),
  lotId: z.uuid().optional(),
});
export type MovementListQuery = z.infer<typeof movementListQuerySchema>;
