import {
  COMPONENT_KINDS,
  type CatalogComponent,
  type CreateComponentRequest,
  type CreateProductRequest,
  type Product,
  type ProductCategory,
} from '@ayvo/types';
import { Injectable, NotFoundException } from '@nestjs/common';
import { AuditService } from '../audit/audit.service.js';
import { domainError } from '../common/domain-error.js';
import { assertUnitScale, formatQuantity, quantity } from '../common/quantity.js';
import { isUniqueViolation } from '../common/unique-violation.js';
import { OperationRequestsService } from '../database/operation-requests.service.js';
import { PrismaService } from '../database/prisma.service.js';
import type {
  CatalogComponent as CatalogComponentRow,
  InventoryItem,
  InventoryItemKind,
  InventoryUnit,
  Prisma,
  ProductCategory as ProductCategoryRow,
} from '../generated/prisma/client.js';
import { InventoryService } from '../inventory/inventory.service.js';

/** An inventory item (read through InventoryService) with its catalogue profile. */
export type ComponentRecord = InventoryItem & {
  baseUnit: InventoryUnit;
  component: (CatalogComponentRow & { category: ProductCategoryRow | null }) | null;
};

export const productInclude = {
  category: true,
  recipes: {
    orderBy: { version: 'asc' as const },
    include: {
      basedOn: { select: { version: true } },
      revisions: { orderBy: { revision: 'desc' as const }, take: 1, select: { revision: true } },
    },
  },
} satisfies Prisma.ProductInclude;
export type ProductRecord = Prisma.ProductGetPayload<{ include: typeof productInclude }>;

export const toUnit = (u: InventoryUnit) => ({
  code: u.code,
  name: u.name,
  decimalPlaces: u.decimalPlaces,
});
const toCategory = (c: { code: string; name: string }): ProductCategory => ({
  code: c.code,
  name: c.name,
});

function toComponent(item: ComponentRecord): CatalogComponent {
  return {
    code: item.code,
    name: item.name,
    kind: item.kind as CatalogComponent['kind'],
    unit: toUnit(item.baseUnit),
    lotTracked: item.lotTracking === 'REQUIRED',
    category: item.component?.category ? toCategory(item.component.category) : null,
    packageCapacity: item.component?.packageCapacity ?? null,
    archived: item.archivedAt !== null,
  };
}

export function toProduct(p: ProductRecord, units: ReadonlyMap<string, InventoryUnit>): Product {
  return {
    code: p.code,
    name: p.name,
    category: toCategory(p.category),
    nominalQuantity: formatQuantity(p.nominalQuantity),
    nominalUnit: toUnit(units.get(p.nominalUnitId)!),
    createdAt: p.createdAt.toISOString(),
    activeVersion: p.recipes.find((r) => r.status === 'ACTIVE')?.version ?? null,
    versions: p.recipes.map((r) => ({
      version: r.version,
      status: r.status,
      revision: r.revisions[0]?.revision ?? 1,
      basedOnVersion: r.basedOn?.version ?? null,
      createdAt: r.createdAt.toISOString(),
      activatedAt: r.activatedAt?.toISOString() ?? null,
      archivedAt: r.archivedAt?.toISOString() ?? null,
    })),
  };
}

const codeTaken = (what: string) =>
  domainError(409, 'CODE_TAKEN', `${what} with this code already exists`);

/**
 * A unit allowed for a component kind: liquids are measured by volume (`ml`), everything a
 * bottle carries or a package holds is counted in pieces (`pcs`, shown as "ks"). No conversion.
 */
export function unitAllowedFor(kind: InventoryItemKind, unit: InventoryUnit): boolean {
  return kind === 'BULK_LIQUID' ? unit.dimension === 'VOLUME' : unit.code === 'pcs';
}

/**
 * catalog module (doc 023): the company-wide product catalogue — components (catalogue profiles
 * of inventory items), product categories and products. Holds no stock: quantities stay in the
 * ledger of each site's warehouses. Every change is idempotent per request id, needs a reason and
 * writes an audit event in the same transaction.
 */
