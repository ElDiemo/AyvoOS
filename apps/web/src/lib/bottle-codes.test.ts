import { describe, expect, it } from 'vitest';
import { expectedBottleCodes } from './bottle-codes';

describe('expectedBottleCodes', () => {
  it('continues after the latest bottle', () => {
    expect(expectedBottleCodes('AYV-B-000003', 20)).toEqual({
      first: 'AYV-B-000004',
      last: 'AYV-B-000023',
    });
    expect(expectedBottleCodes('AYV-B-000007', 1)).toEqual({
      first: 'AYV-B-000008',
      last: 'AYV-B-000008',
    });
  });

  it('starts at AYV-B-000001 when no bottle exists yet', () => {
    expect(expectedBottleCodes(null, 50)).toEqual({ first: 'AYV-B-000001', last: 'AYV-B-000050' });
  });

  it('widens beyond six digits like the API', () => {
    expect(expectedBottleCodes('AYV-B-999999', 2)).toEqual({
      first: 'AYV-B-1000000',
      last: 'AYV-B-1000001',
    });
  });

  it('gives no preview for unexpected input', () => {
    expect(expectedBottleCodes('BC-000001', 5)).toBeNull();
    expect(expectedBottleCodes('AYV-B-000001', 0)).toBeNull();
    expect(expectedBottleCodes('AYV-B-000001', 2.5)).toBeNull();
  });
});
