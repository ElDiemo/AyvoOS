import { describe, expect, it } from 'vitest';
import { countCompletedReuseCycles } from './reuse-cycles.js';

/**
 * A delivery writes no bottle event (doc 047 §4.0); that a SORTED exists only for a bottle of a
 * delivered cycle, once per cycle, is enforced by the database and tested in returns.e2e.test.ts.
 */
describe('countCompletedReuseCycles (ADR 0011)', () => {
  it('is 0 for a newly created, labelled, filled or shipped bottle', () => {
    expect(countCompletedReuseCycles(['CREATED'])).toBe(0);
    expect(
      countCompletedReuseCycles(['CREATED', 'LABEL_APPLIED', 'ASSIGNED_TO_CRATE', 'FILLED']),
    ).toBe(0);
  });

  it('counts each identification after a return (SORTED), good or defective', () => {
    expect(countCompletedReuseCycles(['CREATED', 'LABEL_APPLIED', 'FILLED', 'SORTED'])).toBe(1);
    expect(countCompletedReuseCycles(['CREATED', 'FILLED', 'SORTED', 'RETIRED'])).toBe(1);
    expect(countCompletedReuseCycles(['CREATED', 'FILLED', 'SORTED', 'FILLED', 'SORTED'])).toBe(2);
  });

  it('never counts a retirement, a correction or a disposal', () => {
    expect(
      countCompletedReuseCycles(['SORTED', 'RETIRED', 'CORRECTION', 'RETIRED', 'DISPOSED']),
    ).toBe(1);
  });
});
