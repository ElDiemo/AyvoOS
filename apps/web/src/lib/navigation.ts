import type { PermissionCode } from '@ayvo/types';
import { carriersCs } from '../i18n/cs/carriers';
import { identityCs } from '../i18n/cs/identity';
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
/**
 * Groups inside a module (doc 027): Práce (the work entry, shown as a prominent button), Evidence
 * (records) and Nastavení (setup). Placement is orientation only, never authorization: the API
 * and each page check the permissions on their own.
 */
export type NavGroup = 'work' | 'records' | 'setup';

export interface NavPage {
  id: string;
  href: string;
  label: string;
  exact?: boolean;
  prefixes?: readonly string[];
  /** Hidden without this permission (visible to everyone who sees the module otherwise). */
  permission?: PermissionCode;
  /** Visible with ANY of these permissions — the same alternative the page checks itself. */
  anyOf?: readonly PermissionCode[];
  /** Group of the page; none = above the groups (the module overview). */
  group?: NavGroup;
  /**
   * The page belongs to Nastavení only for users who may change something there (any of these);
   * everyone else who may read it finds it under Evidence, labelled read-only (doc 027 §2).
   */
  setupWith?: readonly PermissionCode[];
  /** Set by visibleModules: the page is listed for reading only (no setup permission). */
  readOnly?: boolean;
}

export interface NavModule {
  id: 'sales' | 'finance' | 'warehouse' | 'production' | 'hotels' | 'dispatch' | 'admin';
  /**
   * Obchod (doc 034: before a hotel is a customer, apart from operations), the operational
   * modules ("Provoz") or the administration section ("Správa").
   */
  section: 'sales' | 'finance' | 'operations' | 'administration';
  label: string;
  href: string;
  description: string;
  /** Any one of these is required to see the module at all. */
  permissions: readonly PermissionCode[];
  pages: readonly NavPage[];
}

const w = shellCs.modules.warehouse;
const p = shellCs.modules.production;
const h = shellCs.modules.hotels;
const d = shellCs.modules.dispatch;
const s = shellCs.modules.sales;
const f = shellCs.modules.finance;

