import { afterEach, describe, expect, it, vi } from 'vitest';

const base = {
  APP_ENV: 'production',
  PORTAL_PUBLIC_ORIGIN: 'https://portal.example.test',
  CORE_INTERNAL_URL: 'http://api:4000',
  FINANCE_INTERNAL_URL: 'http://finance:4010',
  PORTAL_CORE_TOKEN: 'p'.repeat(43),
  PORTAL_FINANCE_TOKEN: 'q'.repeat(43),
};

/** portalEnv() caches its first parse: a fresh module per case. */
async function parse(extra: Record<string, string>) {
  vi.unstubAllEnvs();
  for (const [k, v] of Object.entries({ ...base, ...extra })) vi.stubEnv(k, v);
  vi.resetModules();
  const { portalEnv } = await import('./env');
  return portalEnv();
}

/**
 * The invoice package's deadline in portal-web (doc 064 §2, option A1): by default Finance's
 * ceiling plus the grace (65 s); behind the PROD public edge, whose write limit is 30 s, it is set
 * lower (25 s) so the transfer always ends before the edge cuts it. Never longer than the default.
 */
describe('PORTAL_PACKAGE_DEADLINE_MS', () => {
  afterEach(() => vi.unstubAllEnvs());

  it('defaults to the shared ceiling plus the grace', async () => {
    expect((await parse({})).PORTAL_PACKAGE_DEADLINE_MS).toBe(65_000);
  });

  it('takes the lower PROD value', async () => {
    expect((await parse({ PORTAL_PACKAGE_DEADLINE_MS: '25000' })).PORTAL_PACKAGE_DEADLINE_MS).toBe(
      25_000,
    );
  });

  it('refuses more than the default and less than a second', async () => {
    await expect(parse({ PORTAL_PACKAGE_DEADLINE_MS: '65001' })).rejects.toThrow();
    await expect(parse({ PORTAL_PACKAGE_DEADLINE_MS: '999' })).rejects.toThrow();
  });
});
