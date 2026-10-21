import { Injectable, NotFoundException } from '@nestjs/common';
import type {
  AssignBarcodeRequest,
  BarcodeLookup,
  ItemBarcodes,
  ItemRef,
  RetireBarcodeRequest,
} from '@ayvo/types';
import { AuditService } from '../audit/audit.service.js';
import { domainError, domainErrorWithDetails } from '../common/domain-error.js';
import { isUniqueViolation } from '../common/unique-violation.js';
import { OperationRequestsService } from '../database/operation-requests.service.js';
import { PrismaService } from '../database/prisma.service.js';
import type { Prisma } from '../generated/prisma/client.js';

const itemInclude = { baseUnit: true } satisfies Prisma.InventoryItemInclude;
type ItemRecord = Prisma.InventoryItemGetPayload<{ include: typeof itemInclude }>;

/** An AYVO QR link (bottle or crate passport) or any other URL is never a goods barcode. */
const LOOKS_LIKE_URL = /^[a-z][a-z0-9+.-]*:\/\//i;

/**
 * Goods barcodes of stock items (doc 033). Several codes per item, one active assignment per exact
 * code (also a partial unique index); a retirement is one-way and keeps the row. A code identifies
 * the item only — reading it changes nothing (no stock movement, no receipt). Kept apart from the
 * QR identity registry of bottles and crates.
 */
@Injectable()
export class ItemBarcodesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly operations: OperationRequestsService,
    private readonly audit: AuditService,
  ) {}

  /** Reads only. A retired code identifies nothing; `retired` says it was known once. */
  async lookup(code: string): Promise<BarcodeLookup> {
    const rows = await this.prisma.inventoryItemBarcode.findMany({
      where: { code },
      include: { item: { include: itemInclude } },
    });
    const active = rows.find((r) => r.retiredAt === null);
    return {
      code,
      item: active ? toItemRef(active.item) : null,
      retired: !active && rows.length > 0,
    };
  }

  async list(itemCode: string): Promise<ItemBarcodes> {
    const item = await this.prisma.inventoryItem.findUnique({
      where: { code: itemCode },
      include: {
        ...itemInclude,
        barcodes: {
          include: {
            assignedBy: { select: { displayName: true } },
            retiredBy: { select: { displayName: true } },
          },
          orderBy: { assignedAt: 'desc' },
        },
      },
    });
    if (!item) throw new NotFoundException('Inventory item not found');
    const barcodes = [...item.barcodes].sort(
      (a, b) => Number(a.retiredAt !== null) - Number(b.retiredAt !== null),
    );
    return {
      item: toItemRef(item),
      barcodes: barcodes.map((b) => ({
        id: b.id,
        code: b.code,
        assignedAt: b.assignedAt.toISOString(),
        assignedBy: b.assignedBy.displayName,
        retiredAt: b.retiredAt?.toISOString() ?? null,
        retiredBy: b.retiredBy?.displayName ?? null,
        retireReason: b.retireReason,
      })),
    };
  }

  /**
   * Assigns a code to an item. A code already active on another item is refused with that item
   * named — never taken over; the same code twice on one item is refused as well.
   */
  async assign(
    itemCode: string,
    input: AssignBarcodeRequest,
    actorId: string,
  ): Promise<ItemBarcodes> {
    if (LOOKS_LIKE_URL.test(input.code)) {
      throw domainError(
        422,
        'BARCODE_LOOKS_LIKE_QR',
        'This is a link (e.g. the QR of a bottle or crate), not a goods barcode',
      );
    }
    try {
      await this.operations.run(
        'ITEM_BARCODE_ASSIGN',
        input.requestId,
        { itemCode, code: input.code, actorId },
        async (tx) => {
          // One assignment of a code at a time; the unique index stays the last line of defence.
          await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`item-barcode:${input.code}`}, 0))`;
          const item = await tx.inventoryItem.findUnique({ where: { code: itemCode } });
          if (!item) throw new NotFoundException('Inventory item not found');
          if (item.archivedAt) {
            throw domainError(422, 'ITEM_ARCHIVED', 'An archived item gets no new barcode');
          }
          await this.assertFree(tx, input.code, item.id);
          const barcode = await tx.inventoryItemBarcode.create({
            data: {
              itemId: item.id,
              code: input.code,
              assignedById: actorId,
              requestId: input.requestId,
            },
          });
          await this.audit.record(
            {
              type: 'ITEM_BARCODE_ASSIGNED',
              actorUserId: actorId,
              payload: { item: item.code, barcode: barcode.id, code: input.code },
            },
            tx,
          );
          return { barcodeId: barcode.id };
        },
      );
    } catch (error) {
      if (!isUniqueViolation(error)) throw error;
      // A concurrent assignment won (the index): report its item like the check above.
      await this.assertFree(this.prisma, input.code, null);
      throw error;
    }
    return this.list(itemCode);
  }

  async retire(id: string, input: RetireBarcodeRequest, actorId: string): Promise<ItemBarcodes> {
    const { result } = await this.operations.run(
      'ITEM_BARCODE_RETIRE',
      input.requestId,
      { id, reason: input.reason, actorId },
      async (tx) => {
        await tx.$executeRaw`SELECT 1 FROM "inventory_item_barcodes" WHERE "id" = ${id}::uuid FOR UPDATE`;
        const barcode = await tx.inventoryItemBarcode.findUnique({
          where: { id },
          include: { item: true },
        });
        if (!barcode) throw new NotFoundException('Barcode not found');
        if (barcode.retiredAt) {
          throw domainError(409, 'BARCODE_ALREADY_RETIRED', 'This barcode is already retired');
        }
        await tx.inventoryItemBarcode.update({
          where: { id },
          data: {
            retiredAt: new Date(),
            retiredById: actorId,
            retireReason: input.reason,
            retireRequestId: input.requestId,
          },
        });
        await this.audit.record(
          {
            type: 'ITEM_BARCODE_RETIRED',
            actorUserId: actorId,
            reason: input.reason,
            payload: { item: barcode.item.code, barcode: id, code: barcode.code },
          },
          tx,
        );
        return { itemCode: barcode.item.code };
      },
    );
    return this.list(result.itemCode);
  }

  /** Refuses a code that is active on an item (`self`: the item it is being assigned to). */
  private async assertFree(db: Prisma.TransactionClient, code: string, self: string | null) {
    const holder = await db.inventoryItemBarcode.findFirst({
      where: { code, retiredAt: null },
      include: { item: true },
    });
    if (!holder) return;
    if (holder.itemId === self) {
      throw domainError(409, 'BARCODE_ALREADY_ON_ITEM', 'This item already has this barcode');
    }
    throw domainErrorWithDetails(
      409,
      'BARCODE_TAKEN',
      'This barcode identifies another item; retire it there first',
      { item: { code: holder.item.code, name: holder.item.name } },
    );
  }
}

function toItemRef(item: ItemRecord): ItemRef {
  return {
    id: item.id,
    code: item.code,
    name: item.name,
    unit: {
      code: item.baseUnit.code,
      name: item.baseUnit.name,
      decimalPlaces: item.baseUnit.decimalPlaces,
    },
    archived: item.archivedAt !== null,
  };
}
