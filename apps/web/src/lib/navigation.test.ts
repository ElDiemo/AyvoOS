import { describe, expect, it } from 'vitest';
import { locate, MODULES, visibleModules } from './navigation';

const where = (path: string) => {
  const { module, page } = locate(path);
  return module && page ? `${module.id}/${page.id}` : null;
};

describe('AYVO OS navigation (doc 019)', () => {
  it('has exactly two operational modules: Sklad and Výroba, plus the administration', () => {
    const all = MODULES.flatMap((m) => [
      ...m.permissions,
      ...m.pages.flatMap((p) => p.permission ?? []),
    ]);
    expect(
      visibleModules(all)
        .filter((m) => m.section === 'operations')
        .map((m) => m.label),
    ).toEqual(['Sklad', 'Výroba']);
    expect(
      visibleModules(all)
        .filter((m) => m.section === 'administration')
        .map((m) => m.label),
    ).toEqual(['Správa systému']);
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

  it('SALES sees only the availability page of the warehouse; the module link opens it', () => {
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
});
