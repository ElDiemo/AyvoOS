import {
  CarrierRejectedError,
  type CarrierPickupOutcome,
  type CarrierPickupRequest,
  type CarrierPickups,
} from '../carrier.js';
import { pplProblem, PplAuthError, type PplClient } from './ppl-client.js';
import { address, latin } from './ppl-gateway.js';

/**
 * PPL pickup orders — "Objednávka svozu" (doc 029 §11; ppl-cpl-api.apidog.io, read 2026-11-14):
 * `POST /order/batch` with one `CollectionOrder` (pickup from the account's registered address)
 * → 201, the batch id only in the `Location` header → `GET /order/batch/{batchId}`
 * (`importState` Accepted | InProcess | Complete | Error per `referenceId`) → `GET /order` by
 * `OrderReferences` (= our `referenceId`) for PPL's order number and state. A collection order
 * names no parcel numbers or labels — only `shipmentCount`; it has no recipient.
 *
 * Left open by the documentation and therefore NOT relied on: the format of `sendTimeFrom` /
 * `sendTimeTo` ("date-span", undefined) — the wished window goes only into the note; date rules
 * (cut-off, weekends); whether the sender must equal the registered address; what a repeated
 * `referenceId` does — a pickup is sent once and only looked up afterwards.
 */

/** Documented: "Počet balíků Max: 50" (the schema says int32 — the stricter value applies). */
export const PPL_PICKUP_MAX_PARCELS = 50;
const LIMITS = { referenceId: 50, customerReference: 40, note: 300, email: 100 };
const ORDER_LOOKUP_LIMIT = 50;

interface OrderBatchItem {
  referenceId?: string | null;
  importState?: string | null;
  errorCode?: string | null;
  errorMessage?: string | null;
}
interface OrderInfo {
  referenceId?: string | null;
  orderNumber?: string | null;
  orderState?: string | null;
}

/** The batch id of `POST /order/batch` from its Location header (documented as a UUID). */
export function orderBatchId(location: string | null): string | null {
  if (!location) return null;
  let path: string;
  try {
    path = new URL(location, 'http://relative.invalid').pathname;
  } catch {
    return null;
  }
  const m =
    /\/order\/batch\/([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})\/?$/.exec(
      path,
    );
  return m ? m[1]!.toLowerCase() : null;
}

export class PplPickups implements CarrierPickups {
  readonly maxParcels = PPL_PICKUP_MAX_PARCELS;

  constructor(private readonly client: PplClient) {}

  /**
   * Exactly what PPL receives, built from the pickup's stored request — the same for every look
   * at it. Refuses (nothing sent) what PPL could not take; nothing is cut.
   */
  static body(request: CarrierPickupRequest) {
    if (!Number.isInteger(request.parcelCount) || request.parcelCount < 1) {
      throw new CarrierRejectedError('PPL_PICKUP_EMPTY', 'A pickup announces at least one parcel');
    }
    if (request.parcelCount > PPL_PICKUP_MAX_PARCELS) {
      throw new CarrierRejectedError(
        'PPL_PICKUP_TOO_LARGE',
        `PPL takes at most ${PPL_PICKUP_MAX_PARCELS} parcels in one pickup order (this one has ${request.parcelCount})`,
      );
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(request.date)) {
      throw new CarrierRejectedError('PPL_PICKUP_DATE', 'The pickup day is not a date');
    }
    const s = request.settings;
    if (!s.sender) {
      throw new CarrierRejectedError('PPL_PICKUP_SENDER', 'The site has no sender address');
    }
    const note = latin(
      [
        request.pickupCode,
        request.window ? `okno ${request.window.from}-${request.window.to}` : null,
      ]
        .filter(Boolean)
        .join(', '),
    );
    const order = {
      orderType: 'CollectionOrder',
      referenceId: request.clientReference,
      customerReference: request.pickupCode,
      productType: s.service ?? undefined,
      shipmentCount: request.parcelCount,
      // `date-time` is documented without a time of day for the pickup: the local day itself.
      sendDate: `${request.date}T00:00:00`,
      note,
      email: s.sender.email?.trim() || undefined,
      // The registered address of the site (a collection order has no recipient).
      sender: address('sender', s.sender),
    };
    for (const [field, max] of Object.entries(LIMITS)) {
      const v = order[field as keyof typeof order];
      if (typeof v === 'string' && v.length > max) {
        throw new CarrierRejectedError(
          'PPL_FIELD_TOO_LONG',
          `${field}: longer than the ${max} characters PPL accepts`,
        );
      }
      if (typeof v === 'string' && /[^ -~]/.test(v)) {
        throw new CarrierRejectedError('PPL_NOT_LATIN', `${field}: characters PPL cannot take`);
      }
    }
    return { orders: [order] };
  }

