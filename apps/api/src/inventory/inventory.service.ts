import { Injectable, NotFoundException } from '@nestjs/common';
import type { UpdateItemSettingsRequest } from '@ayvo/types';
import { domainError } from '../common/domain-error.js';
import { assertUnitScale, quantity } from '../common/quantity.js';
import {
  Prisma,
  type ConsumptionStage,
  type InventoryMovementType,
} from '../generated/prisma/client.js';
import { PrismaService } from '../database/prisma.service.js';

/** The physical warehouse (doc 018: one location for now; every row still names it). */
export const MAIN_LOCATION_CODE = 'MAIN';

const itemInclude = {
  baseUnit: true,
  settings: { orderBy: { version: 'desc' as const }, take: 1 },
} satisfies Prisma.InventoryItemInclude;
export type InventoryItemRecord = Prisma.InventoryItemGetPayload<{ include: typeof itemInclude }>;

export type LotRecord = Prisma.InventoryLotGetPayload<{
  include: { item: { include: { baseUnit: true } } };
}>;

export interface NewMovement {
  itemId: string;
  unitId: string;
  locationId: string;
  lotId: string | null;
  quantityDelta: Prisma.Decimal;
  type: InventoryMovementType;
  receiptLineId?: string;
  receiptCorrectionId?: string;
  bottleEventId?: string;
  bomLineId?: string;
  occurredAt: Date;
  requestId: string;
}

const byLockOrder = (
  a: { itemId: string; locationId: string; lotId: string | null },
  b: { itemId: string; locationId: string; lotId: string | null },
) =>
  a.itemId.localeCompare(b.itemId) ||
  a.locationId.localeCompare(b.locationId) ||
  (a.lotId ?? '').localeCompare(b.lotId ?? '');

/**
 * inventory module (doc 018): items, units, locations, lots, consumption rules (BOM), the
 * append-only ledger and its protected balances. Knows nothing about suppliers' documents,
 * receipts or bottles: callers pass the source ids of each movement. Every stock change goes
 * through `postMovements`; the database trigger then updates the balance (never negative).
 */
@Injectable()
export class InventoryService {
  constructor(private readonly prisma: PrismaService) {}

  // --- items -----------------------------------------------------------------------------------

  listItems(includeArchived = false): Promise<InventoryItemRecord[]> {
    return this.prisma.inventoryItem.findMany({
      where: includeArchived ? {} : { archivedAt: null },
      include: itemInclude,
      orderBy: { code: 'asc' },
    });
  }

  async getItemByCode(code: string, db: Prisma.TransactionClient = this.prisma) {
    const item = await db.inventoryItem.findUnique({ where: { code }, include: itemInclude });
    if (!item) throw new NotFoundException('Inventory item not found');
    return item;
  }

  async getItemsByIds(ids: readonly string[], db: Prisma.TransactionClient = this.prisma) {
    return db.inventoryItem.findMany({ where: { id: { in: [...ids] } }, include: itemInclude });
  }

  /**
   * Appends a planning-settings version (reorder point, target, preferred supplier, lead time,
   * purchase multiple). The item row lock serialises concurrent versions.
   */
  async appendSettings(
    tx: Prisma.TransactionClient,
    itemCode: string,
    input: UpdateItemSettingsRequest,
  ): Promise<void> {
    const item = await this.getItemByCode(itemCode, tx);
    await tx.$queryRaw`SELECT 1 FROM "inventory_items" WHERE "id" = ${item.id}::uuid FOR UPDATE`;
    const decimals = item.baseUnit.decimalPlaces;
    const parse = (v: string | null, field: string) => {
      if (v === null) return null;
      const q = quantity(v);
      assertUnitScale(q, decimals, field);
      return q;
    };
    const reorderPoint = parse(input.reorderPoint, 'Reorder point');
    const targetLevel = parse(input.targetLevel, 'Target level');
    if (reorderPoint && targetLevel && targetLevel.lessThan(reorderPoint)) {
      throw domainError(
        422,
        'INVALID_SETTINGS',
        'The target level must not be below the reorder point',
      );
    }
    const last = await tx.inventoryItemSetting.findFirst({
      where: { itemId: item.id },
      orderBy: { version: 'desc' },
      select: { version: true },
    });
    await tx.inventoryItemSetting.create({
      data: {
        itemId: item.id,
        version: (last?.version ?? 0) + 1,
        reorderPoint,
        targetLevel,
        preferredSupplierId: input.preferredSupplierId,
        leadTimeDays: input.leadTimeDays,
        purchaseMultiple: parse(input.purchaseMultiple, 'Purchase multiple'),
        requestId: input.requestId,
      },
    });
  }

