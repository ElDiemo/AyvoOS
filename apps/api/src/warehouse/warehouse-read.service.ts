import { Injectable, NotFoundException } from '@nestjs/common';
import type {
  BottlePhysical,
  InventoryItem,
  InventoryLot,
  InventoryMovementPage,
  MovementListQuery,
  RecentLabelApplication,
  StockOverview,
  StockSummary,
  UpdateItemSettingsRequest,
} from '@ayvo/types';
import { BottlesService } from '../assets/bottles.service.js';
import { formatQuantity, quantity } from '../common/quantity.js';
import { OperationRequestsService } from '../database/operation-requests.service.js';
import type { Prisma } from '../generated/prisma/client.js';
import { InventoryService, type InventoryItemRecord } from '../inventory/inventory.service.js';
import { LabelPrintJobsService } from '../label-production/label-print-jobs.service.js';
import type { WarehouseContext } from '../inventory/warehouse-context.js';
import { ProcurementService } from '../procurement/procurement.service.js';

/**
 * Read models of the warehouse screens, composed only through the exported services of
 * inventory, procurement, assets and label-production (ADR 0001).
 */
@Injectable()
export class WarehouseReadService {
  constructor(
    private readonly inventory: InventoryService,
    private readonly procurement: ProcurementService,
    private readonly bottles: BottlesService,
    private readonly printJobs: LabelPrintJobsService,
    private readonly operations: OperationRequestsService,
  ) {}

  async items(): Promise<InventoryItem[]> {
    const items = await this.inventory.listItems();
    const names = await this.procurement.supplierNames(
      items.flatMap((i) => i.settings[0]?.preferredSupplierId ?? []),
    );
    return items.map((i) => toItemDto(i, names));
  }

  async updateSettings(code: string, input: UpdateItemSettingsRequest): Promise<InventoryItem> {
    await this.operations.run('ITEM_SETTINGS', input.requestId, { code, ...input }, async (tx) => {
      await this.inventory.appendSettings(tx, code, input);
      return { itemCode: code };
    });
    const item = (await this.items()).find((i) => i.code === code);
    if (!item) throw new NotFoundException('Inventory item not found');
    return item;
  }

  /** Stock of the warehouse of the request's site (doc 022). */
  async stock(warehouse: WarehouseContext): Promise<StockOverview> {
    const location = await this.inventory.getLocation(warehouse.locationId);
    const [items, balances] = await Promise.all([
      this.inventory.listItems(),
      this.inventory.balances(location.id),
    ]);
    const lots = await this.inventory.getLotsByIds(balances.flatMap((b) => b.lotId ?? []));
    const names = await this.procurement.supplierNames([
      ...items.flatMap((i) => i.settings[0]?.preferredSupplierId ?? []),
      ...lots.flatMap((l) => l.supplierId ?? []),
    ]);
    const lotById = new Map(lots.map((l) => [l.id, l]));
    return {
      location: { code: location.code, name: location.name },
      items: items.map((item) => {
        const rows = balances.filter((b) => b.itemId === item.id);
        const onHand = rows.reduce((sum, b) => sum.plus(b.onHand), quantity(0));
        const available = onHand; // no reservations yet
        const settings = item.settings[0];
        const lowStock = !!settings?.reorderPoint && available.lessThan(settings.reorderPoint);
        return {
          item: toItemDto(item, names),
          onHand: formatQuantity(onHand),
          reserved: '0',
          available: formatQuantity(available),
          onOrder: null,
          lowStock,
          suggestedQuantity: suggestion(available, settings),
          lots: rows
            .filter((b) => b.lotId && b.onHand.greaterThan(0))
            .map((b) => toLotDto(lotById.get(b.lotId!)!, b.onHand, names))
            .sort((a, b) => a.createdAt.localeCompare(b.createdAt)),
        };
      }),
    };
  }

  /**
   * Planning view of the same numbers (SALES, doc 021): item, available, reserved, low stock.
   * Built as an explicit allow-list so no lot, supplier or other operational field leaks.
   */
  async stockSummary(warehouse: WarehouseContext): Promise<StockSummary> {
    const overview = await this.stock(warehouse);
    return {
      location: overview.location,
      items: overview.items.map((s) => ({
        item: { code: s.item.code, name: s.item.name, unitCode: s.item.unit.code },
        available: s.available,
        reserved: s.reserved,
        lowStock: s.lowStock,
      })),
    };
  }

  async lots(
    itemCode: string,
    onlyAvailable: boolean,
    warehouse: WarehouseContext,
  ): Promise<InventoryLot[]> {
    const item = await this.inventory.getItemByCode(itemCode);
    const lots = await this.inventory.lotsWithStock(item.id, warehouse.locationId, onlyAvailable);
    const names = await this.procurement.supplierNames(
      lots.flatMap(({ lot }) => lot.supplierId ?? []),
    );
    return lots.map(({ lot, onHand }) => toLotDto(lot, onHand, names));
  }