  async order(request: CarrierPickupRequest, signal: AbortSignal): Promise<CarrierPickupOutcome> {
    const body = PplPickups.body(request);
    // The token first: if it cannot be had, the order was certainly not sent (a definite "no").
    try {
      await this.client.accessToken(signal);
    } catch (error) {
      if (signal.aborted) throw error;
      throw new CarrierRejectedError(
        error instanceof PplAuthError ? 'PPL_AUTH' : 'PPL_UNAVAILABLE',
        error instanceof PplAuthError
          ? 'PPL refused the server credentials; nothing was sent'
          : 'PPL could not be reached; nothing was sent',
      );
    }
    // Sent once; never repeated by the client (also not after a 401).
    const res = await this.client.request('POST', '/order/batch', {
      json: body,
      signal,
      once: true,
    });
    if (res.status === 201) {
      const id = orderBatchId(res.headers.get('location'));
      // Accepted without a usable batch id: unknown — looked up by reference, never re-sent.
      if (!id) throw new Error('PPL accepted the pickup order without a usable Location');
      return { kind: 'ACCEPTED', carrierRef: id };
    }
    if (res.status === 400) throw new CarrierRejectedError('PPL_400', pplProblem(res.body));
    if (res.status === 401 || res.status === 403) {
      throw new CarrierRejectedError(`PPL_${res.status}`, 'PPL did not accept the access token');
    }
    throw new Error(`PPL answered HTTP ${res.status}`);
  }

  async status(
    query: { clientReference: string; carrierRef: string | null },
    signal: AbortSignal,
  ): Promise<CarrierPickupOutcome> {
    if (query.carrierRef) {
      const res = await this.client.request('GET', `/order/batch/${query.carrierRef}`, { signal });
      if (res.status !== 200) {
        return { kind: 'UNKNOWN', detail: `PPL pickup batch status: HTTP ${res.status}` };
      }
      const items = (res.body as { items?: OrderBatchItem[] | null } | null)?.items ?? [];
      const item = items.find((i) => i.referenceId === query.clientReference);
      if (!item || item.importState === 'Accepted' || item.importState === 'InProcess') {
        return { kind: 'PENDING' };
      }
      if (item.importState === 'Error') {
        return {
          kind: 'REJECTED',
          code: (item.errorCode ?? 'PPL_IMPORT_ERROR').slice(0, 100),
          message: [item.errorCode, item.errorMessage].filter(Boolean).join(' ').slice(0, 900),
        };
      }
      if (item.importState !== 'Complete') {
        return { kind: 'UNKNOWN', detail: `PPL pickup import state ${String(item.importState)}` };
      }
      // Imported: PPL has the order. Its number and state come from GET /order (if readable now).
      const found = await this.lookup(query.clientReference, signal).catch(() => null);
      return {
        kind: 'CONFIRMED',
        orderNumber: found?.orderNumber ?? null,
        state: found?.orderState ?? null,
      };
    }
    // The batch id was lost: the order is found only by its own reference (OrderReferences =
    // our referenceId, documented). Not found is not proof of absence (the import is asynchronous).
    const found = await this.lookup(query.clientReference, signal);
    if (!found) {
      return {
        kind: 'UNKNOWN',
        detail: 'PPL does not show a pickup order with this reference (yet)',
      };
    }
    return {
      kind: 'CONFIRMED',
      orderNumber: found.orderNumber ?? null,
      state: found.orderState ?? null,
    };
  }

  /**
   * `POST /order/cancel?orderReference=<referenceId>` (documented: cancels a collection order or an
   * order from any address, identified by customerReference or orderReference; 200 with an empty
   * body). The 200 is taken as accepted only: the cancellation is confirmed when GET /order shows
   * the documented state `Canceled` (see {@link find}).
   */
  async cancel(query: { clientReference: string }, signal: AbortSignal): Promise<'ACCEPTED'> {
    try {
      await this.client.accessToken(signal);
    } catch (error) {
      if (signal.aborted) throw error;
      throw new CarrierRejectedError(
        error instanceof PplAuthError ? 'PPL_AUTH' : 'PPL_UNAVAILABLE',
        error instanceof PplAuthError
          ? 'PPL refused the server credentials; nothing was sent'
          : 'PPL could not be reached; nothing was sent',
      );
    }
    const res = await this.client.request('POST', '/order/cancel', {
      query: { orderReference: query.clientReference },
      json: { note: null },
      signal,
      once: true,
    });
    if (res.status === 200) return 'ACCEPTED';
    if (res.status === 400) throw new CarrierRejectedError('PPL_400', pplProblem(res.body));
    if (res.status === 401 || res.status === 403) {
      throw new CarrierRejectedError(`PPL_${res.status}`, 'PPL did not accept the access token');
    }
    throw new Error(`PPL answered HTTP ${res.status}`);
  }

  async find(query: { clientReference: string }, signal: AbortSignal) {
    const found = await this.lookup(query.clientReference, signal);
    if (!found) return null;
    return {
      orderNumber: found.orderNumber ?? null,
      state: found.orderState ?? null,
      // Documented OrderStates: None | Created | PickedUp | NotPickedUp | Canceled.
      cancelled: found.orderState === 'Canceled',
    };
  }

  /** The pickup order with exactly this reference, or null. Throws when PPL cannot answer. */
  private async lookup(reference: string, signal: AbortSignal): Promise<OrderInfo | null> {
    const res = await this.client.request('GET', '/order', {
      query: { OrderReferences: reference, Limit: ORDER_LOOKUP_LIMIT, Offset: 0 },
      signal,
    });
    if (res.status !== 200) throw new Error(`PPL order lookup: HTTP ${res.status}`);
    // Documented as an OrderModel; read as a list or a single item — matched only by reference.
    const items = Array.isArray(res.body) ? (res.body as OrderInfo[]) : [res.body as OrderInfo];
    const mine = items.filter((o) => o && o.referenceId === reference);
    return mine.length === 1 ? mine[0]! : null;
  }
}
