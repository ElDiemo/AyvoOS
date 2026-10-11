import { describe, expect, it } from 'vitest';
import { formatDateCs, formatDeltaCs, formatQuantityCs, unitCs } from './format';

describe('Czech warehouse formatting', () => {
  it('formats exact decimal strings without floating point', () => {
    expect(formatQuantityCs('9987')).toBe('9 987');
    expect(formatQuantityCs('10000000000000001')).toBe('10 000 000 000 000 001');
    expect(formatQuantityCs('13200.5')).toBe('13 200,5');
    expect(formatQuantityCs('0')).toBe('0');
    expect(formatQuantityCs('-2')).toBe('−2');
    expect(formatDeltaCs('5')).toBe('+5');
    expect(formatDeltaCs('-1')).toBe('−1');
  });

  it('formats calendar dates without shifting the day', () => {
    expect(formatDateCs('2026-10-11')).toBe('11. 10. 2026');
  });

  it('shows Czech unit names and keeps unknown codes', () => {
    expect(unitCs('pcs')).toBe('ks');
    expect(unitCs('ml')).toBe('ml');
    expect(unitCs('kg')).toBe('kg');
  });
});
