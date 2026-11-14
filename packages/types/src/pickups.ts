import { z } from 'zod';
import { orderCodeSchema, orderStatusSchema } from './orders.js';
import { shipmentCodeSchema } from './shipments.js';

/**
 * Pickup orders at the carrier — "svoz" (doc 029 §11, owner 2026-11-14). The carrier is asked to
 * collect a number of physical parcels at the site's registered sender address on a day. The
 * selected orders are the operator's plan; ordering a pickup changes no order or shipment and is
 * never a hand-over (only the carrier's tracking per parcel, or the manual hand-over, is).
 */

export const pickupCodeSchema = z.string().regex(/^SV-\d{6,}$/, 'e.g. SV-000001');
export const pickupStatusSchema = z.enum([
  'PREPARED',
  'SENT',
  'ACCEPTED',
  'CONFIRMED',
  'REJECTED',
  /** An uncertain pickup closed by a person after checking with the carrier. */
  'NOT_CREATED',
  /** Written but never sent: its day passed or its plan no longer held before sending. */
  'NOT_SENT',
]);
export const pickupCancelStatusSchema = z.enum([
  'PREPARED',
  'SENT',
  'ACCEPTED',
  'CONFIRMED',
  'REJECTED',
  /** An uncertain attempt a person closed as not carried out (after checking with the carrier). */
  'NOT_CREATED',
]);
export type PickupCancelStatus = z.infer<typeof pickupCancelStatusSchema>;
export type PickupStatus = z.infer<typeof pickupStatusSchema>;

const hhmm = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'HH:MM');
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'YYYY-MM-DD');

export const pickupWindowSchema = z
  .strictObject({ from: hhmm, to: hhmm })
  .refine((w) => w.from < w.to, 'The window ends after it starts');
export type PickupWindow = z.infer<typeof pickupWindowSchema>;

/** "Objednat svoz PPL": one explicit order for the active site. */
export const orderPickupRequestSchema = z.strictObject({
  requestId: z.uuid(),
  date: isoDate,
  window: pickupWindowSchema.nullable(),
  orders: z
    .array(orderCodeSchema)
    .min(1)
    .max(100)
    .refine((a) => new Set(a).size === a.length, 'Each order once'),
  /** The operator confirmed that the carrier will really be asked to come. */
  confirmed: z.literal(true),
});
export type OrderPickupRequest = z.infer<typeof orderPickupRequestSchema>;

/** "Zjistit stav u dopravce": a read-only lookup of a pickup at the carrier. */
export const lookupPickupRequestSchema = z.strictObject({ requestId: z.uuid() });
export type LookupPickupRequest = z.infer<typeof lookupPickupRequestSchema>;

/**
 * The exceptional closing of an uncertain pickup (its answer lost and the carrier's lookup does
 * not find it): only after the person checked with the carrier that it was not ordered.
 */
export const resolvePickupRequestSchema = z.strictObject({
  requestId: z.uuid(),
  reason: z.string().trim().min(5).max(500),
  checkedWithCarrier: z.literal(true),
});
export type ResolvePickupRequest = z.infer<typeof resolvePickupRequestSchema>;

/** "Zrušit svoz": one cancellation request at the carrier (its parcels stay blocked until confirmed). */
export const cancelPickupRequestSchema = z.strictObject({
  requestId: z.uuid(),
  reason: z.string().trim().min(5).max(500),
  confirmed: z.literal(true),
});
export type CancelPickupRequest = z.infer<typeof cancelPickupRequestSchema>;

/**
 * The exceptional closing of an uncertain cancellation attempt (its answer lost, or the carrier's
 * lookups exhausted without showing it cancelled): only after the person verified with the carrier
 * that the attempt was not carried out and will not be processed.
 */
export const resolvePickupCancelRequestSchema = z.strictObject({
  requestId: z.uuid(),
  reason: z.string().trim().min(5).max(500),
  checkedWithCarrier: z.literal(true),
});
export type ResolvePickupCancelRequest = z.infer<typeof resolvePickupCancelRequestSchema>;

