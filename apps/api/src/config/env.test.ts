import { describe, expect, it } from 'vitest';
import { loadEnv } from './env.js';

const valid = {
  DATABASE_URL: 'postgresql://user:pass@localhost:5432/ayvo_test',
  REDIS_URL: 'redis://localhost:6379',
};

describe('loadEnv', () => {
  it('applies defaults', () => {
    expect(loadEnv(valid)).toMatchObject({ APP_ENV: 'development', API_PORT: 4000 });
  });

  it('fails fast on missing DATABASE_URL', () => {
    expect(() => loadEnv({ REDIS_URL: valid.REDIS_URL })).toThrow(/DATABASE_URL/);
  });

  it('rejects APP_ENV values other than development, test, production (no staging yet)', () => {
    expect(() => loadEnv({ ...valid, APP_ENV: 'staging' })).toThrow(/APP_ENV/);
  });
});
