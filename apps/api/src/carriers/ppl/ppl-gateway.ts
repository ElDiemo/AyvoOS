import {
  CarrierRejectedError,
  type CarrierAddress,
  type CarrierCancelStatus,
  type CarrierCreateOutcome,
  type CarrierGateway,
  type CarrierParcelNumber,
  type CarrierPollOutcome,
  type CarrierRules,
  type CarrierSettingsSnapshot,
  type CarrierShipmentRequest,
} from '../carrier.js';
import { pplProblem, type PplClient } from './ppl-client.js';

/**
 * PPL CPL API adapter (doc 029 §5; ppl-cpl-api.apidog.io, read 2026-10-19). Asynchronous: a batch
 * is accepted (201, its id only in the Location header — stored at once) and polled until
 * `Complete`/`Error`. One AYVO order = one PPL shipment; several crates = a PPL shipment set whose
 * items each carry their own `CUST` external number (= our parcel reference). Parcel numbers are
 * mapped to crates only through that reference as returned by `GET /shipment` — never by position.
 * Weights are not sent while their unit is undocumented; no dimensions exist in the API.
 */

const lat = (s: string | null | undefined) =>
  s ? s.normalize('NFD').replace(/[̀-ͯ]/g, '') : undefined;
/** Field lengths documented for the PPL address model. */
const cut = (s: string | null | undefined, max: number) => lat(s)?.slice(0, max);

function address(
  a: CarrierAddress & { contactName?: string | null; phone?: string | null; email?: string | null },
) {
  return {
    name: cut(a.name, 50),
    street: cut([a.addressLine1, a.addressLine2].filter(Boolean).join(', '), 60),
    city: cut(a.city, 50),
    zipCode: cut(a.postalCode.replace(/\s+/g, ''), 10),
    country: a.countryCode,
    contact: cut(a.contactName ?? null, 50),
    phone: cut(a.phone ?? null, 30),
    email: a.email ? a.email.slice(0, 50) : undefined,
  };
}

const PICKED_UP = new Set([
  'PickedUpFromSender',
  'OutForDelivery',
  'Delivered',
  'DeliveredToPickupPoint',
  'NotDelivered',
  'Undelivered',
  'BackToSender',
]);

interface BatchItem {
  referenceId?: string | null;
  shipmentNumber?: string | null;
  importState?: string | null;
  errorCode?: string | null;
  errorMessage?: string | null;
  labelUrl?: string | null;
  relatedItems?: {
    shipmentNumber?: string | null;
    importState?: string | null;
    errorCode?: string | null;
    errorMessage?: string | null;
    labelUrl?: string | null;
    relationType?: string | null;
  }[];
}
interface BatchStatus {
  items?: BatchItem[];
  completeLabel?: { labelUrls?: string[] } | null;
}
interface ShipmentInfo {
  shipmentNumber?: string | null;
  shipmentState?: string | null;
  externalNumbers?: { code?: string | null; externalNumber?: string | null }[];
}

export class PplGateway implements CarrierGateway {
  readonly code = 'PPL';
  readonly name: string;
  readonly connection: string;
  readonly environment: 'TEST' | 'PRODUCTION';
  readonly rules: CarrierRules = {
    // The weight unit is not documented: nothing is sent until PPL confirms it (doc 029 §5).
    parcelWeight: 'NOT_USED',
    parcelDimensions: 'NOT_USED',
    senderAddress: 'REQUIRED',
    canCancel: true,
  };

  constructor(private readonly client: PplClient) {
    this.connection = client.connection.code;
    this.environment = client.connection.environment;
    this.name = this.environment === 'TEST' ? 'PPL (testovací prostředí)' : 'PPL';
  }

  /** The batch request (exactly what PPL receives; stored with the attempt as its payload). */
  static batch(request: CarrierShipmentRequest) {
    const s = request.settings;
    const set = request.parcels.length > 1;
    return {
      labelSettings: {
        format: s.label.format === 'ZPL' ? 'Zpl' : 'Pdf',
        dpi: s.label.dpi,
        ...(s.label.complete
          ? {
              completeLabelSettings: {
                isCompleteLabelRequested: true,
                pageSize: 'A4',
                position: 1,
              },
            }
          : {}),
      },
      shipments: [
        {
          referenceId: request.clientReference,
          productType: s.service,
          note: lat(request.orderCode),
          sender: s.sender ? address(s.sender) : undefined,
          recipient: address(request.recipient),
          externalNumbers: [{ code: 'CUST', externalNumber: request.clientReference }],
          ...(set
            ? {
                shipmentSet: {
                  numberOfShipments: request.parcels.length,
                  shipmentSetItems: request.parcels.map((p) => ({
                    externalNumbers: [{ code: 'CUST', externalNumber: p.reference }],
                  })),
                },
              }
            : {}),
        },
      ],
    };
  }

