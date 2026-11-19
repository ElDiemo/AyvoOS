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
    const deliveredAt = allocation?.parcels.find((p) => p.progress?.deliveredAt)?.progress
      ?.deliveredAt;
    if (!allocation || !deliveredAt) return null;
    return { id: allocation.id, order: allocation.order, deliveredAt };
  }

  /**
   * R1.1 (doc 047 §6.3 2): the delivery of the allocation (live or completed) that recorded this
   * assignment at picking — its order and when the carrier delivered it — or null.
   */
  async deliveryOf(db: Prisma.TransactionClient, assignmentId: string) {
    const row = await db.orderAllocationBottle.findFirst({
      where: { assignmentId, allocation: { releasedAt: null } },
      select: {
        allocation: {
          select: {
            id: true,
            order: { select: { code: true } },
            parcels: {
              where: { shipment: { status: { not: 'CANCELLED' } } },
              select: { progress: { select: { deliveredAt: true } } },
            },
          },
        },
      },
    });
    if (!row) return null;
    const deliveredAt =
      row.allocation.parcels.find((p) => p.progress?.deliveredAt)?.progress?.deliveredAt ?? null;
    return { allocationId: row.allocation.id, orderCode: row.allocation.order.code, deliveredAt };
  }

  /** The cycle's live (neither released nor completed) allocation, for a NOT_DELIVERED anchor. */
  async liveAllocation(db: Prisma.TransactionClient, cycleId: string) {
    return db.orderCrateAllocation.findFirst({
      where: { cycleId, releasedAt: null, completedAt: null },
      select: { id: true },
    });
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

  /** `shippedOfCycle` of many cycles in one query (a large receipt's detail). */
  async shippedOfCycles(db: Prisma.TransactionClient, cycleIds: string[]) {
    const rows = await db.orderCrateAllocation.findMany({
      where: { cycleId: { in: cycleIds }, releasedAt: null },
      orderBy: { id: 'asc' },
      select: {
        cycleId: true,
        order: { select: { code: true, hotel: { select: { name: true } } } },
        _count: { select: { bottles: true } },
      },
    });
    const of = new Map<string, { orderCode: string; hotelName: string; shipped: number }>();
    for (const a of rows) {
      if (!of.has(a.cycleId)) {
        of.set(a.cycleId, {
          orderCode: a.order.code,
          hotelName: a.order.hotel.name,
          shipped: a._count.bottles,
        });
      }
    }
    return of;
  }
}
