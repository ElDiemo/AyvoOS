import { describe, expect, it } from 'vitest';
import { formatDimensions, formatMass, gToKg, kgToG, parseDecimal } from './measure';

describe('weights and dimensions in the UI (W1)', () => {
  it('parses Czech and dot decimals exactly, refusing zero and junk', () => {
    expect(parseDecimal('372,5', 3)).toBe('372.5');
    expect(parseDecimal(' 0.512 ', 3)).toBe('0.512');
    expect(parseDecimal('007.10', 3)).toBe('7.1');
    for (const bad of ['0', '0,000', '-1', '1.2345', '1e3', 'abc', '']) {
      expect(parseDecimal(bad, 3), bad).toBeNull();
    }
  });

  it('converts kg ↔ g without floating point', () => {
    expect(kgToG('1,85')).toBe('1850');
    expect(kgToG('0.0125')).toBe('12.5');
    expect(kgToG('20.450')).toBe('20450');
    expect(kgToG('0.1234567')).toBeNull(); // more precise than 1 mg
    expect(gToKg('1850')).toBe('1.85');
    expect(gToKg('450.25')).toBe('0.45025');
    expect(gToKg('2595')).toBe('2.595');
    expect(gToKg('0.512')).toBe('0.000512');
    // 0.1 + 0.2 style float errors never appear
    expect(kgToG('0.3')).toBe('300');
  });

  it('shows masses in g below 1 kg and in kg above; unknown stays unknown', () => {
    expect(formatMass('372.5')).toBe('372,5 g');
    expect(formatMass('2595')).toBe('2,595 kg');
    expect(formatMass('3045.25')).toBe('3,04525 kg');
    expect(formatMass(null)).toBeNull();
    expect(formatDimensions(600, 400, 305)).toBe('600 × 400 × 305 mm (60 × 40 × 30,5 cm)');
  });
});