export const pickupViewSchema = z.object({
  code: pickupCodeSchema,
  status: pickupStatusSchema,
  date: isoDate,
  window: z.object({ from: z.string(), to: z.string() }).nullable(),
  parcelCount: z.number().int(),
  carrier: z.object({
    code: z.string(),
    environment: z.enum(['TEST', 'PRODUCTION']),
  }),
  /** The carrier's own number of the pickup order, once it gives one. */
  carrierOrderNumber: z.string().nullable(),
  carrierState: z.string().nullable(),
  errorCode: z.string().nullable(),
  errorMessage: z.string().nullable(),
  createdAt: z.iso.datetime(),
  sentAt: z.iso.datetime().nullable(),
  resolvedAt: z.iso.datetime().nullable(),
  /** The reason a person gave when closing an uncertain pickup. */
  resolutionReason: z.string().nullable(),
  /** An uncertain pickup (answer lost) can be looked up from this time on. */
  lookupFrom: z.iso.datetime().nullable(),
  /** The latest cancellation at the carrier, if one was requested. */
  cancellation: z
    .object({
      status: pickupCancelStatusSchema,
      reason: z.string(),
      createdAt: z.iso.datetime(),
      sentAt: z.iso.datetime().nullable(),
      resolvedAt: z.iso.datetime().nullable(),
      carrierState: z.string().nullable(),
      errorCode: z.string().nullable(),
      errorMessage: z.string().nullable(),
      lookupFrom: z.iso.datetime().nullable(),
      /** Still looked up automatically (false once the bounded lookups ran out). */
      lookingUp: z.boolean(),
      /** The reason a person gave when closing an uncertain attempt. */
      resolutionReason: z.string().nullable(),
    })
    .nullable(),
  /** The plan: the concrete parcels meant to be handed over (not evidence of it). */
  parcels: z.array(
    z.object({
      orderCode: orderCodeSchema,
      shipmentCode: shipmentCodeSchema,
      hotelName: z.string(),
      parcelNo: z.number().int(),
      carrierParcelNumber: z.string(),
      /**
       * TODAY's state of this parcel (its tracking or the manual hand-over), whichever pickup — or
       * none — it went with. Never evidence that THIS pickup collected it: the carrier's physical
       * link of a pickup to its parcels is not known to AYVO.
       */
      withCarrierNow: z.boolean(),
      /** The order's state now. */
      orderStatus: orderStatusSchema,
    }),
  ),
});
export type PickupView = z.infer<typeof pickupViewSchema>;

export const pickupCandidateSchema = z.object({
  orderCode: orderCodeSchema,
  shipmentCode: shipmentCodeSchema,
  hotelName: z.string(),
  city: z.string(),
  requestedShipDate: isoDate,
  /** Parcels of the shipment and those already with the carrier (tracking or manual hand-over). */
  parcelCount: z.number().int(),
  pickedUpCount: z.number().int(),
  /** The parcels a new pickup of this order would announce now (not with the carrier, not blocked). */
  eligibleParcels: z.array(
    z.object({ parcelNo: z.number().int(), carrierParcelNumber: z.string() }),
  ),
  /** Can be planned into a new pickup now (at least one eligible parcel). */
  eligible: z.boolean(),
  /**
   * Why not: labelled with another carrier connection / environment / account than the site's
   * current one, or its remaining parcels are planned in a pickup that is pending, uncertain, for
   * today or later, or whose cancellation is not confirmed yet.
   */
  blockedBy: z.enum(['OTHER_CARRIER', 'IN_PICKUP']).nullable(),
  pickupCode: pickupCodeSchema.nullable(),
});
export type PickupCandidate = z.infer<typeof pickupCandidateSchema>;

export const pickupBoardSchema = z.object({
  /** Today in the site's time zone. */
  today: isoDate,
  carrier: z.object({
    /** The site's carrier can take a pickup order now. */
    available: z.boolean(),
    /** Why not (no carrier, incomplete settings, no pickup ordering, …). */
    reason: z.string().nullable(),
    code: z.string().nullable(),
    name: z.string().nullable(),
    environment: z.enum(['TEST', 'PRODUCTION']).nullable(),
    maxParcels: z.number().int().nullable(),
    /** The registered sender address the carrier collects at (from the site's settings). */
    sender: z
      .object({
        name: z.string(),
        street: z.string(),
        city: z.string(),
        postalCode: z.string(),
        country: z.string(),
      })
      .nullable(),
  }),
  /** Orders "Připraveno k vyzvednutí" of the active site, labelled. */
  candidates: z.array(pickupCandidateSchema),
  /** The pickup waiting for the carrier (pending or uncertain), if any — blocks a new one. */
  open: pickupViewSchema.nullable(),
  /** The latest pickups of the site, newest first. */
  pickups: z.array(pickupViewSchema),
});
export type PickupBoard = z.infer<typeof pickupBoardSchema>;
