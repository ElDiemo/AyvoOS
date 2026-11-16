/**
 * The carrier boundary (doc 029 §4). The orders module talks to a carrier only through this
 * interface; carrier calls run outside database transactions (with a time limit) and every result
 * is recorded on the shipment's carrier request. No implementation may invent numbers, labels or
 * success. A NEW request uses the site's current carrier settings; everything that follows (lookup,
 * labels, cancellation) uses the connection and environment recorded on the request — never the
 * current setting, never another environment.
 */

export type CarrierFieldRule = 'REQUIRED' | 'OPTIONAL' | 'NOT_USED';
export type CarrierEnvironment = 'TEST' | 'PRODUCTION';
export type LabelFormat = 'PDF' | 'ZPL';

export interface CarrierRules {
  /** Per-parcel weight (PPL CPL: optional; see doc 029 §5). */
  parcelWeight: CarrierFieldRule;
  /** Per-parcel outer dimensions (PPL CPL: no such field). */
  parcelDimensions: CarrierFieldRule;
  /** The sender address. */
  senderAddress: CarrierFieldRule;
  /** Whether a created shipment can be cancelled through the interface. */
  canCancel: boolean;
}

export interface CarrierAddress {
  name: string;
  addressLine1: string;
  addressLine2: string | null;
  postalCode: string;
  city: string;
  countryCode: string;
}

/** The site's carrier settings used for one request — kept with it (a snapshot). */
export interface CarrierSettingsSnapshot {
  /** The carrier's product/service code (from its code list), or null where it has none. */
  service: string | null;
  label: { format: LabelFormat; dpi: number; complete: boolean };
  sender:
    | (CarrierAddress & { contactName: string | null; phone: string | null; email: string | null })
    | null;
}

/** Exactly what is sent (stored on the request, without any secret). */
export interface CarrierShipmentRequest {
  /** Unique per attempt (the request's client reference). */
  clientReference: string;
  orderCode: string;
  settings: CarrierSettingsSnapshot;
  recipient: CarrierAddress & { contactName: string; phone: string; email: string };
  parcels: {
    parcelNo: number;
    /** The parcel's own reference: `<client reference>-<parcel no>`. */
    reference: string;
    crate: string;
    /** Grams as an exact decimal string; null when not sent. */
    weightG: string | null;
    dimensionsMm: { length: number; width: number; height: number } | null;
  }[];
}

export interface CarrierParcelNumber {
  parcelNo: number;
  number: string;
}

export type CarrierCreateOutcome =
  /**
   * Created at the carrier: its shipment reference, EVERY carrier number it created (for a
   * cancellation) and the parcels whose number is proven per parcel. Fewer proven parcels than
   * sent, or a `problem` (e.g. some parcels of a set failed), keep the request open for a person —
   * the shipment exists at the carrier and can be cancelled there.
   */
  | {
      kind: 'CREATED';
      shipmentRef: string;
      numbers: string[];
      parcels: CarrierParcelNumber[];
      problem?: { code: string; message: string };
    }
  /** Accepted for asynchronous processing (e.g. a PPL batch): poll it, never re-send. */
  | { kind: 'ACCEPTED'; carrierRef: string };

export type CarrierPollOutcome =
  | CarrierCreateOutcome
  /** Still processing. */
  | { kind: 'PENDING' }
  /** The carrier confirms that nothing was created for this request. */
  | { kind: 'NOT_CREATED' }
  | { kind: 'REJECTED'; code: string; message: string }
  /** The carrier cannot tell (e.g. no documented lookup): stays unresolved for a person. */
  | { kind: 'UNKNOWN'; detail: string };

export interface CarrierLabelFile {
  format: LabelFormat;
  dpi: number | null;
  bytes: Uint8Array;
  /** The carrier's id of this file version (e.g. PPL's data GUID), if it has one — no secret. */
  carrierRef?: string | null;
}

/**
 * CANCELLED = confirmed; NOT_CANCELLED = definitively not (e.g. already picked up) — never "not
 * yet"; PENDING = still processing; UNKNOWN = the carrier cannot tell.
 */
export type CarrierCancelStatus = 'CANCELLED' | 'PENDING' | 'NOT_CANCELLED' | 'UNKNOWN';

/**
 * What a carrier's tracking event means for AYVO (doc 031 §2), from the carrier's documented code
 * list — never guessed. Only PICKED_UP and DELIVERED change states; UNKNOWN is kept as unknown.
 */
export type TrackingMeaning =
  | 'DATA'
  | 'PICKED_UP'
  | 'IN_TRANSIT'
  | 'DELIVERED'
  | 'PICKUP_POINT'
  | 'NOT_DELIVERED'
  | 'LOST'
  | 'RETURNING'
  | 'CANCELLED'
  | 'UNKNOWN';

