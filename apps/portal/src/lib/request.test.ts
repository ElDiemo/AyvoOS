import { beforeEach, describe, expect, it, vi } from 'vitest';

const base = {
  APP_ENV: 'test',
  PORTAL_PUBLIC_ORIGIN: 'http://localhost:3300',
  CORE_INTERNAL_URL: 'http://127.0.0.1:4301',
  FINANCE_INTERNAL_URL: 'http://127.0.0.1:4311',
  PORTAL_CORE_TOKEN: 'c'.repeat(43),
  PORTAL_FINANCE_TOKEN: 'f'.repeat(43),
};
const load = async (env: Record<string, string>) => {
  vi.resetModules();
  for (const [k, v] of Object.entries({ ...base, ...env })) vi.stubEnv(k, v);
  return import('./request');
};
const req = (headers: Record<string, string>) =>
  new Request('http://localhost:3300/auth/password', { method: 'POST', headers });

describe('portal-web request rules', () => {
  beforeEach(() => vi.unstubAllEnvs());

  it('a state-changing request must come from the portal itself', async () => {
    const { sameOrigin } = await load({});
    expect(
      sameOrigin(req({ origin: 'http://localhost:3300', 'sec-fetch-site': 'same-origin' })),
    ).toBe(true);
    expect(sameOrigin(req({ origin: 'http://localhost:3300' }))).toBe(true);
    expect(sameOrigin(req({}))).toBe(false);
    expect(sameOrigin(req({ origin: 'https://evil.example' }))).toBe(false);
    expect(
      sameOrigin(req({ origin: 'http://localhost:3300', 'sec-fetch-site': 'same-site' })),
    ).toBe(false);
    expect(
      sameOrigin(req({ origin: 'http://localhost:3300', 'sec-fetch-site': 'cross-site' })),
    ).toBe(false);
  });

  it('the client IP comes from the portal’s own proxy only when trusted', async () => {
    const spoof = req({ 'x-forwarded-for': '203.0.113.9, 198.51.100.7' });
    expect((await load({})).clientIp(spoof)).toBe('127.0.0.1');
    expect((await load({ PORTAL_TRUST_PROXY: '1' })).clientIp(spoof)).toBe('198.51.100.7');
    expect(
      (await load({ PORTAL_TRUST_PROXY: '1' })).clientIp(req({ 'x-forwarded-for': 'x<y' })),
    ).toBe('127.0.0.1');
  });

  it('refuses one token for both receivers, and http outside tests', async () => {
    const env = async (over: Record<string, string>) => {
      vi.resetModules();
      for (const [k, v] of Object.entries({ ...base, ...over })) vi.stubEnv(k, v);
      return (await import('./env')).portalEnv;
    };
    expect((await env({}))().PORTAL_PUBLIC_ORIGIN).toBe('http://localhost:3300');
    const same = await env({ PORTAL_FINANCE_TOKEN: 'c'.repeat(43) });
    expect(() => same()).toThrow(/tokens must differ/);
    const http = await env({ APP_ENV: 'production' });
    expect(() => http()).toThrow(/https/);
    const path = await env({ PORTAL_PUBLIC_ORIGIN: 'https://portal.example.test/x' });
    expect(() => path()).toThrow(/origin/);
  });
});
