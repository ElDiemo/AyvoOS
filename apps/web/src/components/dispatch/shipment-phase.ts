import type { OrderShipment, OrderStatus } from '@ayvo/types';

export type ShipmentPhase =
  | 'NO_SHIPMENT'
  | 'NO_CARRIER'
  | 'MISSING'
  | 'CREATE'
  | 'PREPARED'
  | 'IN_FLIGHT'
  | 'UNCERTAIN'
  | 'ACCEPTED'
  | 'CREATED'
  | 'CANCELLING'
  | 'LABELED'
  | 'READY_FOR_PICKUP'
  | 'HANDED_OVER';

/**
 * The one current step of the dispatch, from the order status and its shipment (doc 029). The
 * order status is the process; the shipment only tells where the carrier request stands.
 */
export function shipmentPhase(status: OrderStatus, data: OrderShipment): ShipmentPhase | null {
  if (status === 'HANDED_TO_CARRIER') return 'HANDED_OVER';
  if (status === 'READY_FOR_PICKUP') return 'READY_FOR_PICKUP';
  if (status !== 'READY_TO_DISPATCH') return null;
  const s = data.shipment;
  if (!s) return data.carrier.configured ? 'NO_SHIPMENT' : 'NO_CARRIER';
  if (s.status === 'CANCELLING') return 'CANCELLING';
  if (s.status === 'LABELED') return 'LABELED';
  if (s.status === 'REQUESTING') {
    const r = s.request;
    if (r?.status === 'PREPARED') return 'PREPARED';
    if (r?.status === 'ACCEPTED') return 'ACCEPTED';
    if (r?.status === 'CREATED') return 'CREATED';
    return r?.errorCode === 'NO_ANSWER' ? 'UNCERTAIN' : 'IN_FLIGHT';
  }
  if (!s.carrier.configured) return 'NO_CARRIER';
  if (s.missing.length > 0) return 'MISSING';
  return 'CREATE';
}

export interface LabelLink {
  href: string;
  /** The parcel's own label, or the complete document (a convenience, never the mapping). */
  kind: 'PARCEL' | 'COMPLETE';
  parcelNo: number | null;
  format: 'PDF' | 'ZPL';
}

/**
 * The label files that really exist (UI36-R1): every parcel's own stored label, and the complete
 * document only when the carrier provided one (PDF A4) — never a link the server answers with 404.
 */
export function labelLinks(code: string, shipment: OrderShipment['shipment']): LabelLink[] {
  if (!shipment) return [];
  const base = `/api/admin/orders/${code}/shipment`;
  const links: LabelLink[] = shipment.parcels.flatMap((p) =>
    p.label
      ? [
          {
            href: `${base}/parcels/${p.parcelNo}/label`,
            kind: 'PARCEL' as const,
            parcelNo: p.parcelNo,
            format: p.label.format,
          },
        ]
      : [],
  );
  if (shipment.label) {
    links.push({
      href: `${base}/labels`,
      kind: 'COMPLETE',
      parcelNo: null,
      format: shipment.label.format,
    });
  }
  return links;
}
