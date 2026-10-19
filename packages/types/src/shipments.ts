import { z } from 'zod';
import { reasonSchema } from './identity.js';
import { gramsSchema } from './weights.js';

/**
 * Dispatch to a carrier (doc 029): one shipment per completed order (the whole order together),
 * one parcel per physical crate (= one carrier label), derived automatically from the completed
 * picking. Reference weights are calculated (W1), actual weighings are optional and kept apart.
 * Nothing here means delivered; a created or downloaded PDF is not evidence of printing.
 */

export const shipmentCodeSchema = z.string().regex(/^SHP-\d{6,}$/, 'e.g. SHP-000001');
export const shipmentStatusSchema = z.enum([
  'DRAFT',
  'REQUESTING',
  'LABELED',
  'CANCELLING',
  'CANCELLED',
]);
export type ShipmentStatus = z.infer<typeof shipmentStatusSchema>;
export const carrierRequestStatusSchema = z.enum([
  'PREPARED',
  'SENT',
  'ACCEPTED',
  'CREATED',
  'SUCCEEDED',
  'REJECTED',
  'NOT_CREATED',
  'VOIDED',
]);
export type CarrierRequestStatus = z.infer<typeof carrierRequestStatusSchema>;

/** What the configured carrier needs per parcel (from its documentation, never assumed). */
export const carrierFieldRuleSchema = z.enum(['REQUIRED', 'OPTIONAL', 'NOT_USED']);
export const carrierUnavailableSchema = z.enum([
  'NOT_CONFIGURED',
  'DISABLED',
  'INCOMPLETE',
  'CREDENTIALS_MISSING',
  /** The connection an existing request used is no longer available on this server. */
  'CONNECTION_UNAVAILABLE',
]);
export const carrierInfoSchema = z.object({
  /** False: no carrier can take a new request at this site — no label can be created. */
  configured: z.boolean(),
  /** Why not (shown truthfully; never a secret). */
  unavailable: carrierUnavailableSchema.nullable(),
  code: z.string().nullable(),
  name: z.string().nullable(),
  /** TEST = the carrier's test environment (no real shipment). */
  environment: z.enum(['TEST', 'PRODUCTION']).nullable(),
  parcelWeight: carrierFieldRuleSchema.nullable(),
  parcelDimensions: carrierFieldRuleSchema.nullable(),
  /** Whether the carrier can cancel a created shipment through its interface. */
  canCancel: z.boolean(),
});
export type CarrierInfo = z.infer<typeof carrierInfoSchema>;

const dimensionsSchema = z.object({
  lengthMm: z.number().int(),
  widthMm: z.number().int(),
  heightMm: z.number().int(),
});

export const shipmentParcelSchema = z.object({
  parcelNo: z.number().int(),
  crate: z.string(),
  product: z.object({ code: z.string(), name: z.string() }),
  bottles: z.number().int(),
  /** Calculated reference of the finished package (W1) — never an actual weighing. */
  reference: z.object({
    massG: z.string().nullable(),
    source: z.enum(['HOTOVO_SNAPSHOT', 'REFERENCE_AT_SHIPMENT']).nullable(),
  }),
  /** The latest actual weighing of this parcel, if anyone weighed it. */
  actual: z
    .object({
      id: z.uuid(),
      massG: z.string(),
      recordedAt: z.iso.datetime(),
      recordedBy: z.string(),
    })
    .nullable(),
  /** The outer dimensions of the final shipping package (W1), if measured. */
  dimensions: dimensionsSchema.nullable(),
  carrierParcelNumber: z.string().nullable(),
  /** This parcel's own stored label (one crate = one parcel = one label). */
  label: z.object({ format: z.enum(['PDF', 'ZPL']), dpi: z.number().int().nullable() }).nullable(),
});
export type ShipmentParcel = z.infer<typeof shipmentParcelSchema>;

export const missingDataSchema = z.object({
  field: z.enum(['PARCEL_WEIGHT', 'PARCEL_DIMENSIONS', 'SENDER_ADDRESS']),
  parcelNo: z.number().int().nullable(),
});
export type MissingData = z.infer<typeof missingDataSchema>;

