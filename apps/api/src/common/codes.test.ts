import { describe, expect, it } from 'vitest';
import { CODE_PREFIX, formatCode, parseCodeSerial } from './codes.js';

describe('formatCode', () => {
  it.each([
    [1n, 'AYV-B-000001'],
    [50n, 'AYV-B-000050'],
    [999_999n, 'AYV-B-999999'],
    [1_000_000n, 'AYV-B-1000000'],
    [123_456_789n, 'AYV-B-123456789'],
  ])('serial %s -> %s (millions of bottles keep unique codes)', (serial, code) => {
    expect(formatCode(CODE_PREFIX.bottle, serial)).toBe(code);
  });

  it('rejects non-positive serials', () => {
    expect(() => formatCode(CODE_PREFIX.bottle, 0n)).toThrow(RangeError);
  });
});

describe('parseCodeSerial', () => {
  it.each(['AYV-B-000123', 'ayv-b-000123', '000123', '123', ' 123 '])('%s -> 123', (input) => {
    expect(parseCodeSerial(CODE_PREFIX.bottle, input)).toBe(123n);
  });

  it.each(['', 'abc', 'BC-000123', '0', '-1', '12.5', 'AYV-B-'])('%s -> null', (input) => {
    expect(parseCodeSerial(CODE_PREFIX.bottle, input)).toBeNull();
  });
});
