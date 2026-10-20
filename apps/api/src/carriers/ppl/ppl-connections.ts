import type { Env } from '../../config/env.js';

/**
 * Server-side PPL connections (doc 029 §9, ADR 0027). The base URL is fixed in code per
 * environment — never editable by a user. This stage has the TEST environment only: no production
 * connection exists, so nothing can switch or fall back to production PPL. Credentials come from
 * the administration (encrypted, CarrierCredentialsService) or, failing that, from the server's
 * protected environment file.
 */
export const PPL_CONNECTIONS = {
  PPL_TEST: { environment: 'TEST' as const, baseUrl: 'https://api-dev.dhl.com/ecs/ppl/myapi2' },
};
export type PplConnectionCode = keyof typeof PPL_CONNECTIONS;

export const isPplConnection = (code: string | null): code is PplConnectionCode =>
  !!code && Object.hasOwn(PPL_CONNECTIONS, code);

/** The API base URL of a connection (a simulated server only in automated tests). */
export const pplBaseUrl = (env: Env, code: PplConnectionCode) =>
  env.PPL_TEST_API_BASE_URL_FOR_TESTS ?? PPL_CONNECTIONS[code].baseUrl;

/** Credentials from the server environment file, if any. */
export function serverCredentials(
  env: Env,
  code: PplConnectionCode,
): { clientId: string; clientSecret: string } | null {
  if (code !== 'PPL_TEST' || !env.PPL_TEST_CLIENT_ID || !env.PPL_TEST_CLIENT_SECRET) return null;
  return { clientId: env.PPL_TEST_CLIENT_ID, clientSecret: env.PPL_TEST_CLIENT_SECRET };
}
