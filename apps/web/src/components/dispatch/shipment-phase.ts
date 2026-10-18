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
  if (!s) return 'NO_SHIPMENT';
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
