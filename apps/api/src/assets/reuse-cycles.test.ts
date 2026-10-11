import { describe, expect, it } from 'vitest';
import { countCompletedReuseCycles } from './reuse-cycles.js';

describe('countCompletedReuseCycles (ADR 0011)', () => {
  it('is 0 for a newly created bottle', () => {
    expect(countCompletedReuseCycles(['CREATED'])).toBe(0);
  });

  it('counts a cycle only when a delivered bottle is individually identified (SORTED)', () => {
    expect(countCompletedReuseCycles(['CREATED', 'DELIVERED_TO_HOTEL'])).toBe(0);
    expect(countCompletedReuseCycles(['CREATED', 'DELIVERED_TO_HOTEL', 'RETURNED'])).toBe(0);
    expect(countCompletedReuseCycles(['CREATED', 'DELIVERED_TO_HOTEL', 'SORTED'])).toBe(1);
  });

  it('counts each delivery once, and ignores SORTED without a prior delivery', () => {
    expect(
      countCompletedReuseCycles([
        'CREATED',
        'SORTED',
        'DELIVERED_TO_HOTEL',
        'SORTED',
        'SORTED',
        'DELIVERED_TO_HOTEL',
        'SORTED',
      ]),
    ).toBe(2);
  });
});
