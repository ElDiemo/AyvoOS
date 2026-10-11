import { shellCs } from '../i18n/cs/shell';

/**
 * AYVO OS information architecture (doc 019): the application is organized by company
 * functions, not by database entities. Each operational module owns its pages; the global
 * navigation lists only the overview and the modules.
 *
 * `prefixes`: URL paths that belong to a page in addition to its own `href` — e.g. the bottle
 * pages keep their established URLs (/bottles, /batches) but belong to Production.
 * `exact`: the page matches only its own URL (module overviews), not everything below it.
 */
export interface NavPage {
  id: string;
  href: string;
  label: string;
  exact?: boolean;
  prefixes?: readonly string[];
}

export interface NavModule {
  id: 'warehouse' | 'production';
  label: string;
  href: string;
  description: string;
  pages: readonly NavPage[];
}

const w = shellCs.modules.warehouse;
const p = shellCs.modules.production;

export const MODULES: readonly NavModule[] = [
  {
    id: 'warehouse',
    label: w.label,
    href: '/warehouse',
    description: w.description,
    pages: [
      { id: 'overview', href: '/warehouse', label: w.pages.overview, exact: true },
      { id: 'new-receipt', href: '/warehouse/receipts/new', label: w.pages.newReceipt },
      { id: 'receipts', href: '/warehouse/receipts', label: w.pages.receipts },
      { id: 'stock', href: '/warehouse/stock', label: w.pages.stock },
      { id: 'movements', href: '/warehouse/movements', label: w.pages.movements },
      { id: 'suppliers', href: '/warehouse/suppliers', label: w.pages.suppliers },
    ],
  },
  {
    id: 'production',
    label: p.label,
    href: '/production',
    description: p.description,
    pages: [
      { id: 'overview', href: '/production', label: p.pages.overview, exact: true },
      { id: 'bottles', href: '/bottles', label: p.pages.bottles, prefixes: ['/batches'] },
      { id: 'templates', href: '/label-templates', label: p.pages.templates },
      {
        id: 'label-activation',
        href: '/production/label-activation',
        label: p.pages.labelActivation,
      },
    ],
  },
];

export type WarehousePageId =
  'overview' | 'new-receipt' | 'receipts' | 'stock' | 'movements' | 'suppliers';
export type ProductionPageId = 'overview' | 'bottles' | 'templates' | 'label-activation';

/**
 * The modules the current user may open. Application authentication and RBAC do not exist yet
 * (ADR 0017): on the DEV preview every implemented module is listed. When roles exist, this
 * becomes a server-side permission filter (the API enforces the same permissions); the shell
 * renders whatever it returns. Hiding a link is never the security boundary.
 */
export function visibleModules(): readonly NavModule[] {
  return MODULES;
}

const within = (pathname: string, prefix: string) =>
  pathname === prefix || pathname.startsWith(`${prefix}/`);

/** Length of the longest path of `page` matching `pathname` (0: no match). */
function matchLength(page: NavPage, pathname: string): number {
  if (page.exact) return pathname === page.href ? page.href.length : 0;
  return Math.max(
    0,
    ...[page.href, ...(page.prefixes ?? [])]
      .filter((prefix) => within(pathname, prefix))
      .map((prefix) => prefix.length),
  );
}

/** The module and page a URL belongs to (most specific match), or nulls for the overview. */
export function locate(
  pathname: string,
  modules: readonly NavModule[] = MODULES,
): { module: NavModule | null; page: NavPage | null } {
  let best: { module: NavModule; page: NavPage; length: number } | null = null;
  for (const m of modules) {
    for (const page of m.pages) {
      const length = matchLength(page, pathname);
      if (length > (best?.length ?? 0)) best = { module: m, page, length };
    }
  }
  return best ? { module: best.module, page: best.page } : { module: null, page: null };
}

export function moduleById(id: NavModule['id']): NavModule {
  return MODULES.find((m) => m.id === id)!;
}
