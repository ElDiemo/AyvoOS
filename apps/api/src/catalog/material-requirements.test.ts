import type { RecipeComponent } from '@ayvo/types';
import { describe, expect, it } from 'vitest';
import { materialRequirements, RequirementTooLargeError } from './material-requirements.js';

const pcs = { code: 'pcs', name: 'kus', decimalPlaces: 0 };
const ml = { code: 'ml', name: 'mililitr', decimalPlaces: 3 };
const line = (
  stage: RecipeComponent['stage'],
  kind: RecipeComponent['kind'],
  itemCode: string,
  q: string,
  unit = pcs,
): RecipeComponent => ({ stage, kind, itemCode, itemName: itemCode, quantity: q, unit });

/** The owner's example (2026-10-13): one hand-soap bottle = bottle, 330 ml liquid, pump, label. */
const soap = [
  line('LABEL_APPLICATION', 'NEW_BOTTLE', 'GLASS-330', '1'),
  line('LABEL_APPLICATION', 'LABEL_MEDIA', 'LABEL-SOAP', '1'),
  line('FILL', 'BULK_LIQUID', 'LIQUID-SOAP', '330', ml),
  line('FILL', 'PUMP', 'PUMP', '1'),
];
const crate40 = { code: 'CRATE-40', name: 'Vratná bedna', capacity: 40 };
const run = (bottles: number, components = soap, crateType = crate40) =>
  materialRequirements({ components, crateType, bottles });
const totals = (r: ReturnType<typeof run>) =>
  Object.fromEntries(r.components.map((c) => [c.itemCode, c.totalQuantity]));

describe('material requirements (doc 023 §5)', () => {
  it('40 bottles: 40 bottles, 13 200 ml liquid, 40 pumps, 40 labels and exactly one full crate', () => {
    const r = run(40);
    expect(totals(r)).toEqual({
      'GLASS-330': '40',
      'LABEL-SOAP': '40',
      'LIQUID-SOAP': '13200',
      PUMP: '40',
    });
    expect(r.crates).toEqual({ crateType: crate40, count: 1, full: 1, partialCrateBottles: 0 });
    // Units and per-bottle quantities are carried through unchanged.
    expect(r.components.find((c) => c.itemCode === 'LIQUID-SOAP')).toMatchObject({
      quantity: '330',
      unit: ml,
      stage: 'FILL',
    });
  });

  it('1 bottle still needs one (partial) crate', () => {
    const r = run(1);
    expect(totals(r)).toEqual({
      'GLASS-330': '1',
      'LABEL-SOAP': '1',
      'LIQUID-SOAP': '330',
      PUMP: '1',
    });
    expect(r.crates).toMatchObject({ count: 1, full: 0, partialCrateBottles: 1 });
  });

  it('41 bottles: crates are rounded UP — one full crate and one with 1 bottle', () => {
    const r = run(41);
    expect(totals(r)['LIQUID-SOAP']).toBe('13530');
    expect(r.crates).toMatchObject({ count: 2, full: 1, partialCrateBottles: 1 });
  });

  it('never rounds crates down: 79 → 2, 80 → 2, 81 → 3', () => {
    expect(run(79).crates).toMatchObject({ count: 2, full: 1, partialCrateBottles: 39 });
    expect(run(80).crates).toMatchObject({ count: 2, full: 2, partialCrateBottles: 0 });
    expect(run(81).crates).toMatchObject({ count: 3, full: 2, partialCrateBottles: 1 });
  });

  it('large quantities stay exact (decimal arithmetic, no float error)', () => {
    const r = run(1_000_000);
    expect(totals(r)).toEqual({
      'GLASS-330': '1000000',
      'LABEL-SOAP': '1000000',
      'LIQUID-SOAP': '330000000',
      PUMP: '1000000',
    });
    expect(r.crates).toMatchObject({ count: 25_000, full: 25_000, partialCrateBottles: 0 });
    expect(run(999_999).crates).toMatchObject({
      count: 25_000,
      full: 24_999,
      partialCrateBottles: 39,
    });
    // A fractional per-bottle quantity is multiplied exactly: 0.1 × 3 = 0.3, not 0.30000000000000004.
    const fractional = [line('FILL', 'BULK_LIQUID', 'LIQUID-SOAP', '0.1', ml)];
    expect(run(3, fractional).components[0]!.totalQuantity).toBe('0.3');
    expect(
      run(999_999, [line('FILL', 'BULK_LIQUID', 'X', '330.333', ml)]).components[0]!.totalQuantity,
    ).toBe('330332669.667');
  });

  it('uses the crate type’s capacity — never a constant 40', () => {
    const crate24 = { code: 'CRATE-24', name: 'Menší bedna', capacity: 24 };
    expect(run(50, soap, crate24).crates).toEqual({
      crateType: crate24,
      count: 3,
      full: 2,
      partialCrateBottles: 2,
    });
  });

  it('refuses a quantity that is not a positive whole number of bottles', () => {
    for (const bad of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY])
      expect(() => run(bad), String(bad)).toThrow(RangeError);
    expect(() => run(1, soap, { ...crate40, capacity: 0 })).toThrow(RangeError);
  });

  it('refuses a total that an exact quantity cannot hold instead of rounding it', () => {
    const huge = [line('FILL', 'BULK_LIQUID', 'X', '9999999999999.999', ml)];
    expect(() => run(1_000_000, huge)).toThrow(RequirementTooLargeError);
    expect(run(1, huge).components[0]!.totalQuantity).toBe('9999999999999.999');
  });
});
