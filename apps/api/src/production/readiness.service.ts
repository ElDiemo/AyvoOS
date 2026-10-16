import type {
  PermissionCode,
  ProductionReadiness,
  ProductionReadinessQuery,
  ReadinessItem,
} from '@ayvo/types';
import { Injectable } from '@nestjs/common';
import { ProductLabelApprovalsService } from '../catalog/product-label-approvals.service.js';
import { RecipesService } from '../catalog/recipes.service.js';
import { domainError } from '../common/domain-error.js';
import { quantity } from '../common/quantity.js';
import { PrismaService } from '../database/prisma.service.js';
import type { Prisma } from '../generated/prisma/client.js';
import type { Principal } from '../identity/principal.js';

/** Who may open the overview at all (doc 027 §3); each item still needs its own permission. */
const ENTRY: readonly PermissionCode[] = [
  'production:workstations_manage',
  'catalog:product_manage',
];

/**
 * "Připravit výrobu" (doc 027 §4): a read-only aggregate over existing data for the session's
 * active site and one product. It never widens access: every item is computed only with the
 * existing permission its own page needs (stock and lots also only in the user's warehouses of
 * that site) and is UNAVAILABLE otherwise — no count, never 0, never OK. No prices, no lot codes.
 * It permits, blocks and reserves nothing.
 */