export const shipmentSchema = z.object({
  code: z.string(),
  status: shipmentStatusSchema,
  carrier: carrierInfoSchema,
  carrierShipmentRef: z.string().nullable(),
  labeledAt: z.iso.datetime().nullable(),
  parcels: z.array(shipmentParcelSchema),
  /** Data the configured carrier requires and that are not known (never sent as 0). */
  missing: z.array(missingDataSchema),
  /** The latest carrier request of this shipment. */
  request: z
    .object({
      attemptNo: z.number().int(),
      status: carrierRequestStatusSchema,
      clientReference: z.string(),
      sentAt: z.iso.datetime().nullable(),
      errorCode: z.string().nullable(),
      errorMessage: z.string().nullable(),
      /**
       * A request claimed for sending may still be in flight until then: no lookup and no
       * manual resolution before it (a lookup could miss a shipment being created right now).
       */
      resolvableAt: z.iso.datetime().nullable(),
    })
    .nullable(),
  /** The cancellation at the carrier was started (CANCELLING), by whom and why. */
  cancelRequest: z.object({ at: z.iso.datetime(), by: z.string(), reason: z.string() }).nullable(),
  /** The complete label document of the shipment, if the carrier provides one. */
  label: z
    .object({
      format: z.enum(['PDF', 'ZPL']),
      dpi: z.number().int().nullable(),
      createdAt: z.iso.datetime(),
    })
    .nullable(),
  /** Automatic checks of an accepted request ended: a person checks again ("Ověřit"). */
  pollingStopped: z.boolean(),
  createdAt: z.iso.datetime(),
});
export type Shipment = z.infer<typeof shipmentSchema>;

/** The order's dispatch: its live shipment (null before its first derivation), cancelled ones. */
export const orderShipmentSchema = z.object({
  /** The carrier configured for the active site (also before any shipment exists). */
  carrier: carrierInfoSchema,
  shipment: shipmentSchema.nullable(),
  cancelled: z.array(
    z.object({
      code: z.string(),
      cancelledAt: z.iso.datetime(),
      cancelledBy: z.string(),
      reason: z.string(),
    }),
  ),
});
export type OrderShipment = z.infer<typeof orderShipmentSchema>;

const op = { requestId: z.uuid() };
export const requestLabelsRequestSchema = z.strictObject(op);
export type RequestLabelsRequest = z.infer<typeof requestLabelsRequestSchema>;
export const resolveLabelsRequestSchema = z.strictObject(op);
export type ResolveLabelsRequest = z.infer<typeof resolveLabelsRequestSchema>;

export const weighParcelRequestSchema = z
  .strictObject({
    ...op,
    massG: gramsSchema,
    /** Replacing an earlier weighing of this parcel: it is kept, the reason is required. */
    correctionOf: z.uuid().nullable(),
    correctionReason: z.string().trim().min(3).max(500).nullable(),
  })
  .refine(
    (v) => (v.correctionOf === null) === (v.correctionReason === null),
    'A correction needs its reason',
  );
export type WeighParcelRequest = z.infer<typeof weighParcelRequestSchema>;

/** "Připraveno k vyzvednutí": the operator confirms the labels are printed and applied. */
export const readyForPickupRequestSchema = z.strictObject({
  ...op,
  labelsApplied: z.literal(true),
});
export type ReadyForPickupRequest = z.infer<typeof readyForPickupRequestSchema>;

/** "Předáno dopravci": only after the real hand-over. */
export const handOverRequestSchema = z.strictObject({ ...op, handedOver: z.literal(true) });
export type HandOverRequest = z.infer<typeof handOverRequestSchema>;

/** Cancels the preparation (never the order, never its crates). */
export const cancelShipmentRequestSchema = z.strictObject({ ...op, reason: reasonSchema });
export type CancelShipmentRequest = z.infer<typeof cancelShipmentRequestSchema>;
/** Asks the carrier again about a started cancellation (its answer was not received). */
export const resolveCancelRequestSchema = z.strictObject(op);
export type ResolveCancelRequest = z.infer<typeof resolveCancelRequestSchema>;

/**
 * Supervised resolution of an uncertain request the carrier cannot answer: a person confirms —
 * after checking with the carrier — that nothing was created. Audited with the reason.
 */
export const abandonLabelsRequestSchema = z.strictObject({ ...op, reason: reasonSchema });
export type AbandonLabelsRequest = z.infer<typeof abandonLabelsRequestSchema>;
