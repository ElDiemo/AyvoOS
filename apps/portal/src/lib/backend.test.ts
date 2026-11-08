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
const {
  CONTRACT_JSON_MAX_BYTES,
  contractCallsInFlight,
  contractJson,
  PortalRefusal,
  PortalUnauthenticated,
  PortalUnavailable,
} = await import('./backend');

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

  it('ADR §8 "keep-alive 8 / 4": at most 8 core and 4 Finance calls in flight; the next is refused at once, never queued', async () => {
    const held: ((r: Response) => void)[] = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation(
      () => new Promise<Response>((resolve) => held.push(resolve)),
    );
    const schema = z.unknown();
    const core = Array.from({ length: 8 }, () => contractJson('core', 'hotels', schema));
    const fin = Array.from({ length: 4 }, () => contractJson('finance', 'invoices', schema));
    await new Promise((r) => setTimeout(r, 0));
    expect(contractCallsInFlight()).toEqual({ core: 8, finance: 4 });
    const started = Date.now();
    await expect(contractJson('core', 'hotels', schema)).rejects.toBeInstanceOf(PortalUnavailable);
    await expect(contractJson('finance', 'invoices', schema)).rejects.toBeInstanceOf(
      PortalUnavailable,
    );
    expect(Date.now() - started).toBeLessThan(50);
    expect(held).toHaveLength(12);
    for (const resolve of held) resolve(new Response('[]', { status: 200 }));
    await Promise.all([...core, ...fin]);
    expect(contractCallsInFlight()).toEqual({ core: 0, finance: 0 });
  });

  it('the slot is held while the answer is still being read, and given back after a failure', async () => {
    let push: ((c: Uint8Array | null) => void) | undefined;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        push = (c) => (c ? controller.enqueue(c) : controller.close());
      },
    });
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(new Response(body, { status: 200 }));
    const pending = contractJson('core', 'hotels', z.array(z.number()));
    await new Promise((r) => setTimeout(r, 0));
    expect(contractCallsInFlight().core).toBe(1);
    push!(new TextEncoder().encode('[1,'));
    await new Promise((r) => setTimeout(r, 0));
    expect(contractCallsInFlight().core).toBe(1);
    push!(new TextEncoder().encode('2]'));
    push!(null);
    await expect(pending).resolves.toEqual([1, 2]);
    expect(contractCallsInFlight().core).toBe(0);
    vi.spyOn(globalThis, 'fetch').mockRejectedValueOnce(new TypeError('fetch failed'));
    await expect(call()).rejects.toBeInstanceOf(PortalUnavailable);
    expect(contractCallsInFlight().core).toBe(0);
  });

  it('an answer beyond 1 MiB is refused — announced, or only counted while reading', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response('[]', {
        status: 200,
        headers: { 'content-length': String(CONTRACT_JSON_MAX_BYTES + 1) },
      }),
    );
    await expect(contractJson('finance', 'invoices', z.unknown())).rejects.toBeInstanceOf(
      PortalUnavailable,
    );
    let served = 0;
    const endless = new ReadableStream<Uint8Array>({
      pull(controller) {
        served++;
        controller.enqueue(new Uint8Array(64 * 1024).fill(0x20));
      },
    });
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(new Response(endless, { status: 200 }));
    await expect(contractJson('finance', 'invoices', z.unknown())).rejects.toBeInstanceOf(
      PortalUnavailable,
    );
    expect(served).toBeLessThanOrEqual(CONTRACT_JSON_MAX_BYTES / (64 * 1024) + 2);
    expect(contractCallsInFlight()).toEqual({ core: 0, finance: 0 });
  });
});