@Injectable()
export class ReadinessService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly recipes: RecipesService,
    private readonly approvals: ProductLabelApprovalsService,
  ) {}

  async readiness(
    principal: Principal,
    query: ProductionReadinessQuery,
  ): Promise<ProductionReadiness> {
    if (!ENTRY.some((p) => principal.permissions.has(p))) {
      throw domainError(403, 'FORBIDDEN', 'You may not view production readiness');
    }
    const site = principal.activeSite;
    if (!site) throw domainError(403, 'SITE_REQUIRED', 'Choose the site you are working at first');
    const has = (p: PermissionCode) => principal.permissions.has(p);
    const warehouses = [...site.warehouseIds];
    const db = this.prisma;

    const unavailable = (key: string): ReadinessItem => ({
      key,
      state: 'UNAVAILABLE',
      count: null,
      href: null,
    });
    const item = (key: string, count: number, href: string | null, ok = count > 0) => ({
      key,
      state: ok ? ('OK' as const) : ('MISSING' as const),
      count,
      href,
    });
    /** Stock of an item in the user's warehouses of the active site (inventory:read only). */
    const stock = async (itemId: string): Promise<Prisma.Decimal | null> => {
      if (!has('inventory:read') || warehouses.length === 0) return null;
      const agg = await db.inventoryBalance.aggregate({
        where: { itemId, locationId: { in: warehouses } },
        _sum: { onHand: true },
      });
      return agg._sum.onHand ?? quantity(0);
    };

    const catalog = has('catalog:read');
    const products = catalog
      ? await db.product.findMany({
          where: { status: 'ACTIVE' },
          select: { id: true, code: true, name: true, categoryCode: true },
          orderBy: { code: 'asc' },
        })
      : [];
    const product = catalog
      ? (products.find((p) => p.code === query.product) ?? products[0] ?? null)
      : null;
    const result: ProductionReadiness = {
      site: { code: site.code, name: site.name },
      products: products.map((p) => ({ code: p.code, name: p.name })),
      product: product
        ? { code: product.code, name: product.name, category: product.categoryCode }
        : null,
      setup: [item('setup.site', site.capabilities.includes('PRODUCTION') ? 1 : 0, null)],
      labeling: [],
      filling: [],
      crates: null,
    };
    if (!product) {
      result.setup.push(
        catalog ? item('setup.product', 0, '/production/catalog') : unavailable('setup.product'),
      );
      return result;
    }
    const productHref = `/production/catalog/products/${product.code}`;

    // --- permanent setup (catalog:read) ---------------------------------------------------------
    const recipe = await this.recipes.activeVersion(db, product.id);
    const designs = (await this.approvals.openDesigns([product.id])).get(product.id) ?? [];
    result.setup.push(
      item('setup.product', 1, productHref),
      // An ACTIVE recipe was complete when activated (every required component, both stages).
      item('setup.recipe', recipe ? 1 : 0, productHref),
      item('setup.design', designs.length, productHref),
    );
    const laLines = recipe
      ? await this.recipes.stageBomLines(db, recipe.id, 'LABEL_APPLICATION')
      : [];
    const flLines = recipe ? await this.recipes.stageBomLines(db, recipe.id, 'FILL') : [];
    const crateTypeId = recipe ? await this.recipes.crateTypeOf(db, recipe.id) : null;

    // --- can labelling start? -------------------------------------------------------------------
    const stations = async (mode: 'LABELING' | 'FILLING', key: string) =>
      has('production:workstations_manage')
        ? item(
            key,
            await db.workstation.count({
              where: {
                siteId: site.id,
                status: 'ACTIVE',
                mode,
                ...(mode === 'FILLING' ? { categoryCode: product.categoryCode } : {}),
              },
            }),
            '/production/workstations',
          )
        : unavailable(key);
    result.labeling.push(await stations('LABELING', 'labeling.station'));
    // Labels READY TO PRINT: identities with an approved design whose PDF was generated by a
    // completed print job, still unlabelled. Physical printing is not recorded — not claimed.
    result.labeling.push(
      has('production:read')
        ? item(
            'labeling.labels',
            designs.length === 0
              ? 0
              : await db.bottle.count({
                  where: {
                    siteId: site.id,
                    status: 'CREATED',
                    creationBatch: { labelTemplateVersionId: { in: designs } },
                    printJobItems: { some: { printJob: { status: 'COMPLETED' } } },
                  },
                }),
            '/bottles?status=CREATED',
          )
        : unavailable('labeling.labels'),
    );
    // A crate of the recipe's type: empty, or assembling exactly this product, design and
    // pinned recipe version (the existing rules; never a rewrite of an open crate).
    result.labeling.push(
      has('crates:read') && recipe && crateTypeId
        ? item(
            'labeling.crate',
            await db.crate.count({
              where: {
                siteId: site.id,
                status: 'ACTIVE',
                crateTypeId,
                OR: [
                  { cycles: { none: { status: { not: 'ABORTED' } } } },
                  {
                    cycles: {
                      some: {
                        status: 'OPEN_ASSEMBLY',
                        productId: product.id,
                        recipeVersionId: recipe.id,
                        labelTemplateVersionId: { in: designs },
                      },
                    },
                  },
                ],
              },
            }),
            '/production/crates',
          )
        : has('crates:read')
          ? item('labeling.crate', 0, '/production/crates')
          : unavailable('labeling.crate'),
    );
    for (const [key, kind] of [
      ['labeling.bottles', 'NEW_BOTTLE'],
      ['labeling.labelStock', 'LABEL_MEDIA'],
    ] as const) {
      const line = laLines.find((l) => l.item.kind === kind);
      const onHand = line ? await stock(line.itemId) : null;
      result.labeling.push(
        !has('inventory:read')
          ? unavailable(key)
          : item(
              key,
              line && onHand ? Math.floor(onHand.div(line.quantity).toNumber()) : 0,
              '/warehouse/stock',
            ),
      );
    }

    // --- can filling start? ---------------------------------------------------------------------
    result.filling.push(await stations('FILLING', 'filling.station'));
    result.filling.push(
      has('crates:read')
        ? item(
            'filling.crates',
            await db.crateCycle.count({
              where: {
                siteId: site.id,
                productId: product.id,
                status: { in: ['READY_TO_FILL', 'FILLING'] },
              },
            }),
            '/production/crates?state=READY_TO_FILL',
          )
        : unavailable('filling.crates'),
    );
    for (const [key, kind] of [
      ['filling.liquid', 'BULK_LIQUID'],
      ['filling.pumps', 'PUMP'],
    ] as const) {
      const line = flLines.find((l) => l.item.kind === kind);
      const onHand = line ? await stock(line.itemId) : null;
      // Bottles' worth of the current stock (not a reservation, not a shift guarantee).
      result.filling.push(
        !has('inventory:read')
          ? unavailable(key)
          : item(
              key,
              line && onHand ? Math.floor(onHand.div(line.quantity).toNumber()) : 0,
              '/warehouse/stock',
            ),
      );
    }

    // --- real crate states of the product ------------------------------------------------------
    if (has('crates:read')) {
      const rows = await db.crateCycle.groupBy({
        by: ['status'],
        where: { siteId: site.id, productId: product.id, status: { not: 'ABORTED' } },
        _count: { _all: true },
      });
      const n = (s: string) => rows.find((r) => r.status === s)?._count._all ?? 0;
      result.crates = {
        openAssembly: n('OPEN_ASSEMBLY'),
        readyToFill: n('READY_TO_FILL'),
        filling: n('FILLING'),
        filled: n('FILLED'),
      };
    }
    return result;
  }
}
