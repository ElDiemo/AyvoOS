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

    const unavailable = (
      key: string,
      reason: 'PERMISSION' | 'NO_WAREHOUSE' = 'PERMISSION',
    ): ReadinessItem => ({
      key,
      state: 'UNAVAILABLE',
      count: null,
      href: null,
      reason,
      recipe: null,
      target: null,
    });
    const item = (key: string, count: number, href: string | null): ReadinessItem => ({
      key,
      state: count > 0 ? 'OK' : 'MISSING',
      count,
      href,
      reason: null,
      recipe: null,
      target: null,
    });
    const targetOf = (t: Partial<NonNullable<ReadinessItem['target']>>) => ({
      item: null,
      designs: [],
      station: null,
      ...t,
    });
    /**
     * Whole doses of a recipe line in stock (inventory:read only; the user's warehouses of the
     * active site — with none, the site has no warehouse at all and stock is unknown, never 0).
     * Every dose comes from ONE lot in ONE warehouse (one bottle = one lot, the operation never
     * mixes lots), so remainders of different lots/warehouses are never added together.
     */
    const doses = async (
      key: string,
      line:
        | { itemId: string; quantity: Prisma.Decimal; item: { code: string; name: string } }
        | undefined,
    ): Promise<ReadinessItem> => {
      if (!has('inventory:read')) return unavailable(key);
      if (warehouses.length === 0) return unavailable(key, 'NO_WAREHOUSE');
      if (!line) return item(key, 0, '/warehouse/stock');
      const target = targetOf({ item: { code: line.item.code, name: line.item.name } });
      const rows = await db.inventoryBalance.findMany({
        where: { itemId: line.itemId, locationId: { in: warehouses }, onHand: { gt: quantity(0) } },
        select: { onHand: true },
      });
      const n = rows.reduce(
        (sum, r) => sum + Math.floor(r.onHand.div(line.quantity).toNumber()),
        0,
      );
      return { ...item(key, n, '/warehouse/stock'), target };
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
      setup: [
        item('setup.site', site.capabilities.includes('PRODUCTION') ? 1 : 0, null),
        // A producing site without a warehouse cannot hold stock, stations or crates: say so
        // instead of reporting zero stock (sites:manage creates warehouses, else ask).
        item('setup.warehouse', warehouses.length, has('sites:manage') ? '/admin/sites' : null),
      ],
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
    const crateTypeId = recipe ? await this.recipes.crateTypeOf(db, recipe.id) : null;

    // --- can labelling start? -------------------------------------------------------------------
    const stations = async (mode: 'LABELING' | 'FILLING', key: string) =>
      has('production:workstations_manage')
        ? {
            ...item(
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
            ),
            target: targetOf({
              station: { mode, categoryCode: mode === 'FILLING' ? product.categoryCode : null },
            }),
          }
        : unavailable(key);
    result.labeling.push(await stations('LABELING', 'labeling.station'));
    // Labels READY TO PRINT: identities with an approved design whose PDF was generated by a
    // completed print job, still unlabelled. Physical printing is not recorded — not claimed.
    // Approved designs usable for NEW identities: the latest version of an active template (new
    // creation batches accept nothing else) — offered as the explicit choices of the next step.
    const usable = has('production:read')
      ? await db.labelTemplateVersion.findMany({
          where: { id: { in: designs }, template: { archivedAt: null } },
          select: {
            id: true,
            versionNumber: true,
            template: {
              select: {
                name: true,
                versions: { orderBy: { versionNumber: 'desc' }, take: 1, select: { id: true } },
              },
            },
          },
          orderBy: [{ template: { name: 'asc' } }],
        })
      : [];
    const usableDesigns = usable
      .filter((v) => v.template.versions[0]?.id === v.id)
      .map((v) => ({ versionId: v.id, label: `${v.template.name} v${v.versionNumber}` }));
    result.labeling.push(
      has('production:read')
        ? {
            ...item(
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
            ),
            target: targetOf({ designs: usableDesigns }),
          }
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
    // New labelling pins the active recipe version: its materials decide.
    for (const [key, kind] of [
      ['labeling.bottles', 'NEW_BOTTLE'],
      ['labeling.labelStock', 'LABEL_MEDIA'],
    ] as const) {
      result.labeling.push(
        await doses(
          key,
          laLines.find((l) => l.item.kind === kind),
        ),
      );
    }

    // --- can filling start? ---------------------------------------------------------------------
    result.filling.push(await stations('FILLING', 'filling.station'));
    // Crates waiting for filling, per the recipe version pinned on their cycle.
    const waiting = has('crates:read')
      ? await db.crateCycle.groupBy({
          by: ['recipeVersionId'],
          where: {
            siteId: site.id,
            productId: product.id,
            status: { in: ['READY_TO_FILL', 'FILLING'] },
          },
          _count: { _all: true },
        })
      : [];
    result.filling.push(
      has('crates:read')
        ? item(
            'filling.crates',
            waiting.reduce((n, w) => n + w._count._all, 0),
            '/production/crates?state=READY_TO_FILL',
          )
        : unavailable('filling.crates'),
    );
    // Filling uses the version pinned on each crate's cycle (never the active one), so liquid and
    // pumps are judged per pinned version of the waiting crates. With no waiting crate (or no
    // crates:read), the active version is shown as the plan for new crates, marked as such.
    const versions = await db.recipeVersion.findMany({
      where: {
        id: {
          in:
            waiting.length > 0 ? waiting.map((w) => w.recipeVersionId) : recipe ? [recipe.id] : [],
        },
      },
      select: { id: true, version: true },
      orderBy: { version: 'asc' },
    });
    for (const version of versions) {
      const lines = await this.recipes.stageBomLines(db, version.id, 'FILL');
      const crates = waiting.find((w) => w.recipeVersionId === version.id)?._count._all ?? null;
      for (const [key, kind] of [
        ['filling.liquid', 'BULK_LIQUID'],
        ['filling.pumps', 'PUMP'],
      ] as const) {
        // Whole bottles' worth of current stock (not a reservation, not a shift guarantee).
        const it = await doses(
          key,
          lines.find((l) => l.item.kind === kind),
        );
        result.filling.push({ ...it, recipe: { version: version.version, waitingCrates: crates } });
      }
    }
    if (versions.length === 0) {
      result.filling.push(
        await doses('filling.liquid', undefined),
        await doses('filling.pumps', undefined),
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
