/**
 * The carrier boundary (doc 029 §4). The orders module talks to a carrier only through this
 * interface; carrier calls run outside database transactions and every result is recorded on the
 * shipment's carrier request. No implementation may invent numbers, labels or success.
 */

export type CarrierFieldRule = 'REQUIRED' | 'OPTIONAL' | 'NOT_USED';

export interface CarrierRules {
  /** Per-parcel weight (PPL CPL: optional, mandatory towards Germany — see doc 029 §4). */
  parcelWeight: CarrierFieldRule;
  /** Per-parcel outer dimensions (PPL CPL: no such field). */
  parcelDimensions: CarrierFieldRule;
  /** The sender address (PPL CPL: optional; the registered address otherwise). */
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

/** Exactly what is sent (stored on the request, without any secret). */
export interface CarrierShipmentRequest {
  /** Unique per attempt; the only key a lost answer can be looked up by. */
  clientReference: string;
  orderCode: string;
  sender: CarrierAddress | null;
  recipient: CarrierAddress & { contactName: string; phone: string; email: string };
  parcels: {
    parcelNo: number;
    /** The crate code: what the operator finds on the parcel. */
    reference: string;
    /** Grams as an exact decimal string; null when not sent. */
    weightG: string | null;
    dimensionsMm: { length: number; width: number; height: number } | null;
  }[];
}

export type CarrierCreateOutcome =
  /** Created: the carrier's shipment reference and one number per parcel. */
  | { kind: 'CREATED'; shipmentRef: string; parcels: { parcelNo: number; number: string }[] }
  /** Accepted for asynchronous processing (e.g. a PPL batch): poll it, never re-send. */
  | { kind: 'ACCEPTED'; carrierRef: string };

export type CarrierPollOutcome =
  | CarrierCreateOutcome
  /** Still processing. */
  | { kind: 'PENDING' }
  /** The carrier confirms that nothing was created for this client reference. */
  | { kind: 'NOT_CREATED' }
  | { kind: 'REJECTED'; code: string; message: string }
  /** The carrier cannot tell (e.g. no documented lookup): stays unresolved for a person. */
  | { kind: 'UNKNOWN' };

/** The carrier refused the request: nothing was created (a definitive answer). */
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
  readonly rules: CarrierRules;
  /**
   * Sends the request ONCE. Resolves with what the carrier answered; throws
   * {@link CarrierRejectedError} for a definitive refusal; any other error means the outcome is
   * unknown (timeout, lost answer) and the request must be looked up, never re-sent blindly.
   */
  create(request: CarrierShipmentRequest): Promise<CarrierCreateOutcome>;
  /** Looks up an accepted or uncertain request by its references. Read-only at the carrier. */
  poll(query: { clientReference: string; carrierRef: string | null }): Promise<CarrierPollOutcome>;
  /** The label document of a created shipment (re-printing uses the stored copy, not this). */
  labels(query: { shipmentRef: string; carrierRef: string | null }): Promise<Uint8Array>;
  /** Cancels a created shipment; resolves only when the carrier confirmed it. */
  cancel(query: { shipmentRef: string }): Promise<void>;
}

export const CARRIERS = Symbol('CARRIERS');

/** The carrier configured for a site, or null (doc 022 §8: carriers are configured per site). */
export interface CarrierRegistry {
  forSite(siteId: string): CarrierGateway | null;
}