/** One event of one parcel as the carrier reports it (its own code, phase and time). */
export interface CarrierTrackingEvent {
  /** The carrier's numeric status (PPL: `statusId`, = `GET /codelist/status` code). */
  statusId: number | null;
  /** The carrier's textual event code (PPL: e.g. `Deleted.Cancelled`). */
  code: string | null;
  phase: string | null;
  group: string | null;
  /** The carrier's own wording (may be in another language). */
  name: string | null;
  occurredAt: Date;
  meaning: TrackingMeaning;
}

/**
 * The tracking of each asked number: `found: false` when the carrier did not return it (the
 * parcel stays as last known). Each number is answered by itself — never matched by position.
 */
export interface CarrierTracking {
  parcels: {
    number: string;
    found: boolean;
    events: CarrierTrackingEvent[];
    /** Events the carrier returned without a usable time (not stored). */
    dropped: number;
  }[];
}

/** The carrier refused the request: nothing was created / nothing changed (definitive). */
export class CarrierRejectedError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

/**
 * The carrier's answer breaks its documented contract (e.g. a label URL on a foreign host, a
 * redirect): not retried automatically — a person checks it with the carrier.
 */
export class CarrierProtocolError extends Error {}

export interface CarrierGateway {
  readonly code: string;
  readonly name: string;
  /** The server-side connection (credentials live only on the server) and its environment. */
  readonly connection: string;
  readonly environment: CarrierEnvironment;
  /** Fingerprint of the carrier account in use (never the client id). */
  readonly account: string;
  readonly rules: CarrierRules;
  /**
   * Sends the request ONCE. Resolves with what the carrier answered; throws
   * {@link CarrierRejectedError} for a definitive refusal; any other error (incl. a time-out)
   * means the outcome is unknown and the request must be looked up, never re-sent blindly.
   */
  create(request: CarrierShipmentRequest, signal: AbortSignal): Promise<CarrierCreateOutcome>;
  /** Looks up an accepted or uncertain request by its references. Read-only at the carrier. */
  poll(
    query: { clientReference: string; carrierRef: string | null; request: CarrierShipmentRequest },
    signal: AbortSignal,
  ): Promise<CarrierPollOutcome>;
  /** The labels of a created shipment: one per parcel (by number) and optionally the complete one. */
  labels(
    query: {
      shipmentRef: string;
      carrierRef: string | null;
      parcels: CarrierParcelNumber[];
      settings: CarrierSettingsSnapshot;
    },
    signal: AbortSignal,
  ): Promise<{
    parcels: (CarrierLabelFile & { parcelNo: number })[];
    complete: CarrierLabelFile | null;
  }>;
  /**
   * The SAME labels of a labelled shipment in another format (doc 030 §2) — never a new shipment,
   * never other numbers: one file per parcel, from the carrier itself (no conversion of ours).
   * Changes only the output format at the carrier; callers run at most one at a time per
   * shipment. Throws {@link CarrierProtocolError} when the carrier's answer breaks its contract;
   * any other error means "not now" (retried later).
   */
  labelVariant(
    query: {
      shipmentRef: string;
      carrierRef: string | null;
      parcels: CarrierParcelNumber[];
      format: 'ZPL';
      dpi: number;
    },
    signal: AbortSignal,
  ): Promise<{ parcels: (CarrierLabelFile & { parcelNo: number })[] }>;
  /**
   * Asks the carrier to cancel a created shipment. Idempotent: an already cancelled shipment
   * answers CANCELLED. PENDING = accepted, to be confirmed by {@link cancelStatus}.
   */
  cancel(
    query: { shipmentRef: string; parcels: string[] },
    signal: AbortSignal,
  ): Promise<'CANCELLED' | 'PENDING'>;
  cancelStatus(
    query: { shipmentRef: string; parcels: string[] },
    signal: AbortSignal,
  ): Promise<CarrierCancelStatus>;
  /**
   * Tracking of these parcel numbers (doc 031). Read-only at the carrier. Throws when the carrier
   * cannot answer completely (an outage) — the caller keeps the last known state.
   */
  track(query: { parcels: string[] }, signal: AbortSignal): Promise<CarrierTracking>;
}

export const CARRIERS = Symbol('CARRIERS');

export type CarrierChoice =
  | { gateway: CarrierGateway; settings: CarrierSettingsSnapshot }
  | {
      gateway: null;
      /** Why no new request can be made at this site (shown to the operator, no secrets). */
      reason:
        | 'NOT_CONFIGURED'
        | 'DISABLED'
        | 'INCOMPLETE'
        | 'CREDENTIALS_MISSING'
        | 'CANCELLATION_UNSUPPORTED';
    };

export interface CarrierRegistry {
  /** The carrier and settings for a NEW request at a site (doc 022 §8: configured per site). */
  forSite(siteId: string): Promise<CarrierChoice>;
  /** The carrier of an existing request: its own connection and environment, or null. */
  forConnection(ref: CarrierRef): Promise<CarrierGateway | null>;
}

/** What a shipment and its requests recorded about their carrier (ADR 0027). */
export interface CarrierRef {
  carrierCode: string;
  connection: string;
  environment: string;
  /** Fingerprint of the carrier account; null never matches a configured account. */
  account: string | null;
}
