import { describe, expect, it } from 'vitest';
import { codeRange, formatBytes, formatDateTime, formatMm } from './format';

describe('format', () => {
  it('shows timestamps in AYVO local time', () => {
    expect(formatDateTime('2026-10-10T17:00:00.000Z')).toBe('10 Oct 2026, 19:00');
    expect(formatDateTime(null)).toBe('—');
  });

  it('formats millimetres, sizes and code ranges', () => {
    expect(formatMm(48.2)).toBe('48.2 mm');
    expect(formatMm(15)).toBe('15 mm');
    expect(formatBytes(2_500_000)).toBe('2.4 MB');
    expect(codeRange('AYV-B-000001', 'AYV-B-000050')).toBe('AYV-B-000001 – AYV-B-000050');
    expect(codeRange('AYV-B-000007', 'AYV-B-000007')).toBe('AYV-B-000007');
  });
});
