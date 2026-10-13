import type { CatalogComponent, CrateType } from '@ayvo/types';
import { describe, expect, it } from 'vitest';
import {
  attemptId,
  draftChanges,
  draftPayload,
  eligibleCrateTypes,
  eligibleItems,
  normalizeDecimal,
  parseBottles,
  type RecipeDraft,
} from './catalog-forms';
import { visibleModules } from './navigation';

const pcs = { code: 'pcs', name: 'kus', decimalPlaces: 0 };
const ml = { code: 'ml', name: 'mililitr', decimalPlaces: 3 };
const item = (
  code: string,
  kind: CatalogComponent['kind'],
  category: string | null,
  extra: Partial<CatalogComponent> = {},
): CatalogComponent => ({
  code,
  name: code,
  kind,
  unit: kind === 'BULK_LIQUID' ? ml : pcs,
  lotTracked: true,
  category: category ? { code: category, name: category } : null,
  packageCapacity: null,
  archived: false,
  ...extra,
});
const items = [
  item('BOTTLE', 'NEW_BOTTLE', null),
  item('SOAP', 'BULK_LIQUID', 'HAND_SOAP'),
  item('GEL', 'BULK_LIQUID', 'SHOWER_GEL'),
  item('OLD-SOAP', 'BULK_LIQUID', 'HAND_SOAP', { archived: true }),
  item('LABEL-SOAP', 'LABEL_MEDIA', 'HAND_SOAP'),
  item('PUMP', 'PUMP', null),
  item('PUMP-GEL', 'PUMP', 'SHOWER_GEL'),
];
const crates: CrateType[] = [
  { code: 'C40', name: 'Bedna 40', capacity: 40, categories: [{ code: 'HAND_SOAP', name: 'x' }] },
  { code: 'G24', name: 'Bedna 24', capacity: 24, categories: [{ code: 'SHOWER_GEL', name: 'y' }] },
];

describe('exact Czech quantities (no float, no rounding)', () => {
  it('normalizes Czech decimals to exact strings', () => {
    expect(normalizeDecimal('330')).toBe('330');
    expect(normalizeDecimal('0,5')).toBe('0.5');
    expect(normalizeDecimal(' 1 000,25 ')).toBe('1000.25');
    expect(normalizeDecimal('330,125')).toBe('330.125');
  });
  it('refuses instead of rounding', () => {
    for (const bad of ['', '0', '0,0', '-1', '1e3', '330,1255', 'abc', '1,2,3', '01'])
      expect(normalizeDecimal(bad), bad).toBeNull();
  });
  it('bottles: whole numbers 1 … 1 000 000', () => {
    expect(parseBottles('40')).toBe(40);
    expect(parseBottles('1 000 000')).toBe(1_000_000);
    for (const bad of ['0', '1,5', '1000001', '-3', 'x', ''])
      expect(parseBottles(bad), bad).toBeNull();
  });
});

describe('recipe rows offer only compatible, active items', () => {
  it('filters by kind, category and archive', () => {
    expect(eligibleItems(items, 'BULK_LIQUID', 'HAND_SOAP').map((i) => i.code)).toEqual(['SOAP']);
    expect(eligibleItems(items, 'PUMP', 'HAND_SOAP').map((i) => i.code)).toEqual(['PUMP']);
    expect(eligibleItems(items, 'PUMP', 'SHOWER_GEL').map((i) => i.code)).toEqual([
      'PUMP',
      'PUMP-GEL',
    ]);
    expect(eligibleItems(items, 'LABEL_MEDIA', 'SHOWER_GEL')).toEqual([]);
    expect(eligibleCrateTypes(crates, 'SHOWER_GEL').map((c) => c.code)).toEqual(['G24']);
  });
});

const empty = { itemCode: '', quantity: '' };
const draft = (over: Partial<RecipeDraft['rows']> = {}, crate = ''): RecipeDraft => ({
  crateTypeCode: crate,
  rows: { NEW_BOTTLE: empty, LABEL_MEDIA: empty, BULK_LIQUID: empty, PUMP: empty, ...over },
});
const labels = {
  rows: { NEW_BOTTLE: 'Lahev', LABEL_MEDIA: 'Etiketa', BULK_LIQUID: 'Kapalina', PUMP: 'Pumpička' },
  crate: 'Typ bedny',
  empty: 'nic',
};

describe('draft request and summary', () => {
  it('builds the request with the item units; the bottle body is always 1', () => {
    const d = draft(
      {
        NEW_BOTTLE: { itemCode: 'BOTTLE', quantity: '7' },
        BULK_LIQUID: { itemCode: 'SOAP', quantity: '330,5' },
      },
      'C40',
    );
    expect(draftPayload(d, items)).toEqual({
      payload: {
        crateTypeCode: 'C40',
        components: [
          { itemCode: 'BOTTLE', quantity: '1', unitCode: 'pcs' },
          { itemCode: 'SOAP', quantity: '330.5', unitCode: 'ml' },
        ],
      },
      invalid: [],
    });
    expect(
      draftPayload(draft({ PUMP: { itemCode: 'PUMP', quantity: '0' } }), items).invalid,
    ).toEqual(['PUMP']);
  });
  it('summarizes changes in Czech, nothing when equal', () => {
    const a = draft({ BULK_LIQUID: { itemCode: 'SOAP', quantity: '330' } });
    expect(draftChanges(a, a, items, crates, labels)).toEqual([]);
    expect(
      draftChanges(
        a,
        draft({ BULK_LIQUID: { itemCode: 'SOAP', quantity: '330,0' } }),
        items,
        crates,
        labels,
      ),
    ).toEqual([]);
    expect(
      draftChanges(
        a,
        draft({ BULK_LIQUID: { itemCode: 'SOAP', quantity: '300' } }),
        items,
        crates,
        labels,
      ),
    ).toEqual(['Kapalina: SOAP 330 ml → SOAP 300 ml']);
    expect(
      draftChanges(
        a,
        draft({ BULK_LIQUID: { itemCode: 'SOAP', quantity: '330' } }, 'C40'),
        items,
        crates,
        labels,
      ),
    ).toEqual(['Typ bedny: nic → Bedna 40']);
  });
});

describe('request ids', () => {
  it('reuses the id for the same request and starts a new one for changed data', () => {
    let n = 0;
    const next = () => `id-${++n}`;
    const first = attemptId(null, 'a', next);
    expect(attemptId(first, 'a', next)).toBe(first);
    expect(attemptId(first, 'b', next).id).toBe('id-2');
  });
});

describe('navigation for a catalogue-only user (issue #17)', () => {
  it('shows Výroba with just the catalogue — no operational page', () => {
    const modules = visibleModules(['catalog:read']);
    expect(modules.map((m) => m.id)).toEqual(['production']);
    expect(modules[0]!.href).toBe('/production/catalog');
    expect(modules[0]!.pages.map((p) => p.id)).toEqual(['catalog']);
  });
  it('production users keep their pages; the catalogue only with catalog:read', () => {
    const plain = visibleModules(['production:read']).find((m) => m.id === 'production')!;
    expect(plain.pages.map((p) => p.id)).toEqual([
      'overview',
      'bottles',
      'templates',
      'label-activation',
    ]);
    const both = visibleModules(['production:read', 'catalog:read']).find(
      (m) => m.id === 'production',
    )!;
    expect(both.pages.map((p) => p.id)).toContain('catalog');
  });
});
