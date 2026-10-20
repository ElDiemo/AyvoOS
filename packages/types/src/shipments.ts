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
  /** The carrier cannot cancel through its interface: not used for new shipments (doc 029 §4). */
  'CANCELLATION_UNSUPPORTED',
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

export const labelVariantSchema = z.object({
  format: z.enum(['PDF', 'ZPL']),
  dpi: z.number().int().nullable(),
  createdAt: z.iso.datetime(),
});
export type LabelVariant = z.infer<typeof labelVariantSchema>;

/**
 * A print job (doc 030 §4): QUEUED (waiting) → CLAIMED (taken by the agent) → SENDING → SENT (all
 * bytes written to the printer — not proof of a printed label) | FAILED (proven not sent) |
 * UNCERTAIN (possibly sent, unknown); CANCELLED before sending.
 */
export const printJobStatusSchema = z.enum([
  'QUEUED',
  'CLAIMED',
  'SENDING',
  'SENT',
  'FAILED',
  'UNCERTAIN',
  'CANCELLED',
]);
export type PrintJobStatus = z.infer<typeof printJobStatusSchema>;
export const printJobViewSchema = z.object({
  code: z.string(),
  status: printJobStatusSchema,
  kind: z.enum(['SHIPMENT', 'REPRINT']),
  printer: z.string(),
  createdAt: z.iso.datetime(),
  finishedAt: z.iso.datetime().nullable(),
  detail: z.string().nullable(),
  requestedBy: z.string(),
  reason: z.string().nullable(),
});
export type PrintJobView = z.infer<typeof printJobViewSchema>;

/** The site's dispatch printer as the order needs to know it (never the agent's token). */
export const dispatchPrinterSchema = z.object({
  id: z.uuid(),
  code: z.string(),
  name: z.string(),
  model: z.string(),
  dpi: z.number().int(),
  autoPrint: z.boolean(),
  /** As the agent last reported it; null = never reported. */
  reportedState: z.enum(['READY', 'NOT_FOUND', 'ERROR']).nullable(),
  reportedAt: z.iso.datetime().nullable(),
  agent: z.object({
    code: z.string(),
    lastSeenAt: z.iso.datetime().nullable(),
    online: z.boolean(),
  }),
});
export type DispatchPrinter = z.infer<typeof dispatchPrinterSchema>;

const dimensionsSchema = z.object({
  lengthMm: z.number().int(),
  widthMm: z.number().int(),
  heightMm: z.number().int(),
});

/** What a carrier tracking event means for AYVO (doc 031 §2). */
export const trackingMeaningSchema = z.enum([
  'DATA',
  'PICKED_UP',
  'IN_TRANSIT',
  'DELIVERED',
  'PICKUP_POINT',
  'NOT_DELIVERED',
  'LOST',
  'RETURNING',
  'CANCELLED',
  'UNKNOWN',
]);
export type TrackingMeaning = z.infer<typeof trackingMeaningSchema>;

/** One carrier event of a parcel as stored: the carrier's own code and time, when AYVO fetched it. */
export const trackingEventSchema = z.object({
  statusId: z.number().int().nullable(),
  code: z.string().nullable(),
  phase: z.string().nullable(),
  name: z.string().nullable(),
  meaning: trackingMeaningSchema,
  occurredAt: z.iso.datetime(),
  fetchedAt: z.iso.datetime(),
});
export type TrackingEvent = z.infer<typeof trackingEventSchema>;

/** Where one parcel is (doc 031). */
export const parcelTrackingSchema = z.object({
  /** CARRIER = proven by its pickup event; MANUAL = an earlier manual hand-over; CARRIER_IMPLIED =
   * delivered without a pickup event (time unknown, never invented). */
  pickedUp: z
    .object({
      source: z.enum(['CARRIER', 'MANUAL', 'CARRIER_IMPLIED']),
      at: z.iso.datetime().nullable(),
    })
    .nullable(),
  deliveredAt: z.iso.datetime().nullable(),
  /** The latest carrier event (by its own time). */
  last: trackingEventSchema.nullable(),
  /** A problem the carrier reported after the last pickup/delivery step (not delivered, lost,
   * returning, at a pick-up point) — shown as a warning, never a state. */
  warning: trackingEventSchema.nullable(),
  /** The carrier did not return this number at the last successful look. */
  missing: z.boolean(),
  /** Every stored event, oldest first. */
  events: z.array(trackingEventSchema),
});
export type ParcelTracking = z.infer<typeof parcelTrackingSchema>;

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
  /** This parcel's own stored label (one crate = one parcel = one label) — its PDF if any. */
  label: z.object({ format: z.enum(['PDF', 'ZPL']), dpi: z.number().int().nullable() }).nullable(),
  /** Every stored format of this same label (doc 030 §2): PDF for preview, ZPL for printing. */
  labels: z.array(labelVariantSchema),
  /** The print jobs of this parcel's label, newest first (doc 030 §4). */
  printJobs: z.array(printJobViewSchema),
  /** Tracking (doc 031); null before the shipment is labelled. */
  tracking: parcelTrackingSchema.nullable(),
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
  /** The ZPL of the same labels for printing (doc 030 §2); null while not labelled. */
  zpl: z
    .object({
      dpi: z.number().int(),
      status: z.enum(['PENDING', 'DONE', 'FAILED']),
      attempts: z.number().int(),
      errorCode: z.string().nullable(),
      errorMessage: z.string().nullable(),
    })
    .nullable(),
  /** Print requests still waiting for the ZPL (the target printer fixed when requested). */
  printWaiting: z.array(
    z.object({
      kind: z.enum(['SHIPMENT', 'REPRINT']),
      printer: z.string(),
      parcelNo: z.number().int().nullable(),
      requestedAt: z.iso.datetime(),
    }),
  ),
  /** Automatic tracking at the carrier (doc 031); null when the shipment is not tracked. */
  tracking: z
    .object({
      pickedUp: z.number().int(),
      delivered: z.number().int(),
      parcels: z.number().int(),
      /** The last look at the carrier that succeeded (null: none yet). */
      lastSuccessAt: z.iso.datetime().nullable(),
      lastAttemptAt: z.iso.datetime().nullable(),
      /** The last look failed (outage): the last known state stays — a short reason. */
      lastError: z.string().nullable(),
      failures: z.number().int(),
      nextAt: z.iso.datetime().nullable(),
      /** DELIVERED (done), GAVE_UP (too many failures — "Obnovit tracking" resumes it). */
      stopped: z.enum(['DELIVERED', 'CANCELLED', 'GAVE_UP']).nullable(),
    })
    .nullable(),
  createdAt: z.iso.datetime(),
});
export type Shipment = z.infer<typeof shipmentSchema>;

