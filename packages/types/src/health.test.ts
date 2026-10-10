import { describe, expect, it } from 'vitest';
import { healthResponseSchema } from './health.js';

describe('healthResponseSchema', () => {
  const valid = {
    status: 'ok',
    service: 'ayvo-api',
    environment: 'development',
    timestamp: new Date().toISOString(),
    checks: { database: 'up', redis: 'up' },
  };

  it('accepts a valid health response', () => {
    expect(healthResponseSchema.parse(valid)).toEqual(valid);
  });

  it('rejects unknown dependency states', () => {
    const result = healthResponseSchema.safeParse({
      ...valid,
      checks: { database: 'maybe', redis: 'up' },
    });
    expect(result.success).toBe(false);
  });
});
