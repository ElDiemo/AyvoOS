import { z } from 'zod';
import { reasonSchema } from './identity.js';
import { isoDateSchema } from './procurement.js';
import { deliveryAddressSchema, hotelCodeSchema, hotelContactSchema } from './hotels.js';

/**
 * Manual orders and picking (doc 028): one hotel and delivery address per order, products in
 * whole crates (bottles = crates × the crate type's capacity, never a constant), finished crates
 * scanned into the order. Dispatch to a carrier continues on the same order (doc 029): ready for
 * pickup, handed to the carrier. Nothing here means delivered.
 */

/** Language-neutral (only the word "Objednávka / Order" is translated); never encodes a country. */
export const orderCodeSchema = z.string().regex(/^ORD-\d{6,}$/, 'e.g. ORD-000001');
export const orderStatusSchema = z.enum([
  'OPEN',
  'READY_TO_DISPATCH',
  'READY_FOR_PICKUP',
  'HANDED_TO_CARRIER',
  'CANCELLED',
]);
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

export const ORDER_PAGE_SIZE_MAX = 100;
const pageQuery = {
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(ORDER_PAGE_SIZE_MAX).default(50),
};
export const orderListQuerySchema = z.object({
  view: orderViewSchema.default('today'),
  ...pageQuery,
});
export type OrderListQuery = z.infer<typeof orderListQuerySchema>;
export const hotelOrdersQuerySchema = z.object(pageQuery);
export type HotelOrdersQuery = z.infer<typeof hotelOrdersQuerySchema>;

const pageFields = {
  items: z.array(orderSummarySchema),
  page: z.number().int(),
  pageSize: z.number().int(),
  total: z.number().int(),
};

export const orderListSchema = z.object({
  view: orderViewSchema,
  /** "Today" in the site's time zone (YYYY-MM-DD). */
  today: isoDateSchema,
  ...pageFields,
  counts: z.record(orderViewSchema, z.number().int()),
});
export type OrderList = z.infer<typeof orderListSchema>;

/** The orders of one hotel at the active site, newest first, paged. */
export const hotelOrdersSchema = z.object(pageFields);
export type HotelOrders = z.infer<typeof hotelOrdersSchema>;

/** The active site's calendar day — the only "today" the order form uses (doc 028 §2). */
export const orderCalendarSchema = z.object({
  today: isoDateSchema,
  timeZone: z.string(),
  site: z.object({ code: z.string(), name: z.string() }),
});
export type OrderCalendar = z.infer<typeof orderCalendarSchema>;
export const orderLineSchema = z
  .object({
    lineNo: z.number().int(),
    product: ref,
    crateType: ref,
    capacity: z.number().int(),
    /**
     * Pinned by the first loaded crate: every crate of the line has this recipe version and label
     * design (no mixing); null while the line is empty.
     */
    recipeVersion: z.number().int().nullable(),
    design: z.string().nullable(),
  })
  .extend(quantitiesSchema.shape);
export type OrderLine = z.infer<typeof orderLineSchema>;

export const orderCrateSchema = z.object({
  crate: z.string(),
  product: ref,
  recipeVersion: z.number().int(),
  design: z.string(),
  bottles: z.number().int(),
  loadedAt: z.iso.datetime(),
  loadedBy: z.string(),
});
export type OrderCrate = z.infer<typeof orderCrateSchema>;

export const orderEventSchema = z.object({
  type: z.enum([
    'CREATED',
    'CRATE_ADDED',
    'CRATE_REMOVED',
    'COMPLETED',
    'CANCELLED',
    'SHIPMENT_CREATED',
    'LABELS_REQUESTED',
    'LABELS_CREATED',
    'LABELS_REJECTED',
    'LABELS_UNCERTAIN',
    'LABELS_NOT_CREATED',
    'PARCEL_WEIGHED',
    'READY_FOR_PICKUP',
    'HANDED_TO_CARRIER',
    'SHIPMENT_CANCELLED',
    'SHIPMENT_CANCEL_REQUESTED',
    'SHIPMENT_CANCEL_REFUSED',
    'CARRIER_LATE_ANSWER',
    'LABEL_VARIANT_STORED',
    'LABEL_VARIANT_FAILED',
    'PRINT_REQUESTED',
    'REPRINT_REQUESTED',
    'PRINT_JOBS_CANCELLED',
  ]),
  occurredAt: z.iso.datetime(),
  actor: z.string(),
  crate: z.string().nullable(),
  reason: z.string().nullable(),
  /** Shipment events: the shipment, parcel and carrier numbers concerned (doc 029). */
  shipment: z.string().nullable(),
  parcels: z.number().int().nullable(),
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
  /** The order's live shipment (doc 029), readable with orders:read: code and status only. */
  shipment: z
    .object({
      code: z.string(),
      status: z.enum(['DRAFT', 'REQUESTING', 'LABELED', 'CANCELLING', 'CANCELLED']),
    })
    .nullable(),
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