  async movements(
    query: MovementListQuery,
    warehouse: WarehouseContext,
  ): Promise<InventoryMovementPage> {
    const itemId = query.item ? (await this.inventory.getItemByCode(query.item)).id : undefined;
    const page = await this.inventory.movementsPage({
      ...query,
      itemId,
      locationId: warehouse.locationId,
    });
    const [sources, bottles] = await Promise.all([
      this.procurement.describeSources(
        page.items.flatMap((m) => m.receiptLineId ?? []),
        page.items.flatMap((m) => m.receiptCorrectionId ?? []),
      ),
      this.bottles.bottleCodesOfEvents(page.items.flatMap((m) => m.bottleEventId ?? [])),
    ]);
    return {
      items: page.items.map((m) => {
        const line = m.receiptLineId ? sources.lines.get(m.receiptLineId) : undefined;
        const correction = m.receiptCorrectionId
          ? sources.corrections.get(m.receiptCorrectionId)
          : undefined;
        return {
          id: m.id,
          type: m.type,
          item: { code: m.item.code, name: m.item.name, unitCode: m.item.baseUnit.code },
          lot: m.lot ? { id: m.lot.id, code: m.lot.code } : null,
          quantityDelta: formatQuantity(m.quantityDelta),
          balanceAfter: formatQuantity(m.balanceAfter),
          occurredAt: m.occurredAt.toISOString(),
          recordedAt: m.recordedAt.toISOString(),
          source: {
            receiptCode: line?.receiptCode ?? correction?.receiptCode ?? null,
            receiptLineNo: line?.lineNo ?? correction?.lineNo ?? null,
            correctionReason: correction?.reason ?? null,
            bottleCode: m.bottleEventId ? (bottles.get(m.bottleEventId) ?? null) : null,
          },
        };
      }),
      page: query.page,
      pageSize: query.pageSize,
      total: page.total,
    };
  }

  async recentApplications(limit: number): Promise<RecentLabelApplication[]> {
    const events = await this.bottles.recentLabelApplications(limit);
    const movements = await this.inventory.movementsForBottleEvents(events.map((e) => e.id));
    const lotOf = new Map(
      movements.filter((m) => m.lot).map((m) => [m.bottleEventId!, m.lot!.code]),
    );
    return events.map((e) => ({
      bottleCode: e.bottle.code,
      appliedAt: e.occurredAt.toISOString(),
      lotCode: lotOf.get(e.id) ?? '—',
    }));
  }

  async physical(code: string): Promise<BottlePhysical> {
    const bottle = await this.bottles.physicalByCode(code);
    const event = bottle.events[0];
    const jobCodes = await this.printJobs.codesByIds(
      bottle.components.flatMap((c) => c.printJobId ?? []),
    );
    let labelApplication: BottlePhysical['labelApplication'] = null;
    if (event) {
      const movements = await this.inventory.movementsForBottleEvents([event.id]);
      const lot = movements.find((m) => m.lot)?.lot;
      if (lot) {
        const first = (await this.procurement.firstReceiptLineOfLots([lot.id])).get(lot.id);
        labelApplication = {
          appliedAt: event.occurredAt.toISOString(),
          lot: { id: lot.id, code: lot.code },
          receipt: first ? { code: first.receipt.code, lineNo: first.lineNo } : null,
          supplier: first
            ? { id: first.receipt.supplier.id, name: first.receipt.supplier.name }
            : null,
        };
      }
    }
    return {
      labelApplication,
      components: bottle.components.map((c) => ({
        type: c.componentType,
        labelQrUrl: c.labelQrUrl,
        printJobCode: c.printJobId ? (jobCodes.get(c.printJobId) ?? null) : null,
        installedAt: c.installedAt.toISOString(),
        removedAt: c.removedAt?.toISOString() ?? null,
        removalReason: c.removalReason,
        disposition: c.disposition,
      })),
    };
  }
}

/** target − available, rounded up to the purchase multiple; null without a target. Advisory. */
export function suggestion(
  available: Prisma.Decimal,
  settings:
    | {
        reorderPoint: Prisma.Decimal | null;
        targetLevel: Prisma.Decimal | null;
        purchaseMultiple: Prisma.Decimal | null;
      }
    | undefined,
): string | null {
  if (
    !settings?.targetLevel ||
    !settings.reorderPoint ||
    !available.lessThan(settings.reorderPoint)
  ) {
    return null;
  }
  let needed = settings.targetLevel.minus(available);
  if (needed.lessThanOrEqualTo(0)) return null;
  if (settings.purchaseMultiple) {
    needed = needed.dividedBy(settings.purchaseMultiple).ceil().times(settings.purchaseMultiple);
  }
  return formatQuantity(needed);
}

function toItemDto(item: InventoryItemRecord, names: Map<string, string>): InventoryItem {
  const s = item.settings[0];
  return {
    id: item.id,
    code: item.code,
    name: item.name,
    kind: item.kind,
    unit: {
      code: item.baseUnit.code,
      name: item.baseUnit.name,
      decimalPlaces: item.baseUnit.decimalPlaces,
    },
    lotTracked: item.lotTracking === 'REQUIRED',
    archivedAt: item.archivedAt?.toISOString() ?? null,
    settings: s
      ? {
          version: s.version,
          reorderPoint: s.reorderPoint ? formatQuantity(s.reorderPoint) : null,
          targetLevel: s.targetLevel ? formatQuantity(s.targetLevel) : null,
          preferredSupplier: s.preferredSupplierId
            ? { id: s.preferredSupplierId, name: names.get(s.preferredSupplierId) ?? '—' }
            : null,
          leadTimeDays: s.leadTimeDays,
          purchaseMultiple: s.purchaseMultiple ? formatQuantity(s.purchaseMultiple) : null,
          validFrom: s.validFrom.toISOString(),
        }
      : null,
  };
}

function toLotDto(
  lot: {
    id: string;
    code: string;
    kind: 'SUPPLIER' | 'INTERNAL';
    supplierId: string | null;
    createdAt: Date;
  },
  onHand: Prisma.Decimal,
  names: Map<string, string>,
): InventoryLot {
  return {
    id: lot.id,
    code: lot.code,
    kind: lot.kind,
    supplier: lot.supplierId
      ? { id: lot.supplierId, name: names.get(lot.supplierId) ?? '—' }
      : null,
    onHand: formatQuantity(onHand),
    createdAt: lot.createdAt.toISOString(),
  };
}
