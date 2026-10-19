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
import { pplProblem, PplAuthError, type PplClient } from './ppl-client.js';

/**
 * PPL CPL API adapter (doc 029 §5; ppl-cpl-api.apidog.io, read 2026-10-19). Asynchronous: a batch
 * is accepted (201, its id only in the Location header — stored at once) and polled until
 * `Complete`/`Error`. One AYVO order = one PPL shipment; several crates = a PPL shipment set whose
 * items each carry their own `CUST` external number (= our parcel reference). Parcel numbers are
 * mapped to crates only through that reference as returned by `GET /shipment` — never by position.
 * Weights are not sent while their unit is undocumented; no dimensions exist in the API.
 */

/** Letters a Unicode decomposition does not reduce to Latin, and typographic punctuation. */
const LATIN: Record<string, string> = {
  Ł: 'L',
  ł: 'l',
  Đ: 'D',
  đ: 'd',
  Ø: 'O',
  ø: 'o',
  ß: 'ss',
  Æ: 'AE',
  æ: 'ae',
  Œ: 'OE',
  œ: 'oe',
  '„': '"',
  '“': '"',
  '”': '"',
  '‚': "'",
  '‘': "'",
  '’': "'",
  '–': '-',
  '—': '-',
  ' ': ' ',
};
/** PPL accepts Latin characters only (doc 029 §5): diacritics removed, the rest transliterated. */
export const latin = (s: string) =>
  s
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^\u0020-\u007e]/g, (c) => LATIN[c] ?? c);

/** Address field lengths documented for the PPL address model. */
const LIMITS = { name: 50, street: 60, city: 50, zipCode: 10, contact: 50, phone: 30, email: 50 };

/**
 * The PPL address. Nothing is cut: a value PPL could not take (too long, non-Latin) refuses the
 * request before anything is sent — what is printed on the label is never silently changed.
 */