/** The order's dispatch: its live shipment (null before its first derivation), cancelled ones. */
export const orderShipmentSchema = z.object({
  /** The carrier configured for the active site (also before any shipment exists). */
  carrier: carrierInfoSchema,
  shipment: shipmentSchema.nullable(),
  /** The site's default dispatch printer (null: none) — where printing would go now. */
  printer: dispatchPrinterSchema.nullable(),
  cancelled: z.array(
    z.object({
      code: z.string(),
      cancelledAt: z.iso.datetime(),
      cancelledBy: z.string(),
      reason: z.string(),
      /**
       * Labels of this cancelled shipment that may physically exist (a job SENT or UNCERTAIN):
       * they are invalid and must be removed from the crate or destroyed.
       */
      labelsToDestroy: z.array(
        z.object({ parcelNo: z.number().int(), crate: z.string(), number: z.string().nullable() }),
      ),
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

/** Manual "Předáno dopravci" (doc 029): only after the real hand-over; recorded as MANUAL. */
export const handOverRequestSchema = z.strictObject({ ...op, handedOver: z.literal(true) });
export type HandOverRequest = z.infer<typeof handOverRequestSchema>;

/** "Obnovit tracking": one look at the carrier now (doc 031). */
export const refreshTrackingRequestSchema = z.strictObject(op);
export type RefreshTrackingRequest = z.infer<typeof refreshTrackingRequestSchema>;

/** Cancels the preparation (never the order, never its crates). */
export const cancelShipmentRequestSchema = z.strictObject({ ...op, reason: reasonSchema });
export type CancelShipmentRequest = z.infer<typeof cancelShipmentRequestSchema>;
/** Asks the carrier again about a started cancellation (its answer was not received). */
export const resolveCancelRequestSchema = z.strictObject(op);
export type ResolveCancelRequest = z.infer<typeof resolveCancelRequestSchema>;

/**
 * "Dokončit a vytisknout štítky": completes the picking, creates the labels and prints them on the
 * printer the operator saw (`printerId`; null = labels only). A different default printer by now
 * is refused, never silently used (doc 030 §4).
 */
export const completeAndLabelRequestSchema = z.strictObject({
  ...op,
  printerId: z.uuid().nullable(),
});
export type CompleteAndLabelRequest = z.infer<typeof completeAndLabelRequestSchema>;

/** Prints every parcel label of the shipment on the printer the operator saw (doc 030 §4). */
export const printShipmentRequestSchema = z.strictObject({ ...op, printerId: z.uuid() });
export type PrintShipmentRequest = z.infer<typeof printShipmentRequestSchema>;

/** Prints ONE parcel label again: a reason; after a possibly printed job, the duplicate risk. */
export const reprintParcelRequestSchema = z.strictObject({
  ...op,
  printerId: z.uuid(),
  reason: reasonSchema,
  acknowledgeDuplicate: z.boolean(),
});
export type ReprintParcelRequest = z.infer<typeof reprintParcelRequestSchema>;

/** Fetches the ZPL of the labels again now (after a carrier outage). */
export const retryLabelVariantRequestSchema = z.strictObject(op);
export type RetryLabelVariantRequest = z.infer<typeof retryLabelVariantRequestSchema>;

export const printJobCodeSchema = z.string().regex(/^PRJ-\d{6,}$/, 'e.g. PRJ-000001');

/** Cancels a print job that has not started yet. */
export const cancelPrintJobRequestSchema = z.strictObject({ ...op, reason: reasonSchema });
export type CancelPrintJobRequest = z.infer<typeof cancelPrintJobRequestSchema>;

/**
 * Supervised resolution of an uncertain request the carrier cannot answer: a person confirms —
 * after checking with the carrier — that nothing was created. Audited with the reason.
 */
export const abandonLabelsRequestSchema = z.strictObject({ ...op, reason: reasonSchema });
export type AbandonLabelsRequest = z.infer<typeof abandonLabelsRequestSchema>;
