import { describe, expect, it } from 'vitest';
import { locate, MODULES, visibleModules } from './navigation';

const where = (path: string) => {
  const { module, page } = locate(path);
  return module && page ? `${module.id}/${page.id}` : null;
};

describe('AYVO OS navigation (doc 019)', () => {
  it('has exactly two operational modules: Sklad and Výroba', () => {
    expect(visibleModules().map((m) => m.label)).toEqual(['Sklad', 'Výroba']);
  });

  it('keeps label application out of the warehouse and inside production', () => {
    const warehouse = MODULES.find((m) => m.id === 'warehouse')!;
    const production = MODULES.find((m) => m.id === 'production')!;
    expect(warehouse.pages.map((p) => p.label)).toEqual([
      'Přehled skladu',
      'Příjem zboží',
      'Příjmy',
      'Stav skladu',
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
  });
});