  async create(
    request: CarrierShipmentRequest,
    signal: AbortSignal,
  ): Promise<CarrierCreateOutcome> {
    if (!request.settings.service)
      throw new CarrierRejectedError('PPL_NO_PRODUCT', 'No PPL product');
    const res = await this.client.request('POST', '/shipment/batch', {
      json: PplGateway.batch(request),
      signal,
    });
    if (res.status === 201) {
      const id = /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\/?$/i.exec(
        res.headers.get('location') ?? '',
      )?.[1];
      // Accepted but no batch id: the outcome cannot be followed — unknown, never re-sent.
      if (!id) throw new Error('PPL accepted the batch without a usable Location');
      return { kind: 'ACCEPTED', carrierRef: id };
    }
    // A validation refusal: nothing was created.
    if (res.status === 400) throw new CarrierRejectedError('PPL_400', pplProblem(res.body));
    throw new Error(`PPL answered HTTP ${res.status}`);
  }

  async poll(
    query: { clientReference: string; carrierRef: string | null; request: CarrierShipmentRequest },
    signal: AbortSignal,
  ): Promise<CarrierPollOutcome> {
    if (!query.carrierRef) {
      return {
        kind: 'UNKNOWN',
        detail:
          'PPL: the batch id is unknown and PPL documents no lookup by reference — check with PPL',
      };
    }
    const res = await this.client.request('GET', `/shipment/batch/${query.carrierRef}`, { signal });
    if (res.status !== 200) {
      return { kind: 'UNKNOWN', detail: `PPL batch status: HTTP ${res.status}` };
    }
    const item = ((res.body as BatchStatus).items ?? []).find(
      (i) => i.referenceId === query.clientReference,
    );
    if (!item) return { kind: 'PENDING' };
    const set = (item.relatedItems ?? []).filter((r) => r.relationType === 'ShipmentSet');
    const states = [item.importState, ...set.map((r) => r.importState)];
    if (states.some((st) => st === 'Accepted' || st === 'InProcess')) return { kind: 'PENDING' };
    const numbers = [item.shipmentNumber, ...set.map((r) => r.shipmentNumber)].filter(
      (n): n is string => !!n,
    );
    const failed = [item, ...set].filter((x) => x.importState === 'Error');
    if (failed.length > 0) {
      const message = failed
        .map((f) => [f.errorCode, f.errorMessage].filter(Boolean).join(' '))
        .join('; ')
        .slice(0, 900);
      // Nothing created → refused; some parcels created → open, to be cancelled at PPL.
      if (numbers.length === 0) {
        return { kind: 'REJECTED', code: item.errorCode ?? 'PPL_IMPORT_ERROR', message };
      }
      return {
        kind: 'CREATED',
        shipmentRef: item.shipmentNumber ?? numbers[0]!,
        numbers,
        parcels: [],
        problem: { code: 'CARRIER_PARTIAL', message: `PPL created only some parcels: ${message}` },
      };
    }
    if (!item.shipmentNumber) return { kind: 'PENDING' };
    return {
      kind: 'CREATED',
      shipmentRef: item.shipmentNumber,
      numbers,
      parcels: await this.mapParcels(query.request, numbers, signal),
    };
  }

  /**
   * Proves which PPL number belongs to which parcel: a single parcel is the shipment itself; a set
   * is mapped only by each number's own CUST external number returned by GET /shipment. Unproven
   * parcels are left out (the labels are then not accepted — doc 029 §3).
   */
  private async mapParcels(
    request: CarrierShipmentRequest,
    numbers: string[],
    signal: AbortSignal,
  ): Promise<CarrierParcelNumber[]> {
    if (request.parcels.length === 1 && numbers.length === 1) {
      return [{ parcelNo: request.parcels[0]!.parcelNo, number: numbers[0]! }];
    }
    const res = await this.client.request('GET', '/shipment', {
      query: { ShipmentNumbers: numbers, Limit: 50, Offset: 0 },
      signal,
    });
    if (res.status !== 200 || !Array.isArray(res.body)) return [];
    const byRef = new Map(request.parcels.map((p) => [p.reference, p.parcelNo]));
    const mapped = new Map<number, string>();
    for (const sh of res.body as ShipmentInfo[]) {
      if (!sh.shipmentNumber || !numbers.includes(sh.shipmentNumber)) continue;
      const refs = (sh.externalNumbers ?? [])
        .filter((e) => e.code === 'CUST' && e.externalNumber && byRef.has(e.externalNumber))
        .map((e) => byRef.get(e.externalNumber!)!);
      // Exactly one of our parcel references per number, used once.
      if (new Set(refs).size !== 1 || mapped.has(refs[0]!)) continue;
      mapped.set(refs[0]!, sh.shipmentNumber);
    }
    return [...mapped].map(([parcelNo, number]) => ({ parcelNo, number }));
  }

