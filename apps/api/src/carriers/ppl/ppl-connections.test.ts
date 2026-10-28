import { describe, expect, it } from 'vitest';
import type { Env } from '../../config/env.js';
import {
  availableConnections,
  isAvailableConnection,
  PPL_CONNECTIONS,
  pplBaseUrl,
  serverCredentials,
} from './ppl-connections.js';

/** PPL connections (doc 029 §9, ADR 0042): fixed URLs, production PPL only in production. */
describe('PPL connections', () => {
  it('fixes the documented URLs per environment (PPL CPL API, "Obecné")', () => {
    expect(PPL_CONNECTIONS).toEqual({
      PPL_TEST: { environment: 'TEST', baseUrl: 'https://api-dev.dhl.com/ecs/ppl/myapi2' },
      PPL_PRODUCTION: { environment: 'PRODUCTION', baseUrl: 'https://api.dhl.com/ecs/ppl/myapi2' },
    });
    expect(pplBaseUrl({} as Env, 'PPL_PRODUCTION')).toBe('https://api.dhl.com/ecs/ppl/myapi2');
  });

  it('production PPL exists only in production (and in tests against the simulation) — never on DEV', () => {
    expect(availableConnections({ APP_ENV: 'development' })).toEqual(['PPL_TEST']);
    expect(availableConnections({ APP_ENV: 'production' })).toEqual(['PPL_TEST', 'PPL_PRODUCTION']);
    expect(availableConnections({ APP_ENV: 'test' })).toEqual(['PPL_TEST', 'PPL_PRODUCTION']);
    expect(isAvailableConnection({ APP_ENV: 'development' }, 'PPL_PRODUCTION')).toBe(false);
    for (const code of [null, '', 'PPL_PROD', 'ppl_production', 'toString'])
      expect(isAvailableConnection({ APP_ENV: 'production' }, code), String(code)).toBe(false);
  });

  it('server env file credentials only for the test connection — production only from the administration', () => {
    const env = { PPL_TEST_CLIENT_ID: 'id', PPL_TEST_CLIENT_SECRET: 'secret' } as Env;
    expect(serverCredentials(env, 'PPL_TEST')).toEqual({ clientId: 'id', clientSecret: 'secret' });
    expect(serverCredentials(env, 'PPL_PRODUCTION')).toBeNull();
  });
});
