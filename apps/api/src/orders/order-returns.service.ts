import { Injectable } from '@nestjs/common';
import type { Prisma } from '../generated/prisma/client.js';

/**
 * What the return intake (doc 047) needs of the orders module: the delivered allocation of a
 * crate cycle, its completion when the crate is scanned back, and the shipped bottles of an
 * allocation. An order's allocations are never released by a return, so the order, its lines,
 * counters and DELIVERED stay as they are (doc 047 §4.1).
 */
@Injectable()
export class OrderReturnsService {
  /**
   * The cycle's live allocation whose parcel the carrier delivered, with its order and hotel, or
   * null (not allocated, not delivered, or already completed).
   */
  async deliveredAllocation(db: Prisma.TransactionClient, cycleId: string) {
    const allocation = await db.orderCrateAllocation.findFirst({
      where: { cycleId, releasedAt: null, completedAt: null },
      select: {
        id: true,
        order: { select: { code: true, hotel: { select: { id: true, code: true, name: true } } } },
        parcels: {
          where: { shipment: { status: { not: 'CANCELLED' } } },
          select: { progress: { select: { deliveredAt: true } } },
        },
      },
    });
    if (!allocation || !allocation.parcels.some((p) => p.progress?.deliveredAt)) return null;
    return { id: allocation.id, order: allocation.order };
  }

  /** Completed once by its crate line: it stays the order's history, no longer holding the crate. */
  async complete(
    tx: Prisma.TransactionClient,
    input: { allocationId: string; lineId: string; actorId: string; occurredAt: Date },
  ): Promise<void> {
    await tx.orderCrateAllocation.update({
      where: { id: input.allocationId },
      data: {
        completedAt: input.occurredAt,
        completedBy: input.actorId,
        completedLineId: input.lineId,
      },
    });
  }

  /**
   * Was the assignment one of the bottles a delivered (live or completed) allocation of its
   * cycle recorded at picking? Returns that order's code, or null.
   */
  async shippedIn(db: Prisma.TransactionClient, assignmentId: string) {
    const row = await db.orderAllocationBottle.findFirst({
      where: {
        assignmentId,
        allocation: {
          releasedAt: null,
          parcels: {
            some: {
              shipment: { status: { not: 'CANCELLED' } },
              progress: { deliveredAt: { not: null } },
            },
          },
        },
      },
      select: { allocation: { select: { order: { select: { code: true } } } } },
    });
    return row?.allocation.order.code ?? null;
  }

  /** The shipped count and the order of a cycle's (delivered) allocation, for history. */
  async shippedOfCycle(db: Prisma.TransactionClient, cycleId: string) {
    const allocation = await db.orderCrateAllocation.findFirst({
      where: { cycleId, releasedAt: null },
      select: {
        order: { select: { code: true, hotel: { select: { name: true } } } },
        _count: { select: { bottles: true } },
      },
    });
    return allocation
      ? {
          orderCode: allocation.order.code,
          hotelName: allocation.order.hotel.name,
          shipped: allocation._count.bottles,
        }
      : null;
  }
}
