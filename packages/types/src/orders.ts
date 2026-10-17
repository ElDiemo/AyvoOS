import { z } from 'zod';
import { reasonSchema } from './identity.js';
import { isoDateSchema } from './procurement.js';
import { deliveryAddressSchema, hotelCodeSchema, hotelContactSchema } from './hotels.js';

/**
 * Manual orders and picking (doc 028): one hotel and delivery address per order, products in
 * whole crates (bottles = crates × the crate type's capacity, never a constant), finished crates
 * scanned into the order. "Připraveno k expedici" is the end of this slice — no carrier,
 * dispatch or delivery is recorded.
 */

export const orderCodeSchema = z.string().regex(/^OR-\d{6,}$/, 'e.g. OR-000001');
export const orderStatusSchema = z.enum(['OPEN', 'READY_TO_DISPATCH', 'CANCELLED']);
export type OrderStatus = z.infer<typeof orderStatusSchema>;

/** Overview tabs by the requested ship day in the site's time zone. */
export const orderViewSchema = z.enum(['today', 'future', 'overdue', 'closed']);
export type OrderView = z.infer<typeof orderViewSchema>;

export const createOrderRequestSchema = z.strictObject({
  requestId: z.uuid(),
  hotelCode: hotelCodeSchema,
  requestedShipDate: isoDateSchema,
  lines: z
    .array(
      z.strictObject({
        productCode: z.string().trim().min(1).max(40),
        crates: z.number().int().min(1).max(999),
      }),
    )
    .min(1)
    .max(50)
    .refine((l) => new Set(l.map((x) => x.productCode)).size === l.length, 'Each product once'),
});
export type CreateOrderRequest = z.infer<typeof createOrderRequestSchema>;

export const orderScanRequestSchema = z.strictObject({
  requestId: z.uuid(),
  scannedValue: z.string().trim().min(1).max(500),
});
export type OrderScanRequest = z.infer<typeof orderScanRequestSchema>;

export const removeOrderCrateRequestSchema = z.strictObject({
  requestId: z.uuid(),
  reason: z
    .string()
    .trim()
    .max(500)
    .nullable()
    .transform((v) => (v ? v : null)),
});
export type RemoveOrderCrateRequest = z.infer<typeof removeOrderCrateRequestSchema>;

export const completeOrderRequestSchema = z.strictObject({ requestId: z.uuid() });
export type CompleteOrderRequest = z.infer<typeof completeOrderRequestSchema>;

export const cancelOrderRequestSchema = z.strictObject({
  requestId: z.uuid(),
  reason: reasonSchema,
});
export type CancelOrderRequest = z.infer<typeof cancelOrderRequestSchema>;

const ref = z.object({ code: z.string(), name: z.string() });

export const quantitiesSchema = z.object({
  requiredCrates: z.number().int(),
  loadedCrates: z.number().int(),
  requiredBottles: z.number().int(),
  loadedBottles: z.number().int(),
});

export const orderSummarySchema = z.object({
  code: z.string(),
  hotel: ref,
  site: ref,
  requestedShipDate: isoDateSchema,
  status: orderStatusSchema,
  totals: quantitiesSchema,
  createdAt: z.iso.datetime(),
});
export type OrderSummary = z.infer<typeof orderSummarySchema>;

export const orderListSchema = z.object({
  view: orderViewSchema,
  /** "Today" in the site's time zone (YYYY-MM-DD). */
  today: isoDateSchema,
  items: z.array(orderSummarySchema),
  counts: z.record(orderViewSchema, z.number().int()),
});
export type OrderList = z.infer<typeof orderListSchema>;

export const orderLineSchema = z
  .object({
    lineNo: z.number().int(),
    product: ref,
    crateType: ref,
    capacity: z.number().int(),
  })
  .extend(quantitiesSchema.shape);
export type OrderLine = z.infer<typeof orderLineSchema>;

export const orderCrateSchema = z.object({
  crate: z.string(),
  product: ref,
  recipeVersion: z.number().int(),
  bottles: z.number().int(),
  loadedAt: z.iso.datetime(),
  loadedBy: z.string(),
});
export type OrderCrate = z.infer<typeof orderCrateSchema>;

export const orderEventSchema = z.object({
  type: z.enum(['CREATED', 'CRATE_ADDED', 'CRATE_REMOVED', 'COMPLETED', 'CANCELLED']),
  occurredAt: z.iso.datetime(),
  actor: z.string(),
  crate: z.string().nullable(),
  reason: z.string().nullable(),
});
export type OrderEvent = z.infer<typeof orderEventSchema>;

export const orderDetailSchema = orderSummarySchema.extend({
  /** Snapshot at order time — later hotel edits do not change it. */
  delivery: z.object({ hotelName: z.string() }).extend(deliveryAddressSchema.shape),
  contact: hotelContactSchema,
  lines: z.array(orderLineSchema),
  /** Crates currently loaded (active allocations). */
  crates: z.array(orderCrateSchema),
  history: z.array(orderEventSchema),
  createdBy: z.string(),
  completedAt: z.iso.datetime().nullable(),
  completedBy: z.string().nullable(),
  cancelledAt: z.iso.datetime().nullable(),
  cancelledBy: z.string().nullable(),
  cancelReason: z.string().nullable(),
});
export type OrderDetail = z.infer<typeof orderDetailSchema>;

export const orderScanResultSchema = z.object({
  outcome: z.enum(['ADDED', 'ALREADY_IN_ORDER']),
  crate: z.string(),
  product: ref,
  order: orderDetailSchema,
});
export type OrderScanResult = z.infer<typeof orderScanResultSchema>;

/** Products that can be ordered: active, with an active recipe and its crate type. */
export const orderableProductSchema = z.object({
  code: z.string(),
  name: z.string(),
  crateType: ref,
  capacity: z.number().int(),
});
export type OrderableProduct = z.infer<typeof orderableProductSchema>;
