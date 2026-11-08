import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

const env = {
  APP_ENV: 'test',
  PORTAL_PUBLIC_ORIGIN: 'http://localhost:3300',
  CORE_INTERNAL_URL: 'http://127.0.0.1:4301',
  FINANCE_INTERNAL_URL: 'http://127.0.0.1:4311',
  PORTAL_CORE_TOKEN: 'c'.repeat(43),
  PORTAL_FINANCE_TOKEN: 'f'.repeat(43),
};
for (const [k, v] of Object.entries(env)) vi.stubEnv(k, v);
const { contractJson, PortalRefusal, PortalUnauthenticated, PortalUnavailable } =
  await import('./backend');

const answer = (status: number, body: unknown) =>
  vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
    new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    }),
  );
const call = () => contractJson('core', 'auth/password', z.object({ step: z.literal('MFA') }));

describe('portal-web contract answers', () => {
  afterEach(() => vi.restoreAllMocks());

  it('sends its own token per receiver and forwards the session', async () => {
    const spy = answer(200, []);
    await contractJson('finance', 'invoices', z.array(z.unknown()), { session: 's1' });
    const [url, init] = spy.mock.calls[0]!;
    expect(url).toBe('http://127.0.0.1:4311/api/internal/v1/portal/invoices');
    expect(init?.headers).toMatchObject({
      authorization: `Bearer ${'f'.repeat(43)}`,
      'x-ayvo-portal-session': 's1',
    });
  });

  it('a refused sign-in step is its own answer; a gone session is "sign in again"', async () => {
    answer(401, { code: 'INVALID_LOGIN' });
    await expect(call()).rejects.toMatchObject({ code: 'INVALID_LOGIN' });
    answer(401, { code: 'INVALID_MFA' });
    await expect(call()).rejects.toBeInstanceOf(PortalRefusal);
    for (const code of ['UNAUTHENTICATED', 'SESSION_EXPIRED', 'ACCOUNT_INACTIVE']) {
      answer(401, { code });
      await expect(call()).rejects.toBeInstanceOf(PortalUnauthenticated);
    }
  });

  it('fails closed: our token refused, a 5xx, a malformed body or no answer is "unavailable"', async () => {
    answer(401, { code: 'SERVICE_UNAUTHENTICATED' });
    await expect(call()).rejects.toBeInstanceOf(PortalUnavailable);
    answer(503, { code: 'PORTAL_BUSY' });
    await expect(call()).rejects.toBeInstanceOf(PortalUnavailable);
    answer(200, { step: 'SOMETHING_ELSE' });
    await expect(call()).rejects.toBeInstanceOf(PortalUnavailable);
    vi.spyOn(globalThis, 'fetch').mockRejectedValueOnce(new TypeError('fetch failed'));
    await expect(call()).rejects.toBeInstanceOf(PortalUnavailable);
  });
});
