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
  /** Created: the carrier's shipment reference and one number per parcel, proven per parcel. */
  | { kind: 'CREATED'; shipmentRef: string; parcels: CarrierParcelNumber[] }
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
}

export type CarrierCancelStatus = 'CANCELLED' | 'PENDING' | 'NOT_CANCELLED' | 'UNKNOWN';

/** The carrier refused the request: nothing was created / nothing changed (definitive). */
export class CarrierRejectedError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export interface CarrierGateway {
  readonly code: string;
  readonly name: string;
  /** The server-side connection (credentials live only on the server) and its environment. */
  readonly connection: string;
  readonly environment: CarrierEnvironment;
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
}

export const CARRIERS = Symbol('CARRIERS');

export type CarrierChoice =
  | { gateway: CarrierGateway; settings: CarrierSettingsSnapshot }
  | {
      gateway: null;
      /** Why no new request can be made at this site (shown to the operator, no secrets). */
      reason: 'NOT_CONFIGURED' | 'DISABLED' | 'INCOMPLETE' | 'CREDENTIALS_MISSING';
    };

export interface CarrierRegistry {
  /** The carrier and settings for a NEW request at a site (doc 022 §8: configured per site). */
  forSite(siteId: string): Promise<CarrierChoice>;
  /** The carrier of an existing request: its own connection and environment, or null. */
  forConnection(ref: {
    carrierCode: string;
    connection: string;
    environment: string;
  }): CarrierGateway | null;
}