  // --- locations and lots ----------------------------------------------------------------------

  /** All inventory locations (warehouses), for access-scope administration. */
  listLocations(db: Prisma.TransactionClient = this.prisma) {
    return db.inventoryLocation.findMany({ orderBy: { code: 'asc' } });
  }

  locationByCode(code: string, db: Prisma.TransactionClient = this.prisma) {
    return db.inventoryLocation.findUnique({ where: { code } });
  }

  async mainLocation(db: Prisma.TransactionClient = this.prisma) {
    const location = await db.inventoryLocation.findUnique({ where: { code: MAIN_LOCATION_CODE } });
    if (!location) throw new Error('Inventory location MAIN is missing (migration not applied)');
    return location;
  }

  /** The lot of this supplier's own lot code for the item; created on first receipt. */
  async findOrCreateSupplierLot(
    tx: Prisma.TransactionClient,
    itemId: string,
    supplierId: string,
    supplierLotCode: string,
  ): Promise<string> {
    await tx.$executeRaw`
      INSERT INTO "inventory_lots" ("item_id", "kind", "code", "supplier_id", "supplier_lot_code")
      VALUES (${itemId}::uuid, 'SUPPLIER', ${supplierLotCode}, ${supplierId}::uuid, ${supplierLotCode})
      ON CONFLICT ("item_id", "supplier_id", "supplier_lot_code") WHERE "kind" = 'SUPPLIER' DO NOTHING`;
    const lot = await tx.inventoryLot.findFirst({
      where: { itemId, supplierId, supplierLotCode, kind: 'SUPPLIER' },
      select: { id: true },
    });
    if (!lot) throw new Error('Supplier lot not found after insert');
    return lot.id;
  }

  /** An internal lot for exactly one receipt line (the line is inserted later, same tx). */
  async createInternalLot(
    tx: Prisma.TransactionClient,
    itemId: string,
    code: string,
    originReceiptLineId: string,
  ): Promise<string> {
    const lot = await tx.inventoryLot.create({
      data: { itemId, kind: 'INTERNAL', code, originReceiptLineId },
      select: { id: true },
    });
    return lot.id;
  }

  getLot(id: string, db: Prisma.TransactionClient = this.prisma): Promise<LotRecord | null> {
    return db.inventoryLot.findUnique({
      where: { id },
      include: { item: { include: { baseUnit: true } } },
    });
  }

  getLotsByIds(ids: readonly string[], db: Prisma.TransactionClient = this.prisma) {
    return db.inventoryLot.findMany({ where: { id: { in: [...ids] } } });
  }

  /** Lots of an item with their on-hand at a location (optionally only lots with stock). */
  async lotsWithStock(itemId: string, locationId: string, onlyAvailable: boolean) {
    const lots = await this.prisma.inventoryLot.findMany({
      where: { itemId },
      include: { balances: { where: { locationId } } },
      orderBy: { createdAt: 'asc' },
    });
    return lots
      .map((lot) => ({ lot, onHand: lot.balances[0]?.onHand ?? quantity(0) }))
      .filter(({ onHand }) => !onlyAvailable || onHand.greaterThan(0));
  }

  /** A lot and its on-hand at MAIN (null if the lot does not exist). */
  async lotOnHand(lotId: string) {
    const lot = await this.prisma.inventoryLot.findUnique({
      where: { id: lotId },
      include: { balances: { where: { location: { code: MAIN_LOCATION_CODE } } } },
    });
    return lot ? { lot, onHand: lot.balances[0]?.onHand ?? quantity(0) } : null;
  }

  // --- balances and the ledger -----------------------------------------------------------------