@Injectable()
export class CatalogService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly operations: OperationRequestsService,
    private readonly audit: AuditService,
    private readonly inventory: InventoryService,
  ) {}

  categories(): Promise<ProductCategory[]> {
    return this.prisma.productCategory
      .findMany({ orderBy: { code: 'asc' } })
      .then((c) => c.map(toCategory));
  }

  // --- components --------------------------------------------------------------------------------

  /** Inventory items of component kinds, with their catalogue profile (if any). */
  async components(): Promise<CatalogComponent[]> {
    const items = await this.withProfiles(
      await this.inventory.itemsWithUnit({ kinds: COMPONENT_KINDS }),
    );
    return items.map(toComponent);
  }

  /** Items by code with base unit and catalogue profile (recipe validation). */
  async componentsByCode(
    codes: readonly string[],
    db: Prisma.TransactionClient = this.prisma,
  ): Promise<ComponentRecord[]> {
    return this.withProfiles(await this.inventory.itemsWithUnit({ codes }, db), db);
  }

  /** Joins the catalogue's own profiles to items read through the inventory module. */
  private async withProfiles(
    items: (InventoryItem & { baseUnit: InventoryUnit })[],
    db: Prisma.TransactionClient = this.prisma,
  ): Promise<ComponentRecord[]> {
    const profiles = new Map(
      (
        await db.catalogComponent.findMany({
          where: { itemId: { in: items.map((i) => i.id) } },
          include: { category: true },
        })
      ).map((c) => [c.itemId, c] as const),
    );
    return items.map((i) => ({ ...i, component: profiles.get(i.id) ?? null }));
  }

  private async unitsById(db: Prisma.TransactionClient = this.prisma) {
    return new Map((await this.inventory.listUnits(db)).map((u) => [u.id, u] as const));
  }

  /**
   * Creates a component: a new inventory item (never a receipt — no lot, movement or balance) and
   * its catalogue profile. Liquids and labels name the product category they are made for; only
   * packaging has a capacity, which may stay unknown (null).
   */
  async createComponent(actorId: string, input: CreateComponentRequest): Promise<CatalogComponent> {
    const { result } = await this.operations.run(
      'CATALOG_COMPONENT_CREATE',
      input.requestId,
      input,
      async (tx) => {
        const unit = await this.inventory.getUnitByCode(input.unitCode, tx);
        if (!unit) throw domainError(422, 'UNKNOWN_UNIT', 'Unknown unit');
        if (!unitAllowedFor(input.kind, unit)) {
          throw domainError(
            422,
            'UNIT_NOT_ALLOWED',
            input.kind === 'BULK_LIQUID'
              ? 'A liquid is measured in a volume unit such as ml'
              : 'This component is counted in pieces (pcs)',
          );
        }
        if (input.categoryCode === null && ['BULK_LIQUID', 'LABEL_MEDIA'].includes(input.kind)) {
          throw domainError(
            422,
            'CATEGORY_REQUIRED',
            'A liquid or a label names the product category it is made for',
          );
        }
        if (input.kind === 'NEW_BOTTLE' && !input.lotTracked) {
          throw domainError(
            422,
            'LOT_TRACKING_REQUIRED',
            'A bottle body must be lot-tracked (it is consumed from a chosen lot)',
          );
        }
        if (input.packageCapacity !== null && input.kind !== 'PACKAGING') {
          throw domainError(
            422,
            'PACKAGE_CAPACITY_NOT_ALLOWED',
            'Only packaging has a package capacity',
          );
        }
        if (
          input.categoryCode !== null &&
          !(await tx.productCategory.findUnique({ where: { code: input.categoryCode } }))
        ) {
          throw domainError(422, 'UNKNOWN_CATEGORY', 'Unknown product category');
        }
        if (await this.inventory.findItemByCode(input.code, tx)) {
          throw codeTaken('An item');
        }
        let itemId: string;
        try {
          itemId = (
            await this.inventory.createItem(tx, {
              code: input.code,
              name: input.name,
              kind: input.kind,
              unitId: unit.id,
              lotTracked: input.lotTracked,
            })
          ).id;
        } catch (error) {
          if (isUniqueViolation(error)) throw codeTaken('An item');
          throw error;
        }
        await tx.catalogComponent.create({
          data: {
            itemId,
            categoryCode: input.categoryCode,
            packageCapacity: input.packageCapacity,
            createdBy: actorId,
            operationRequestId: input.requestId,
          },
        });
        await this.audit.record(
          {
            type: 'CATALOG_COMPONENT_CREATED',
            actorUserId: actorId,
            reason: input.reason,
            payload: {
              component: input.code,
              name: input.name,
              kind: input.kind,
              unit: input.unitCode,
              lotTracked: input.lotTracked,
              category: input.categoryCode,
              packageCapacity: input.packageCapacity,
              requestId: input.requestId,
            },
          },
          tx,
        );
        const [created] = await this.componentsByCode([input.code], tx);
        return toComponent(created!);
      },
    );
    return result;
  }

  // --- products ----------------------------------------------------------------------------------

  async products(): Promise<Product[]> {
    const rows = await this.prisma.product.findMany({
      include: productInclude,
      orderBy: { code: 'asc' },
    });
    const units = await this.unitsById();
    return rows.map((r) => toProduct(r, units));
  }

  async product(code: string): Promise<Product> {
    const row = await this.prisma.product.findUnique({ where: { code }, include: productInclude });
    if (!row) throw new NotFoundException('Product not found');
    return toProduct(row, await this.unitsById());
  }

  async createProduct(actorId: string, input: CreateProductRequest): Promise<Product> {
    const { result } = await this.operations.run(
      'PRODUCT_CREATE',
      input.requestId,
      input,
      async (tx) => {
        if (!(await tx.productCategory.findUnique({ where: { code: input.categoryCode } }))) {
          throw domainError(422, 'UNKNOWN_CATEGORY', 'Unknown product category');
        }
        const unit = await this.inventory.getUnitByCode(input.nominalUnitCode, tx);
        if (!unit) throw domainError(422, 'UNKNOWN_UNIT', 'Unknown unit');
        const nominal = quantity(input.nominalQuantity);
        assertUnitScale(nominal, unit.decimalPlaces, 'Nominal quantity');
        if (await tx.product.findUnique({ where: { code: input.code } })) {
          throw codeTaken('A product');
        }
        let id: string;
        try {
          id = (
            await tx.product.create({
              data: {
                code: input.code,
                name: input.name,
                categoryCode: input.categoryCode,
                nominalQuantity: nominal,
                nominalUnitId: unit.id,
                createdBy: actorId,
                operationRequestId: input.requestId,
              },
            })
          ).id;
        } catch (error) {
          if (isUniqueViolation(error)) throw codeTaken('A product');
          throw error;
        }
        await this.audit.record(
          {
            type: 'PRODUCT_CREATED',
            actorUserId: actorId,
            reason: input.reason,
            payload: {
              product: input.code,
              name: input.name,
              category: input.categoryCode,
              nominalQuantity: formatQuantity(nominal),
              nominalUnit: unit.code,
              requestId: input.requestId,
            },
          },
          tx,
        );
        return toProduct(
          await tx.product.findUniqueOrThrow({ where: { id }, include: productInclude }),
          await this.unitsById(tx),
        );
      },
    );
    return result;
  }
}
