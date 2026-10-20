import type { Prisma } from '../generated/prisma/client.js';

export type Step = { actorId: string; operationId: string; occurredAt: Date };

export type ShipmentEventType =
  | 'SHIPMENT_CREATED'
  | 'LABELS_REQUESTED'
  | 'LABELS_CREATED'
  | 'LABELS_REJECTED'
  | 'LABELS_UNCERTAIN'
  | 'LABELS_NOT_CREATED'
  | 'PARCEL_WEIGHED'
  | 'READY_FOR_PICKUP'
  | 'HANDED_TO_CARRIER'
  | 'SHIPMENT_CANCEL_REQUESTED'
  | 'SHIPMENT_CANCEL_REFUSED'
  | 'SHIPMENT_CANCELLED'
  /** The carrier answered after the request/cancellation was closed locally — never silent. */
  | 'CARRIER_LATE_ANSWER'
  /** doc 030: the ZPL of the same labels was stored / could not be obtained (a person decides). */
  | 'LABEL_VARIANT_STORED'
  | 'LABEL_VARIANT_FAILED'
  | 'PRINT_REQUESTED'
  | 'REPRINT_REQUESTED'
  | 'PRINT_JOBS_CANCELLED';

/** One entry of the order's append-only history (doc 029): the shipment's audited trail. */
export async function shipmentEvent(
  tx: Prisma.TransactionClient,
  orderId: string,
  type: ShipmentEventType,
  step: Step,
  payload: {
    shipment: string;
    parcels?: number;
    crate?: string;
    reason?: string;
    manual?: boolean;
    format?: string;
    dpi?: number;
    printer?: string;
    parcelNo?: number;
  },
): Promise<void> {
  await tx.orderEvent.create({
    data: {
      orderId,
      type,
      occurredAt: step.occurredAt,
      actorId: step.actorId,
      operationRequestId: step.operationId,
      payload: JSON.parse(JSON.stringify(payload)),
    },
  });
}
