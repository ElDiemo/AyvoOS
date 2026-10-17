import type { PermissionCode, ProductionReadiness, ReadinessItem } from '@ayvo/types';
import { readinessCs } from '@/i18n/cs/readiness';
import { setupReturnFor } from '@/lib/setup-return';

const t = readinessCs.actions;

export type StepLink = { label: string; href: string };
export type StepResult =
  | { kind: 'links'; links: StepLink[] }
  /** The user cannot do it on the target page: ask (optionally with a read-only look). */
  | { kind: 'ask'; read: StepLink | null }
  | { kind: 'none' };

type Ctx = {
  item: ReadinessItem;
  productCode: string | null;
  productHref: string;
  back: string;
  q: (params: Record<string, string | null | undefined>) => string;
};

/**
 * The concrete next step of a missing readiness item (issue #11 UI-21, PR #30 review): the
 * existing page where it is done, opened in the context the overview knows (product, approved
 * design, stock item of the judged recipe, station mode and category) and with a way back to the
 * same product. A step is offered only when the user holds EVERY permission the target page
 * needs to really do it (`allOf`) — otherwise "Požádejte vedoucího". Nothing is filled in
 * (quantity, supplier, lot) and nothing is saved by following a step.
 */
type Step = { allOf: PermissionCode[]; links: (c: Ctx) => StepLink[] };

const receipt = (label: (name: string) => string): Step => ({
  allOf: ['inventory:read', 'inventory:receive'],
  links: (c) =>
    c.item.target?.item
      ? [
          {
            label: label(c.item.target.item.name),
            href: `/warehouse/receipts/new${c.q({ item: c.item.target.item.code, back: c.back })}`,
          },
        ]
      : [],
});

const station = (label: string): Step => ({
  allOf: ['production:workstations_manage', 'catalog:read'],
  links: (c) => {
    const s = c.item.target?.station;
    return [
      {
        label,
        href: `/production/workstations${c.q({ mode: s?.mode, category: s?.categoryCode, back: c.back })}`,
      },
    ];
  },
});

const STEPS: Record<string, Step> = {
  'setup.site': { allOf: ['sites:manage'], links: () => [{ label: t.site, href: '/admin/sites' }] },
  'setup.warehouse': {
    allOf: ['sites:manage'],
    links: () => [{ label: t.warehouse, href: '/admin/sites' }],
  },
  'setup.product': {
    allOf: ['catalog:read', 'catalog:product_manage'],
    links: () => [{ label: t.product, href: '/production/catalog/products/new' }],
  },
  // Finishing a draft (product_manage) and activating it (recipe_approve) are separate rights.
  'setup.recipe': {
    allOf: ['catalog:read', 'catalog:product_manage', 'catalog:recipe_approve'],
    links: (c) => [{ label: t.recipe, href: c.productHref }],
  },
  // The approval form lists label templates: it needs production:read as well.
  'setup.design': {
    allOf: ['catalog:read', 'catalog:product_manage', 'production:read'],
    links: (c) => [{ label: t.design, href: `${c.productHref}#designs` }],
  },
  'labeling.station': station(t.labelingStation),
  // One link per approved, usable design of THIS product — never the first template.
  'labeling.labels': {
    allOf: ['production:read', 'production:bottles_create', 'catalog:read'],
    links: (c) =>
      (c.item.target?.designs ?? []).map((d) => ({
        label: t.labelsFor(d.label),
        href: `/bottles/new${c.q({ product: c.productCode, version: d.versionId, back: c.back })}`,
      })),
  },
  'labeling.crate': {
    allOf: ['crates:register', 'catalog:read'],
    links: (c) => [{ label: t.crate, href: `/production/crates/new${c.q({ back: c.back })}` }],
  },
  'labeling.bottles': receipt(t.receive),
  'labeling.labelStock': receipt(t.receive),
  'filling.station': station(t.fillingStation),
  'filling.crates': {
    allOf: ['production:label_apply'],
    links: () => [{ label: t.fillingCrates, href: '/production/station' }],
  },
  'filling.liquid': receipt(t.receive),
  'filling.pumps': receipt(t.receive),
};

/** Read-only look for users who may read but not do the step (clearly labelled). */
const READ: Record<string, { allOf: PermissionCode[]; label: string; href: (c: Ctx) => string }> = {
  'setup.recipe': { allOf: ['catalog:read'], label: t.readProduct, href: (c) => c.productHref },
  'setup.design': { allOf: ['catalog:read'], label: t.readProduct, href: (c) => c.productHref },
};

export function readinessStep(
  item: ReadinessItem,
  permissions: readonly string[],
  productCode: string | null,
): StepResult {
  if (item.state !== 'MISSING') return { kind: 'none' };
  const has = (all: PermissionCode[]) => all.every((p) => permissions.includes(p));
  const productHref = productCode
    ? `/production/catalog/products/${productCode}`
    : '/production/catalog';
  const ctx: Ctx = {
    item,
    productCode,
    productHref,
    back: setupReturnFor(productCode),
    q: (params) => {
      const u = new URLSearchParams();
      for (const [k, v] of Object.entries(params)) if (v) u.set(k, v);
      const s = u.toString();
      return s ? `?${s}` : '';
    },
  };
  const step = STEPS[item.key];
  if (step && has(step.allOf)) {
    const links = step.links(ctx);
    if (links.length > 0) return { kind: 'links', links };
    return { kind: 'none' }; // a missing prerequisite is explained by readinessDependency
  }
  const read = READ[item.key];
  return {
    kind: 'ask',
    read: read && has(read.allOf) ? { label: read.label, href: read.href(ctx) } : null,
  };
}

/** A missing item that waits for another one first (explained, never an extra gate). */
export function readinessDependency(item: ReadinessItem, r: ProductionReadiness): string | null {
  const missing = (key: string) =>
    [...r.setup, ...r.labeling, ...r.filling].some((i) => i.key === key && i.state === 'MISSING');
  if (item.reason === 'NO_WAREHOUSE') return t.needsWarehouse;
  if (item.key === 'labeling.labels' && item.state === 'MISSING') {
    if (missing('setup.design')) return t.needsDesign;
    if ((item.target?.designs ?? []).length === 0) return t.noUsableDesign;
  }
  if (item.key === 'labeling.crate' && missing('setup.recipe')) return t.needsRecipe;
  if (item.key === 'filling.crates') return t.cratesComeFromLabeling;
  if (item.key.startsWith('filling.') && item.target?.item === null && item.state === 'MISSING') {
    return t.recipeLacksItem;
  }
  return null;
}
