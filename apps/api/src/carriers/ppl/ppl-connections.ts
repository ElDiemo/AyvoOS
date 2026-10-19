import type { CarrierConnection } from '@ayvo/types';
import type { Env } from '../../config/env.js';
import type { PplConnection } from './ppl-client.js';

/**
 * Server-side PPL connections (doc 029 §9). The base URL is fixed in code per environment — never
 * editable by a user; credentials come only from the server's protected environment. This stage
 * has the TEST environment only: no production connection exists, so nothing can switch or fall
 * back to production PPL.
 */
export const PPL_CONNECTIONS = {
  PPL_TEST: { environment: 'TEST' as const, baseUrl: 'https://api-dev.dhl.com/ecs/ppl/myapi2' },
};
export type PplConnectionCode = keyof typeof PPL_CONNECTIONS;

export const isPplConnection = (code: string | null): code is PplConnectionCode =>
  !!code && Object.hasOwn(PPL_CONNECTIONS, code);

/** The usable connection (with its credentials), or null when the server lacks them. */
export function pplConnection(env: Env, code: PplConnectionCode): PplConnection | null {
  const def = PPL_CONNECTIONS[code];
  if (!env.PPL_TEST_CLIENT_ID || !env.PPL_TEST_CLIENT_SECRET) return null;
  return {
    code,
    environment: def.environment,
    // Automated tests only (refused by the environment schema unless APP_ENV=test).
    baseUrl: env.PPL_TEST_API_BASE_URL_FOR_TESTS ?? def.baseUrl,
    clientId: env.PPL_TEST_CLIENT_ID,
    clientSecret: env.PPL_TEST_CLIENT_SECRET,
  };
}

/** What a settings page may know about the connections: code, environment, set / missing. */
export function pplConnectionList(env: Env): CarrierConnection[] {
  return (Object.keys(PPL_CONNECTIONS) as PplConnectionCode[]).map((code) => ({
    code,
    environment: PPL_CONNECTIONS[code].environment,
    credentials: pplConnection(env, code) ? 'SET' : 'MISSING',
  }));
}
