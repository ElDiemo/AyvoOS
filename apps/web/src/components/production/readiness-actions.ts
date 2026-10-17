import type { PermissionCode, ProductionReadiness, ReadinessItem } from '@ayvo/types';
import { readinessCs } from '@/i18n/cs/readiness';

const t = readinessCs.actions;

/**
 * The concrete next step for a missing readiness item (issue #11 UI-21): the existing page where
 * it is done, offered only with the permission that page needs — otherwise null and the overview
 * says "Požádejte vedoucího". It creates, approves or reserves nothing by itself.
 */
type Step = { label: string; href: (productHref: string) => string; anyOf: PermissionCode[] };

const STEPS: Record<string, Step> = {
  'setup.site': { label: t.site, href: () => '/admin/sites', anyOf: ['sites:manage'] },
  'setup.warehouse': { label: t.warehouse, href: () => '/admin/sites', anyOf: ['sites:manage'] },
  'setup.product': {
    label: t.product,
    href: () => '/production/catalog',
    anyOf: ['catalog:product_manage'],
  },
  'setup.recipe': {
    label: t.recipe,
    href: (p) => p,
    anyOf: ['catalog:product_manage', 'catalog:recipe_approve'],
  },
  'setup.design': {
    label: t.design,
    href: (p) => `${p}#designs`,
    anyOf: ['catalog:product_manage'],
  },
  'labeling.station': {
    label: t.labelingStation,
    href: () => '/production/workstations',
    anyOf: ['production:workstations_manage'],
  },
  'labeling.labels': {
    label: t.labels,
    href: () => '/bottles/new',
    anyOf: ['production:bottles_create'],
  },
  'labeling.crate': {
    label: t.crate,
    href: () => '/production/crates/new',
    anyOf: ['crates:register'],
  },
  'labeling.bottles': {
    label: t.bottles,
    href: () => '/warehouse/receipts/new',
    anyOf: ['inventory:receive'],
  },
  'labeling.labelStock': {
    label: t.labelStock,
    href: () => '/warehouse/receipts/new',
    anyOf: ['inventory:receive'],
  },
  'filling.station': {
    label: t.fillingStation,
    href: () => '/production/workstations',
    anyOf: ['production:workstations_manage'],
  },
  'filling.crates': {
    label: t.fillingCrates,
    href: () => '/production/station',
    anyOf: ['production:label_apply'],
  },
  'filling.liquid': {
    label: t.liquid,
    href: () => '/warehouse/receipts/new',
    anyOf: ['inventory:receive'],
  },
  'filling.pumps': {
    label: t.pumps,
    href: () => '/warehouse/receipts/new',
    anyOf: ['inventory:receive'],
  },
};

export function readinessStep(
  item: ReadinessItem,
  permissions: readonly string[],
  productHref: string,
): { label: string; href: string } | null {
  const step = STEPS[item.key];
  if (!step || !step.anyOf.some((p) => permissions.includes(p))) return null;
  return { label: step.label, href: step.href(productHref) };
}

/** A missing item that waits for another one first (explained, never an extra gate). */
export function readinessDependency(item: ReadinessItem, r: ProductionReadiness): string | null {
  const missing = (key: string) =>
    [...r.setup, ...r.labeling, ...r.filling].some((i) => i.key === key && i.state === 'MISSING');
  if (item.key === 'labeling.labels' && missing('setup.design')) return t.needsDesign;
  if (item.key === 'labeling.crate' && missing('setup.recipe')) return t.needsRecipe;
  if (item.key === 'setup.design' && missing('setup.recipe')) return null;
  if (item.key === 'filling.crates') return t.cratesComeFromLabeling;
  if (item.reason === 'NO_WAREHOUSE') return t.needsWarehouse;
  return null;
}
