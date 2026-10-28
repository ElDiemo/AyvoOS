import type { Env } from '../../config/env.js';

/**
 * Server-side PPL connections (doc 029 §9, ADR 0027, ADR 0042). The base URL is fixed in code per
 * environment — never editable by a user (PPL CPL API, "Obecné": production
 * https://api.dhl.com/ecs/ppl/myapi2, test https://api-dev.dhl.com/ecs/ppl/myapi2). Each connection
 * has its own credentials (its own row, encrypted with the code as associated data); nothing ever
 * switches or falls back from one connection to another. A site chooses one explicitly; an existing
 * request always keeps the connection, environment and account it was made with.
 */
export const PPL_CONNECTIONS = {
  PPL_TEST: { environment: 'TEST' as const, baseUrl: 'https://api-dev.dhl.com/ecs/ppl/myapi2' },
  PPL_PRODUCTION: {
    environment: 'PRODUCTION' as const,
    baseUrl: 'https://api.dhl.com/ecs/ppl/myapi2',
  },
};
export type PplConnectionCode = keyof typeof PPL_CONNECTIONS;

export const isPplConnection = (code: string | null): code is PplConnectionCode =>
  !!code && Object.hasOwn(PPL_CONNECTIONS, code);

/**
 * Whether a connection exists in this application: production PPL only with APP_ENV=production
 * (and in automated tests, against the simulated server) — never on DEV, so DEV can neither store
 * production credentials nor choose or call production PPL. The test connection exists everywhere.
 */
export const isAvailableConnection = (
  env: Pick<Env, 'APP_ENV'>,
  code: string | null,
): code is PplConnectionCode =>
  isPplConnection(code) &&
  (PPL_CONNECTIONS[code].environment === 'TEST' ||
    env.APP_ENV === 'production' ||
    env.APP_ENV === 'test');

/** The connections of this application, in a fixed order (test first). */
export const availableConnections = (env: Pick<Env, 'APP_ENV'>): PplConnectionCode[] =>
  (Object.keys(PPL_CONNECTIONS) as PplConnectionCode[]).filter((c) =>
    isAvailableConnection(env, c),
  );

/** The API base URL of a connection (a simulated server only in automated tests). */
export const pplBaseUrl = (env: Env, code: PplConnectionCode) =>
  env.PPL_TEST_API_BASE_URL_FOR_TESTS ?? PPL_CONNECTIONS[code].baseUrl;

/**
 * Credentials from the server environment file, if any — the TEST connection only. Production
 * credentials are entered by the owner in the administration (stored encrypted), never in a file.
 */
export function serverCredentials(
  env: Env,
  code: PplConnectionCode,
): { clientId: string; clientSecret: string } | null {
  if (code !== 'PPL_TEST' || !env.PPL_TEST_CLIENT_ID || !env.PPL_TEST_CLIENT_SECRET) return null;
  return { clientId: env.PPL_TEST_CLIENT_ID, clientSecret: env.PPL_TEST_CLIENT_SECRET };
}
