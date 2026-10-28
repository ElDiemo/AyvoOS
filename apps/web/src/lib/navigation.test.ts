import { describe, expect, it } from 'vitest';
import { locate, MODULES, visibleModules } from './navigation';

const where = (path: string) => {
  const { module, page } = locate(path);
  return module && page ? `${module.id}/${page.id}` : null;
};

describe('AYVO OS navigation (doc 019)', () => {
  it('has the operational modules Sklad, Výroba, Hotely and Expedice, plus the administration', () => {
    const all = MODULES.flatMap((m) => [
      ...m.permissions,
      ...m.pages.flatMap((p) => p.permission ?? []),
    ]);
    expect(
      visibleModules(all)
        .filter((m) => m.section === 'operations')
        .map((m) => m.label),
    ).toEqual(['Sklad', 'Výroba', 'Hotely', 'Expedice']);
    expect(
      visibleModules(all)
        .filter((m) => m.section === 'administration')
        .map((m) => m.label),
    ).toEqual(['Správa systému']);
  });

  it('Hotely and Expedice (doc 028) follow their own permissions only', () => {
    const ids = (perms: string[]) => visibleModules(perms).map((m) => m.id);
    // Existing operational permissions never open them.
    expect(ids(['inventory:read', 'production:read', 'crates:read'])).not.toEqual(
      expect.arrayContaining(['hotels']),
    );
    expect(ids(['inventory:read', 'crates:read', 'production:fill'])).not.toContain('dispatch');
    const pages = (perms: string[], id: string) =>
      visibleModules(perms)
        .find((m) => m.id === id)
        ?.pages.map((p) => p.id);
    expect(pages(['hotels:read'], 'hotels')).toEqual(['list']);
    expect(pages(['hotels:read', 'hotels:manage'], 'hotels')).toEqual(['list', 'new']);
    expect(pages(['orders:read', 'orders:pick'], 'dispatch')).toEqual(['orders']);
    expect(pages(['orders:read', 'orders:manage'], 'dispatch')).toEqual(['orders', 'new']);
    expect(ids(['orders:pick'])).not.toContain('dispatch'); // picking needs the order view too
  });

  it('administration pages follow their own permissions', () => {
    const admin = (perms: string[]) =>
      visibleModules(perms)
        .find((m) => m.id === 'admin')
        ?.pages.map((p) => p.id);
    expect(admin(['identity:users_read', 'sites:manage'])).toEqual(['users', 'roles', 'sites']);
    expect(admin(['identity:users_read'])).toEqual(['users', 'roles']);
    expect(admin(['sites:manage'])).toEqual(['sites']);
    expect(visibleModules(['sites:manage'])[0]!.href).toBe('/admin/sites');
    expect(admin(['inventory:read'])).toBeUndefined();
  });

  it('shows only what the permissions allow', () => {
    expect(visibleModules([]).map((m) => m.id)).toEqual([]);
    expect(visibleModules(['inventory:read']).map((m) => m.id)).toEqual(['warehouse']);
    // Without inventory:receive the receipt form is not offered.
    expect(visibleModules(['inventory:read'])[0]!.pages.map((p) => p.id)).not.toContain(
      'new-receipt',
    );
    expect(
      visibleModules(['inventory:read', 'inventory:receive'])[0]!.pages.map((p) => p.id),
    ).toContain('new-receipt');
    expect(visibleModules(['identity:users_read']).map((m) => m.id)).toEqual(['admin']);
  });

  it('SALES sees only Obchod with its three pages (doc 034)', () => {
    const modules = visibleModules(['sales:work']);
    expect(modules.map((m) => m.id)).toEqual(['sales']);
    expect(modules[0]!.section).toBe('sales');
    expect(modules[0]!.pages.map((p) => p.href)).toEqual([
      '/sales',
      '/sales/prospects',
      '/sales/tasks',
    ]);
    expect(locate('/sales/prospects/AKV-000001').page?.id).toBe('prospects');
    expect(locate('/sales').page?.id).toBe('overview');
  });

  it('a planning role sees only the availability page of the warehouse; the module link opens it', () => {
    const [warehouse, ...rest] = visibleModules(['inventory:stock_summary']);
    expect(rest).toEqual([]);
    expect(warehouse!.id).toBe('warehouse');
    expect(warehouse!.pages.map((p) => p.id)).toEqual(['availability']);
    expect(warehouse!.href).toBe('/warehouse/availability');
    // Full warehouse readers keep the overview as the module link and do not get the summary tab.
    const full = visibleModules(['inventory:read'])[0]!;
    expect(full.href).toBe('/warehouse');
    expect(full.pages.map((p) => p.id)).toEqual([
      'overview',
      'receipts',
      'stock',
      'movements',
      'suppliers',
    ]);
  });

  it('keeps label application out of the warehouse and inside production', () => {
    const warehouse = MODULES.find((m) => m.id === 'warehouse')!;
    const production = MODULES.find((m) => m.id === 'production')!;
    expect(warehouse.pages.map((p) => p.label)).toEqual([
      'Přehled skladu',
      'Příjem zboží',
      'Příjmy',
      'Stav skladu',
      'Dostupnost',
      'Pohyby',
      'Dodavatelé',
    ]);
    expect(production.pages.map((p) => p.label)).toEqual([
      'Přehled výroby',
      'Pracovat na pracovišti',
      'Bedny',
      'Lahve',
      'Připravit výrobu',
      'Pracoviště a QR',
      'Produkty a receptury',
      'Šablony etiket',
    ]);
    expect(warehouse.pages.some((p) => p.href.includes('label'))).toBe(false);
  });

  /** Production pages as `id:group` (+`(ro)` for a read-only listing) for a permission set. */
  const production = (perms: string[]) =>
    visibleModules(perms)
      .find((m) => m.id === 'production')
      ?.pages.map((p) => `${p.id}:${p.group ?? '-'}${p.readOnly ? '(ro)' : ''}`);

  it('the station is the work entry for EITHER labelling or filling (issue #11 UI-15)', () => {
    expect(production(['production:label_apply'])).toEqual(['station:work']);
    expect(production(['production:fill'])).toEqual(['station:work']);
    expect(production(['production:label_apply', 'production:fill'])).toEqual(['station:work']);
    expect(production([])).toBeUndefined();
    // The module opens on the station for a labelling-only role.
    expect(visibleModules(['production:label_apply'])[0]!.href).toBe('/production/station');
    expect(production(['production:workstations_manage'])).toEqual([
      'setup:setup',
      'workstations:setup',
    ]);
  });

  it('operator works and reads; supervisor and ADMIN also set up (doc 027 §3, roles unchanged)', () => {
    // The system roles' permissions (apps/api/test/identity.e2e.test.ts ROLE_MATRIX).
    const operator = [
      'production:read',
      'production:labels_print',
      'inventory:read',
      'catalog:read',
      'crates:read',
      'production:fill',
      'production:label_apply',
    ];
    const supervisor = [
      ...operator,
      'production:bottles_create',
      'catalog:product_manage',
      'catalog:recipe_approve',
      'crates:register',
      'production:workstations_manage',
      'production:session_takeover',
      'production:cycle_correct',
    ];
    // Operator: no Nastavení group — the catalogue and templates are read-only under Evidence.
    expect(production(operator)).toEqual([
      'overview:-',
      'station:work',
      'crates:records',
      'bottles:records',
      'catalog:records(ro)',
      'templates:records(ro)',
    ]);
    expect(production(supervisor)).toEqual([
      'overview:-',
      'station:work',
      'crates:records',
      'bottles:records',
      'setup:setup',
      'workstations:setup',
      'catalog:setup',
      'templates:records(ro)', // templates are company-wide: ADMIN edits them
    ]);
    expect(production([...supervisor, 'production:templates_manage'])).toContain('templates:setup');
  });

  it('opens Výroba → Bedny to warehouse roles with crates:read only (doc 025 A1)', () => {
    const modules = visibleModules(['inventory:read', 'inventory:receive', 'crates:read']);
    expect(modules.map((m) => m.id)).toEqual(['warehouse', 'production']);
    const production = modules.find((m) => m.id === 'production')!;
    expect(production.pages.map((p) => p.id)).toEqual(['crates']);
    expect(production.href).toBe('/production/crates');
  });

  it('places every existing URL in its module and page', () => {
    expect(where('/')).toBeNull();
    expect(where('/warehouse')).toBe('warehouse/overview');
    expect(where('/warehouse/receipts')).toBe('warehouse/receipts');
    expect(where('/warehouse/receipts/GR-000001')).toBe('warehouse/receipts');
    expect(where('/warehouse/receipts/new')).toBe('warehouse/new-receipt');
    expect(where('/warehouse/stock')).toBe('warehouse/stock');
    expect(where('/warehouse/availability')).toBe('warehouse/availability');
    expect(where('/production')).toBe('production/overview');
    // Bottles, series and templates keep their URLs but belong to Production.
    expect(where('/bottles')).toBe('production/bottles');
    expect(where('/bottles/history')).toBe('production/bottles');
    expect(where('/bottles/AYV-B-000001')).toBe('production/bottles');
    expect(where('/batches/BC-000001')).toBe('production/bottles');
    expect(where('/label-templates/abc/new-version')).toBe('production/templates');
    // Prefixes match whole path segments only.
    expect(where('/bottlesX')).toBeNull();
    expect(where('/warehouses')).toBeNull();
    expect(where('/admin/users/x')).toBe('admin/users');
    expect(where('/admin/roles/new')).toBe('admin/roles');
    expect(where('/admin/sites/x')).toBe('admin/sites');
  });

  it('Finance (doc 042): five work pages, views by permission, the settings apart; every former URL kept', () => {
    const finance = (...perms: string[]) => visibleModules(perms).find((m) => m.id === 'finance');
    const all = finance(
      'finance:documents_read',
      'finance:billing_read',
      'finance:invoices_read',
      'finance:bank_read',
      'finance:issuer_manage',
    )!;
    expect(all.pages.map((p) => [p.id, p.href, p.label, !!p.aside])).toEqual([
      ['overview', '/finance', 'Přehled', false],
      ['invoices', '/finance/invoices', 'Faktury hotelům', false],
      ['documents', '/finance/documents', 'Přijaté doklady', false],
      ['bank', '/finance/bank', 'Banka a platby', false],
      ['exports', '/finance/exports', 'Pro účetní', false],
      ['settings', '/finance/settings/company', 'Nastavení Financí', true],
    ]);
    expect(all.pages.find((p) => p.id === 'invoices')!.views!.map((v) => v.label)).toEqual([
      'Faktury',
      'Smlouvy a ceny',
    ]);
    expect(all.pages.find((p) => p.id === 'bank')!.views!.map((v) => v.label)).toEqual([
      'Pohyby z banky',
      'Platby a přiřazení',
    ]);
    // One strip, no sections (no page is grouped); the module opens on the overview.
    expect(all.pages.some((p) => p.group)).toBe(false);
    expect(all.href).toBe('/finance');
    // A page with views links to the first view the user may open, and lists only those.
    const billingOnly = finance('finance:billing_read')!;
    expect(billingOnly.pages.map((p) => [p.id, p.href])).toEqual([
      ['overview', '/finance'],
      ['invoices', '/finance/billing'],
    ]);
    expect(billingOnly.pages[1]!.views!.map((v) => v.id)).toEqual(['billing']);
    const invoicesOnly = finance('finance:invoices_read')!;
    expect(invoicesOnly.pages.map((p) => [p.id, p.href])).toEqual([
      ['overview', '/finance'],
      ['invoices', '/finance/invoices'],
      ['bank', '/finance/payments'],
    ]);
    expect(finance('finance:bank_read')!.pages.map((p) => [p.id, p.href])).toEqual([
      ['overview', '/finance'],
      ['bank', '/finance/bank'],
    ]);
    expect(finance('finance:issuer_manage')!.pages.map((p) => p.id)).toEqual([
      'overview',
      'settings',
    ]);
    expect(finance('sales:work')).toBeUndefined();
    // Every former URL belongs to its main page (details included).
    for (const [url, id] of [
      ['/finance', 'overview'],
      ['/finance/invoices', 'invoices'],
      ['/finance/invoices/new', 'invoices'],
      ['/finance/invoices/T2026-00001', 'invoices'],
      ['/finance/billing', 'invoices'],
      ['/finance/billing/agreements/BA-000001', 'invoices'],
      ['/finance/billing/customers/BC-000001', 'invoices'],
      ['/finance/documents', 'documents'],
      ['/finance/documents/new', 'documents'],
      ['/finance/documents/take-over', 'documents'],
      ['/finance/documents/FD-000001', 'documents'],
      ['/finance/bank', 'bank'],
      ['/finance/payments', 'bank'],
      ['/finance/exports', 'exports'],
      ['/finance/exports/AE-000001', 'exports'],
      ['/finance/settings/company', 'settings'],
    ] as const) {
      expect([url, locate(url).page?.id]).toEqual([url, id]);
    }
  });
});