function address(
  role: 'sender' | 'recipient',
  a: CarrierAddress & { contactName?: string | null; phone?: string | null; email?: string | null },
) {
  const out = {
    name: latin(a.name),
    street: latin([a.addressLine1, a.addressLine2].filter(Boolean).join(', ')),
    city: latin(a.city),
    zipCode: a.postalCode.replace(/\s+/g, ''),
    country: a.countryCode,
    contact: a.contactName ? latin(a.contactName) : undefined,
    phone: a.phone ? a.phone.trim() : undefined,
    email: a.email ? a.email.trim() : undefined,
  };
  for (const [field, max] of Object.entries(LIMITS)) {
    const v = out[field as keyof typeof out];
    if (v && v.length > max) {
      throw new CarrierRejectedError(
        'PPL_FIELD_TOO_LONG',
        `${role}.${field}: longer than the ${max} characters PPL accepts`,
      );
    }
    if (v && /[^ -~]/.test(v)) {
      throw new CarrierRejectedError(
        'PPL_NOT_LATIN',
        `${role}.${field}: characters PPL cannot take`,
      );
    }
  }
  return out;
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

  /**
   * The batch request — exactly what PPL receives, built from the attempt's stored request (its
   * settings snapshot), so it is the same for every look at the attempt. Refuses (nothing sent)
   * what PPL could not take.
   */
  static batch(request: CarrierShipmentRequest) {
    const s = request.settings;
    const set = request.parcels.length > 1;
    // Germany needs the parcel weight, whose unit PPL does not document (doc 029 §5).
    if (request.recipient.countryCode === 'DE') {
      throw new CarrierRejectedError(
        'PPL_COUNTRY_UNSUPPORTED',
        'Germany needs parcel weights; their unit is not confirmed by PPL yet',
      );
    }
    return {
      labelSettings: {
        format: s.label.format === 'ZPL' ? 'Zpl' : 'Pdf',
        // The printer resolution applies to ZPL (documented 203–1200 dpi).
        ...(s.label.format === 'ZPL' ? { dpi: s.label.dpi } : {}),
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
          note: latin(request.orderCode),
          sender: s.sender ? address('sender', s.sender) : undefined,
          recipient: address('recipient', request.recipient),
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
    const body = PplGateway.batch(request);
    // The token first: if it cannot be had, the batch was certainly not sent (a definite "no").
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
    const res = await this.client.request('POST', '/shipment/batch', {
      json: body,
      signal,
      once: true,
    });
    if (res.status === 201) {
      const id = batchId(res.headers.get('location'));
      // Accepted but no batch id: the outcome cannot be followed — unknown, never re-sent.
      if (!id) throw new Error('PPL accepted the batch without a usable Location');
      return { kind: 'ACCEPTED', carrierRef: id };
    }
    // A validation refusal, or the token not accepted: nothing was created.
    if (res.status === 400) throw new CarrierRejectedError('PPL_400', pplProblem(res.body));
    if (res.status === 401 || res.status === 403) {
      throw new CarrierRejectedError(`PPL_${res.status}`, 'PPL did not accept the access token');
    }
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
    // parcel → every number claiming it; a parcel claimed by two numbers is ambiguous (unproven).
    const claims = new Map<number, Set<string>>();
    for (const sh of res.body as ShipmentInfo[]) {
      if (!sh.shipmentNumber || !numbers.includes(sh.shipmentNumber)) continue;
      const refs = new Set(
        (sh.externalNumbers ?? [])
          .filter((e) => e.code === 'CUST' && e.externalNumber && byRef.has(e.externalNumber))
          .map((e) => byRef.get(e.externalNumber!)!),
      );
      // Exactly one of our parcel references per number.
      if (refs.size !== 1) continue;
      const parcelNo = [...refs][0]!;
      claims.set(parcelNo, (claims.get(parcelNo) ?? new Set()).add(sh.shipmentNumber));
    }
    return [...claims]
      .filter(([, n]) => n.size === 1)
      .map(([parcelNo, n]) => ({ parcelNo, number: [...n][0]! }));
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
      if (!url) throw new Error(`PPL returned no label for ${p.number} (yet)`);
      parcels.push({
        parcelNo: p.parcelNo,
        format,
        dpi,
        bytes: await this.client.download(url, signal),
      });
    }
    // The complete document (A4, PDF only — enforced by the settings) only as one single file.
    const completeUrls = query.settings.label.complete
      ? status.completeLabel?.labelUrls
      : undefined;
    return {
      parcels,
      complete:
        completeUrls?.length === 1
          ? {
              format,
              dpi,
              bytes: await this.client.download(completeUrls[0]!, signal, {
                kind: 'complete',
                batchId: query.carrierRef,
              }),
            }
          : null,
    };
  }

  private async states(
    numbers: string[],
    signal: AbortSignal,
  ): Promise<Map<string, string> | null> {
    const res = await this.client.request('GET', '/shipment', {
      query: { ShipmentNumbers: numbers, Limit: 50, Offset: 0 },
      signal,
    });
    if (res.status !== 200 || !Array.isArray(res.body)) return null;
    const states = new Map<string, string>();
    for (const sh of res.body as ShipmentInfo[]) {
      if (sh.shipmentNumber) states.set(sh.shipmentNumber, sh.shipmentState ?? '');
    }
    return numbers.every((n) => states.has(n)) ? states : null;
  }

  /**
   * Asks PPL to cancel every created number not yet `Canceled` (so asking again after a lost
   * answer is safe). PPL answers 202 (asynchronous) — confirmed later by {@link cancelStatus}. A
   * definite refusal only when PPL refused every number and none is cancelled; a mixed outcome
   * stays pending (and is shown as such) — never "returned" while part of it is cancelled.
   */
  async cancel(
    query: { parcels: string[] },
    signal: AbortSignal,
  ): Promise<'CANCELLED' | 'PENDING'> {
    const states = await this.states(query.parcels, signal);
    if (!states) throw new Error('PPL shipment states unavailable');
    const open = query.parcels.filter((n) => states.get(n) !== 'Canceled');
    if (open.length === 0) return 'CANCELLED';
    const refused: string[] = [];
    let accepted = query.parcels.length - open.length;
    for (const n of open) {
      const res = await this.client.request('POST', `/shipment/${encodeURIComponent(n)}/cancel`, {
        signal,
      });
      if (res.status === 202 || res.status === 200) accepted += 1;
      else if (res.status === 400) refused.push(`${n}: ${pplProblem(res.body)}`);
      else throw new Error(`PPL cancel: HTTP ${res.status}`);
    }
    if (refused.length > 0 && accepted === 0) {
      throw new CarrierRejectedError('PPL_CANCEL_400', refused.join('; ').slice(0, 900));
    }
    return 'PENDING';
  }

  /**
   * CANCELLED only when PPL shows every number `Canceled`; NOT_CANCELLED only when none is and one
   * is already with the carrier; a mixed set is UNKNOWN (a person checks it with PPL).
   */
  async cancelStatus(
    query: { parcels: string[] },
    signal: AbortSignal,
  ): Promise<CarrierCancelStatus> {
    const states = await this.states(query.parcels, signal);
    if (!states) return 'UNKNOWN';
    const all = query.parcels.map((n) => states.get(n)!);
    if (all.every((s) => s === 'Canceled')) return 'CANCELLED';
    const some = all.some((s) => s === 'Canceled');
    if (all.some((s) => PICKED_UP.has(s))) return some ? 'UNKNOWN' : 'NOT_CANCELLED';
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

/**
 * The batch id from the Location header (absolute or relative): the path segment after
 * `/shipment/batch/`. Its format is not documented — only a conservative character set is required.
 */
export function batchId(location: string | null): string | null {
  if (!location) return null;
  let path: string;
  try {
    path = new URL(location, 'http://relative.invalid').pathname;
  } catch {
    return null;
  }
  const m = /\/shipment\/batch\/([A-Za-z0-9_-]{1,100})\/?$/.exec(path);
  return m ? m[1]! : null;
}
