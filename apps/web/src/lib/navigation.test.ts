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
    ).toEqual(['Správa']);
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
      'Lahve',
      'Šablony etiket',
      'Nalepení etiket',
    ]);
    expect(warehouse.pages.some((p) => p.href.includes('label'))).toBe(false);
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
    expect(where('/production/label-activation')).toBe('production/label-activation');
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
  });
});
