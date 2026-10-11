import { describe, expect, it } from 'vitest';
import { quantity } from '../common/quantity.js';
import { suggestion } from './warehouse-read.service.js';

describe('replenishment suggestion (advisory only)', () => {
  const s = (reorder: number | null, target: number | null, multiple: number | null) => ({
    reorderPoint: reorder === null ? null : quantity(reorder),
    targetLevel: target === null ? null : quantity(target),
    purchaseMultiple: multiple === null ? null : quantity(multiple),
  });

  it('suggests target − available, rounded up to the purchase multiple, only below the reorder point', () => {
    expect(suggestion(quantity(400), s(500, 2000, 1000))).toBe('2000');
    expect(suggestion(quantity(400), s(500, 2000, null))).toBe('1600');
    expect(suggestion(quantity(500), s(500, 2000, 1000))).toBeNull(); // not below the reorder point
    expect(suggestion(quantity(0), s(null, 2000, 1000))).toBeNull(); // no reorder point
    expect(suggestion(quantity(0), s(10, null, null))).toBeNull(); // no target
  });

  it('works on exact decimals (ml)', () => {
    expect(suggestion(quantity('100.5'), s(200, 1000, 0.5))).toBe('899.5');
  });
});