  async labels(
    query: {
      shipmentRef: string;
      carrierRef: string | null;
      parcels: CarrierParcelNumber[];
      settings: CarrierSettingsSnapshot;
    },
    signal: AbortSignal,
  ) {
    if (!query.carrierRef) throw new Error('PPL labels need the batch id');
    const res = await this.client.request('GET', `/shipment/batch/${query.carrierRef}`, { signal });
    if (res.status !== 200) throw new Error(`PPL batch status: HTTP ${res.status}`);
    const status = res.body as BatchStatus;
    const urls = new Map<string, string>();
    for (const i of status.items ?? []) {
      if (i.shipmentNumber && i.labelUrl) urls.set(i.shipmentNumber, i.labelUrl);
      for (const r of i.relatedItems ?? []) {
        if (r.shipmentNumber && r.labelUrl) urls.set(r.shipmentNumber, r.labelUrl);
      }
    }
    const format = query.settings.label.format;
    const dpi = format === 'ZPL' ? query.settings.label.dpi : null;
    const parcels = [];
    for (const p of query.parcels) {
      const url = urls.get(p.number);
      if (!url) throw new Error(`PPL returned no label for ${p.number}`);
      parcels.push({
        parcelNo: p.parcelNo,
        format,
        dpi,
        bytes: await this.client.download(url, signal),
      });
    }
    const completeUrl = query.settings.label.complete
      ? status.completeLabel?.labelUrls?.[0]
      : undefined;
    return {
      parcels,
      complete: completeUrl
        ? { format, dpi, bytes: await this.client.download(completeUrl, signal) }
        : null,
    };
  }

  /** Asks PPL to cancel every created number; PPL answers 202 (asynchronous) — confirmed later. */
  async cancel(
    query: { parcels: string[] },
    signal: AbortSignal,
  ): Promise<'CANCELLED' | 'PENDING'> {
    for (const n of query.parcels) {
      const res = await this.client.request('POST', `/shipment/${encodeURIComponent(n)}/cancel`, {
        signal,
      });
      if (res.status === 400)
        throw new CarrierRejectedError('PPL_CANCEL_400', pplProblem(res.body));
      if (res.status !== 202 && res.status !== 200)
        throw new Error(`PPL cancel: HTTP ${res.status}`);
    }
    return 'PENDING';
  }

  /** CANCELLED only when PPL shows every number `Canceled`. */
  async cancelStatus(
    query: { parcels: string[] },
    signal: AbortSignal,
  ): Promise<CarrierCancelStatus> {
    const res = await this.client.request('GET', '/shipment', {
      query: { ShipmentNumbers: query.parcels, Limit: 50, Offset: 0 },
      signal,
    });
    if (res.status !== 200 || !Array.isArray(res.body)) return 'UNKNOWN';
    const states = new Map(
      (res.body as ShipmentInfo[]).map((s) => [s.shipmentNumber, s.shipmentState ?? '']),
    );
    const all = query.parcels.map((n) => states.get(n));
    if (all.some((s) => s === undefined)) return 'UNKNOWN';
    if (all.every((s) => s === 'Canceled')) return 'CANCELLED';
    if (all.some((s) => PICKED_UP.has(s!))) return 'NOT_CANCELLED';
    return 'PENDING';
  }

  /** "Ověřit připojení": a token and the product code list — read-only, creates nothing. */
  async verify(signal: AbortSignal): Promise<{ code: string; name: string }[]> {
    const res = await this.client.request('GET', '/codelist/product', {
      query: { Limit: 200, Offset: 0 },
      signal,
    });
    if (res.status !== 200 || !Array.isArray(res.body)) {
      throw new Error(`PPL product list: HTTP ${res.status}`);
    }
    return (res.body as { code?: unknown; name?: unknown }[])
      .filter((p) => typeof p.code === 'string' && p.code)
      .map((p) => ({
        code: String(p.code),
        name: typeof p.name === 'string' ? p.name : String(p.code),
      }));
  }
}