export const MODULES: readonly NavModule[] = [
  {
    // Obchod — hotel acquisition (doc 034): company-wide, no site; visibility by ownership (API).
    id: 'sales',
    section: 'sales',
    permissions: ['sales:work'],
    label: s.label,
    href: '/sales',
    description: s.description,
    pages: [
      {
        id: 'overview',
        href: '/sales',
        label: s.pages.overview,
        exact: true,
        permission: 'sales:work',
      },
      {
        id: 'prospects',
        href: '/sales/prospects',
        label: s.pages.prospects,
        permission: 'sales:work',
      },
      { id: 'tasks', href: '/sales/tasks', label: s.pages.tasks, permission: 'sales:work' },
    ],
  },
  {
    // Finance (doc 039): company-wide, no site; received documents first (N1).
    id: 'finance',
    section: 'finance',
    permissions: [
      'finance:documents_read',
      'finance:invoices_read',
      'finance:bank_read',
      'finance:issuer_manage',
    ],
    label: f.label,
    href: '/finance/documents',
    description: f.description,
    pages: [
      {
        id: 'documents',
        href: '/finance/documents',
        label: f.pages.documents,
        permission: 'finance:documents_read',
      },
      {
        id: 'invoices',
        href: '/finance/invoices',
        label: f.pages.invoices,
        permission: 'finance:invoices_read',
      },
      {
        id: 'exports',
        href: '/finance/exports',
        label: f.pages.exports,
        permission: 'finance:documents_read',
      },
      {
        id: 'bank',
        href: '/finance/bank',
        label: f.pages.bank,
        permission: 'finance:bank_read',
      },
      {
        id: 'issuer',
        href: '/finance/settings/company',
        label: f.pages.issuer,
        permission: 'finance:issuer_manage',
      },
    ],
  },
  {
    id: 'warehouse',
    section: 'operations',
    permissions: ['inventory:read', 'inventory:stock_summary'],
    label: w.label,
    href: '/warehouse',
    description: w.description,
    pages: [
      {
        id: 'overview',
        href: '/warehouse',
        label: w.pages.overview,
        exact: true,
        permission: 'inventory:read',
      },
      {
        id: 'new-receipt',
        href: '/warehouse/receipts/new',
        label: w.pages.newReceipt,
        permission: 'inventory:receive',
      },
      {
        id: 'receipts',
        href: '/warehouse/receipts',
        label: w.pages.receipts,
        permission: 'inventory:read',
      },
      { id: 'stock', href: '/warehouse/stock', label: w.pages.stock, permission: 'inventory:read' },
      {
        id: 'availability',
        href: '/warehouse/availability',
        label: w.pages.availability,
        permission: 'inventory:stock_summary',
      },
      {
        id: 'movements',
        href: '/warehouse/movements',
        label: w.pages.movements,
        permission: 'inventory:read',
      },
      {
        id: 'suppliers',
        href: '/warehouse/suppliers',
        label: w.pages.suppliers,
        permission: 'inventory:read',
      },
    ],
  },
  {
    id: 'production',
    section: 'operations',
    // The company-wide catalogue (doc 023) is part of Výroba, readable without production access:
    // a catalogue-only user sees just that page (issue #17).
    // Bedny (physical crates, doc 025 A1) are readable by warehouse roles as well.
    permissions: [
      'production:read',
      'catalog:read',
      'crates:read',
      'production:fill',
      'production:label_apply',
      'production:workstations_manage',
    ],
    label: p.label,
    href: '/production',
    description: p.description,
    pages: [
      {
        id: 'overview',
        href: '/production',
        label: p.pages.overview,
        exact: true,
        permission: 'production:read',
      },
      {
        id: 'station',
        href: '/production/station',
        label: p.pages.station,
        group: 'work',
        // The station page admits either mode (issue #11 UI-15).
        anyOf: ['production:label_apply', 'production:fill'],
      },
      {
        id: 'crates',
        href: '/production/crates',
        label: p.pages.crates,
        group: 'records',
        permission: 'crates:read',
      },
      {
        id: 'bottles',
        href: '/bottles',
        label: p.pages.bottles,
        prefixes: ['/batches'],
        group: 'records',
        permission: 'production:read',
      },
      {
        id: 'setup',
        href: '/production/setup',
        label: p.pages.setup,
        group: 'setup',
        anyOf: ['production:workstations_manage', 'catalog:product_manage'],
      },
      {
        id: 'workstations',
        href: '/production/workstations',
        label: p.pages.workstations,
        group: 'setup',
        permission: 'production:workstations_manage',
      },
      {
        id: 'catalog',
        href: '/production/catalog',
        label: p.pages.catalog,
        group: 'setup',
        permission: 'catalog:read',
        setupWith: ['catalog:product_manage', 'catalog:recipe_approve'],
      },
      {
        id: 'templates',
        href: '/label-templates',
        label: p.pages.templates,
        group: 'setup',
        permission: 'production:read',
        setupWith: ['production:templates_manage'],
      },
    ],
  },
  {
    // Hotel master data (doc 028); company-wide.
    id: 'hotels',
    section: 'operations',
    permissions: ['hotels:read'],
    label: h.label,
    href: '/hotels',
    description: h.description,
    pages: [
      { id: 'list', href: '/hotels', label: h.pages.list, permission: 'hotels:read' },
      { id: 'new', href: '/hotels/new', label: h.pages.new, permission: 'hotels:manage' },
    ],
  },
  {
    // Orders of the active site and their picking (doc 028) — no carrier or delivery yet.
    id: 'dispatch',
    section: 'operations',
    permissions: ['orders:read'],
    label: d.label,
    href: '/dispatch',
    description: d.description,
    pages: [
      { id: 'orders', href: '/dispatch', label: d.pages.orders, permission: 'orders:read' },
      {
        id: 'new',
        href: '/dispatch/orders/new',
        label: d.pages.new,
        permission: 'orders:manage',
      },
    ],
  },
  {
    id: 'admin',
    section: 'administration',
    permissions: ['identity:users_read', 'sites:manage', 'carriers:connections_manage'],
    label: identityCs.admin.module,
    href: '/admin/users',
    description: identityCs.admin.subtitle,
    pages: [
      {
        id: 'users',
        href: '/admin/users',
        label: identityCs.admin.nav,
        permission: 'identity:users_read',
      },
      {
        id: 'roles',
        href: '/admin/roles',
        label: identityCs.roles_admin.nav,
        permission: 'identity:users_read',
      },
      {
        id: 'sites',
        href: '/admin/sites',
        label: identityCs.sites_admin.nav,
        permission: 'sites:manage',
      },
      {
        id: 'carriers',
        href: '/admin/carriers',
        label: carriersCs.connections.nav,
        permission: 'carriers:connections_manage',
      },
    ],
  },
];

export type WarehousePageId =
  'overview' | 'new-receipt' | 'receipts' | 'stock' | 'availability' | 'movements' | 'suppliers';
export type ProductionPageId =
  | 'overview'
  | 'bottles'
  | 'templates'
  | 'station'
  | 'crates'
  | 'workstations'
  | 'catalog'
  | 'setup';
export type AdminPageId = 'users' | 'roles' | 'sites' | 'carriers';
export type HotelsPageId = 'list' | 'new';
/** Finance (doc 039–041, UI-01): one strip, each page by its own permission. */
export type FinancePageId = 'documents' | 'invoices' | 'exports' | 'bank' | 'issuer';
export type DispatchPageId = 'orders' | 'new';
export type SalesPageId = 'overview' | 'prospects' | 'tasks';

/**
 * The modules and pages the signed-in user may open, filtered by the permissions the API reports
 * for the user (`/api/auth/me`). Hiding a link is never the security boundary: the API enforces
 * every permission on its own, and pages check again on the server.
 */
export function visibleModules(permissions: ReadonlySet<string> | readonly string[]): NavModule[] {
  const has = (p: string) =>
    permissions instanceof Set
      ? permissions.has(p)
      : (permissions as readonly string[]).includes(p);
  return MODULES.filter((m) => m.permissions.some(has)).flatMap((m) => {
    const pages = m.pages
      .filter(
        (page) =>
          (!page.permission || has(page.permission)) && (!page.anyOf || page.anyOf.some(has)),
      )
      .map((page): NavPage => {
        if (!page.setupWith || page.setupWith.some(has)) return page;
        // Readable, nothing to set up: listed under Evidence, read-only (doc 027 §2–3).
        return { ...page, group: 'records', readOnly: true };
      });
    // The module link opens the first page the user may see (e.g. SALES: availability only).
    return pages.length > 0 ? [{ ...m, href: pages[0]!.href, pages }] : [];
  });
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