  /**
   * Locks the balance row of (item, location, lot) and returns its on-hand (0 if none yet).
   * Callers lock several rows in `byLockOrder` order so concurrent operations cannot deadlock.
   */
  async lockBalance(
    tx: Prisma.TransactionClient,
    key: { itemId: string; locationId: string; lotId: string | null },
  ): Promise<Prisma.Decimal> {
    const rows = key.lotId
      ? await tx.$queryRaw<{ on_hand: Prisma.Decimal }[]>`
          SELECT "on_hand" FROM "inventory_balances"
          WHERE "item_id" = ${key.itemId}::uuid AND "location_id" = ${key.locationId}::uuid
            AND "lot_id" = ${key.lotId}::uuid
          FOR UPDATE`
      : await tx.$queryRaw<{ on_hand: Prisma.Decimal }[]>`
          SELECT "on_hand" FROM "inventory_balances"
          WHERE "item_id" = ${key.itemId}::uuid AND "location_id" = ${key.locationId}::uuid
            AND "lot_id" IS NULL
          FOR UPDATE`;
    return rows[0] ? quantity(rows[0].on_hand) : quantity(0);
  }

  /** Appends movements in lock order; the ledger trigger validates them and moves the balances. */
  async postMovements(tx: Prisma.TransactionClient, movements: NewMovement[]) {
    const ordered = [...movements].sort(byLockOrder);
    const created = [];
    for (const m of ordered) {
      created.push(
        await tx.inventoryMovement.create({
          data: {
            itemId: m.itemId,
            unitId: m.unitId,
            locationId: m.locationId,
            lotId: m.lotId,
            quantityDelta: m.quantityDelta,
            type: m.type,
            receiptLineId: m.receiptLineId,
            receiptCorrectionId: m.receiptCorrectionId,
            bottleEventId: m.bottleEventId,
            bomLineId: m.bomLineId,
            occurredAt: m.occurredAt,
            requestId: m.requestId,
          },
        }),
      );
    }
    return created;
  }

  /** On-hand per item and lot at a location (from the protected balances). */
  balances(locationId: string) {
    return this.prisma.inventoryBalance.findMany({ where: { locationId } });
  }

  async movementsPage(query: { page: number; pageSize: number; itemId?: string; lotId?: string }) {
    const where: Prisma.InventoryMovementWhereInput = {
      ...(query.itemId ? { itemId: query.itemId } : {}),
      ...(query.lotId ? { lotId: query.lotId } : {}),
    };
    const [total, items] = await this.prisma.$transaction([
      this.prisma.inventoryMovement.count({ where }),
      this.prisma.inventoryMovement.findMany({
        where,
        orderBy: [{ recordedAt: 'desc' }, { id: 'desc' }],
        skip: (query.page - 1) * query.pageSize,
        take: query.pageSize,
        include: { item: { include: { baseUnit: true } }, lot: true },
      }),
    ]);
    return { total, items };
  }

  /** The stock movements written for the given bottle events (label application). */
  movementsForBottleEvents(eventIds: readonly string[]) {
    return this.prisma.inventoryMovement.findMany({
      where: { bottleEventId: { in: [...eventIds] } },
      include: { lot: true },
    });
  }

  // --- consumption rules -----------------------------------------------------------------------

  /** The BOM version valid now for a stage, with its lines (immutable rows). */
  async activeBom(stage: ConsumptionStage, db: Prisma.TransactionClient = this.prisma) {
    const now = new Date();
    const bom = await db.bomVersion.findFirst({
      where: {
        stage,
        validFrom: { lte: now },
        OR: [{ validTo: null }, { validTo: { gt: now } }],
      },
      orderBy: [{ validFrom: 'desc' }, { version: 'desc' }],
      include: { lines: { orderBy: { lineNo: 'asc' }, include: { item: true } } },
    });
    if (!bom || bom.lines.length === 0) {
      throw new Error(`No active consumption rule for stage ${stage}`);
    }
    return bom;
  }

  /** Drift check (expected empty): balances that differ from Σ ledger. */
  drift(db: Prisma.TransactionClient = this.prisma) {
    return db.$queryRaw<unknown[]>`SELECT * FROM ayvo_inventory_drift()`;
  }
}

export { byLockOrder };
