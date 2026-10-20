import { Injectable } from '@nestjs/common';
import { WeightsService } from '../catalog/weights.service.js';
import { CODE_PREFIX, formatCode } from '../common/codes.js';
import { allocateSerials } from '../database/code-counters.js';
import type { Prisma } from '../generated/prisma/client.js';
import { shipmentEvent, type Step } from './shipment-events.js';

/**
 * Derives the shipment of a completed order (doc 029): one parcel per active allocation, in
 * loading order, with its calculated reference (the crate's Hotovo snapshot, else the references
 * in force now — labelled so) and the shipping package's dimensions. No carrier is contacted, no
 * stock moves. Runs in the caller's transaction.
 */
@Injectable()
export class ShipmentDeriver {
  constructor(private readonly weights: WeightsService) {}

  async derive(
    tx: Prisma.TransactionClient,
    order: { id: string; siteId: string },
    step: Step,
  ): Promise<string> {
    const allocations = await tx.orderCrateAllocation.findMany({
      where: { orderId: order.id, releasedAt: null },
      include: {
        cycle: {
          select: {
            id: true,
            productId: true,
            recipeVersionId: true,
            crateTypeId: true,
            capacity: true,
          },
        },
      },
      orderBy: [{ allocatedAt: 'asc' }, { id: 'asc' }],
    });
    const { first: serial } = await allocateSerials(tx, 'shipment', 1);
    const shipment = await tx.shipment.create({
      data: {
        serial,
        code: formatCode(CODE_PREFIX.shipment, serial),
        orderId: order.id,
        siteId: order.siteId,
        createdAt: step.occurredAt,
        createdBy: step.actorId,
        operationRequestId: step.operationId,
      },
    });
    let parcelNo = 0;
    for (const a of allocations) {
      const ref = await this.weights.parcelReference(tx, a.cycle, step.occurredAt);
      parcelNo += 1;
      await tx.shipmentParcel.create({
        data: {
          shipmentId: shipment.id,
          parcelNo,
          allocationId: a.id,
          crateId: a.crateId,
          cycleId: a.cycleId,
          referenceWeightG: ref.massG,
          referenceSource: ref.source,
          weightSnapshotId: ref.snapshotId,
          packageDimensionId: ref.packageDimensionId,
        },
      });
    }
    await shipmentEvent(tx, order.id, 'SHIPMENT_CREATED', step, {
      shipment: shipment.code,
      parcels: allocations.length,
    });
    return shipment.code;
  }
}
