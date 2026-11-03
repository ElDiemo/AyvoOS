import { domesticVatRatePageSchema } from '@ayvo/types';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));
vi.mock('next/headers', () => ({
  cookies: async () => ({ get: () => undefined }),
  headers: async () => new Headers(),
}));
// A panel never redirects or renders not-found: these must stay unused.
const notFound = vi.fn();
const redirect = vi.fn();
vi.mock('next/navigation', () => ({ notFound, redirect }));
vi.mock('./env', () => ({
  serverEnv: { API_URL: 'http://core.test', FINANCE_API_URL: 'http://finance.test' },
}));
const { apiGetPanel } = await import('./api');

const answer = (status: number, body: unknown) =>
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response(JSON.stringify(body), { status })),
  );
const vatRates = () => apiGetPanel('admin/finance/issuer/vat-rates', domesticVatRatePageSchema);

describe('the VAT-rate panel against Finance releases (new web, older or failing Finance)', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    expect(notFound).not.toHaveBeenCalled();
    expect(redirect).not.toHaveBeenCalled();
  });

  it('an older Finance without the endpoint (404): unavailable, not the not-found page', async () => {
    answer(404, { statusCode: 404, message: 'Cannot GET /api/admin/finance/issuer/vat-rates' });
    expect(await vatRates()).toEqual({ state: 'unavailable' });
  });
  it('the endpoint failing (500) or not answering: unavailable', async () => {
    answer(500, { statusCode: 500 });
    expect(await vatRates()).toEqual({ state: 'unavailable' });
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new TypeError('fetch failed');
      }),
    );
    expect(await vatRates()).toEqual({ state: 'unavailable' });
  });
  it('an answer outside the contract: unavailable, never a guessed rate', async () => {
    answer(200, { rates: [] });
    expect(await vatRates()).toEqual({ state: 'unavailable' });
  });
  it('an ordinary answer with nothing entered: ok and empty', async () => {
    const empty = { today: '2026-11-03', current: null, effective: [], versions: [] };
    answer(200, empty);
    expect(await vatRates()).toEqual({ state: 'ok', data: empty });
  });
  it('a refusal: forbidden, no redirect', async () => {
    answer(403, { code: 'FORBIDDEN' });
    expect(await vatRates()).toEqual({ state: 'forbidden' });
  });
});
