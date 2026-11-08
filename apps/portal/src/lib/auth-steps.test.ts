import { afterEach, describe, expect, it, vi } from 'vitest';

const env = {
  APP_ENV: 'test',
  PORTAL_PUBLIC_ORIGIN: 'http://localhost:3300',
  CORE_INTERNAL_URL: 'http://127.0.0.1:4301',
  FINANCE_INTERNAL_URL: 'http://127.0.0.1:4311',
  PORTAL_CORE_TOKEN: 'c'.repeat(43),
  PORTAL_FINANCE_TOKEN: 'f'.repeat(43),
};
for (const [k, v] of Object.entries(env)) vi.stubEnv(k, v);

/** The browser's cookie jar as portal-web's route sees it (next/headers). */
const jar = new Map<string, string>();
vi.mock('next/headers', () => ({
  cookies: async () => ({
    get: (name: string) => (jar.has(name) ? { name, value: jar.get(name)! } : undefined),
    set: (name: string, value: string, opts: { maxAge?: number }) => {
      if (opts.maxAge === 0) jar.delete(name);
      else jar.set(name, value);
    },
  }),
}));

const { logout, mfa, password } = await import('./auth-steps');
const { AUTH_INPUT_DEADLINE_MS, AUTH_STEPS_IN_FLIGHT, authStepsInFlight } =
  await import('./auth-input');

const ORIGIN = { origin: 'http://localhost:3300', 'sec-fetch-site': 'same-origin' };
/** A request body that sends `chunks` pieces of `size` bytes, `delayMs` apart (no Content-Length). */
function streamed(chunks: number, size: number, delayMs = 0) {
  let sent = 0;
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (delayMs) await new Promise((r) => setTimeout(r, delayMs));
      if (sent++ >= chunks) return controller.close();
      controller.enqueue(new Uint8Array(size).fill(0x20));
    },
  });
}
const post = (body: BodyInit | null, headers: Record<string, string> = {}) =>
  new Request('http://localhost:3300/auth/password', {
    method: 'POST',
    headers: { ...ORIGIN, 'content-type': 'application/json', ...headers },
    body,
    // @ts-expect-error -- Node's fetch needs this for a streamed body
    duplex: 'half',
  });

describe('public sign-in steps: input limits before the core (review 5818694161)', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    jar.clear();
  });

  it('a body over 4 KiB without Content-Length is refused while reading; the core is never called', async () => {
    const core = vi.spyOn(globalThis, 'fetch');
    const res = await password(post(streamed(1000, 1024)));
    expect([res.status, (await res.json()).code]).toEqual([413, 'REQUEST_TOO_LARGE']);
    expect(core).not.toHaveBeenCalled();
    expect(authStepsInFlight()).toBe(0);
  });

  it('an announced Content-Length over the limit is refused before reading', async () => {
    const core = vi.spyOn(globalThis, 'fetch');
    const res = await password(post('{}', { 'content-length': '999999' }));
    expect(res.status).toBe(413);
    expect(core).not.toHaveBeenCalled();
  });

  it(
    'a body that trickles is cut at 5 s and its slot given back; meanwhile the other public steps are refused at once',
    async () => {
      const core = vi.spyOn(globalThis, 'fetch');
      const started = Date.now();
      const slow = Array.from({ length: AUTH_STEPS_IN_FLIGHT }, () =>
        password(post(streamed(10_000, 1, 200))),
      );
      await new Promise((r) => setTimeout(r, 50));
      expect(authStepsInFlight()).toBe(AUTH_STEPS_IN_FLIGHT);
      const extra = await password(post(JSON.stringify({ email: 'a@b.test', password: 'x' })));
      expect([extra.status, (await extra.json()).code]).toEqual([503, 'PORTAL_UNAVAILABLE']);
      const answers = await Promise.all(slow);
      expect(answers.map((r) => r.status)).toEqual(Array(AUTH_STEPS_IN_FLIGHT).fill(408));
      const took = Date.now() - started;
      expect(took).toBeGreaterThanOrEqual(AUTH_INPUT_DEADLINE_MS - 100);
      expect(took).toBeLessThan(AUTH_INPUT_DEADLINE_MS + 1_500);
      expect(authStepsInFlight()).toBe(0);
      expect(core).not.toHaveBeenCalled();
    },
    AUTH_INPUT_DEADLINE_MS + 5_000,
  );

  it('a cross-site request takes no slot and reads nothing', async () => {
    const res = await password(
      new Request('http://localhost:3300/auth/password', {
        method: 'POST',
        headers: { origin: 'https://evil.example' },
        body: '{}',
      }),
    );
    expect(res.status).toBe(403);
    expect(authStepsInFlight()).toBe(0);
  });

  it('a body within the limits reaches the core with the forwarded browser request', async () => {
    const core = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(
        Response.json({ step: 'MFA', challenge: 'p'.repeat(43), maxAgeSeconds: 300 }),
      );
    const res = await password(post(JSON.stringify({ email: 'a@b.test', password: 'heslo' })));
    expect(res.status).toBe(200);
    expect(JSON.parse(String(core.mock.calls[0]![1]!.body))).toMatchObject({
      email: 'a@b.test',
      client: { origin: 'http://localhost:3300' },
    });
    expect(jar.get('__Host-ayvo_portal_pre')).toBe('p'.repeat(43));
    expect(authStepsInFlight()).toBe(0);
  });
});

describe('signing out tells the truth (review 5818694161)', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    jar.clear();
  });
  const out = () =>
    logout(new Request('http://localhost:3300/auth/logout', { method: 'POST', headers: ORIGIN }));

  it('confirmed by the core: 204, no cookie left', async () => {
    jar.set('__Host-ayvo_portal', 's1');
    const core = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(null, { status: 204 }));
    expect((await out()).status).toBe(204);
    expect(core.mock.calls[0]![1]!.headers).toMatchObject({ 'x-ayvo-portal-session': 's1' });
    expect([...jar.keys()]).toEqual([]);
  });

  it('core 503: local access ends at once, the answer says LOGOUT_INCOMPLETE, and the retry finishes it', async () => {
    jar.set('__Host-ayvo_portal', 's1');
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      Response.json({ code: 'PORTAL_BUSY' }, { status: 503 }),
    );
    const res = await out();
    expect([res.status, (await res.json()).code]).toEqual([503, 'LOGOUT_INCOMPLETE']);
    expect(jar.has('__Host-ayvo_portal')).toBe(false);
    expect(jar.get('__Host-ayvo_portal_out')).toBe('s1');
    // The retry sends the same session again; the core confirms.
    const core = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(null, { status: 204 }));
    expect((await out()).status).toBe(204);
    expect(core.mock.calls[0]![1]!.headers).toMatchObject({ 'x-ayvo-portal-session': 's1' });
    expect([...jar.keys()]).toEqual([]);
  });

  it('the answer lost after the core committed: incomplete first, then the idempotent retry is confirmed', async () => {
    jar.set('__Host-ayvo_portal', 's1');
    // The core ended the session, but the connection broke before its answer arrived.
    vi.spyOn(globalThis, 'fetch').mockRejectedValueOnce(new TypeError('socket hang up'));
    expect((await out()).status).toBe(503);
    expect(jar.get('__Host-ayvo_portal_out')).toBe('s1');
    // The core no longer knows the session: logout answers 204 (idempotent) …
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(new Response(null, { status: 204 }));
    expect((await out()).status).toBe(204);
    expect([...jar.keys()]).toEqual([]);
  });

  it('… and a core that says the session is gone counts as signed out too', async () => {
    jar.set('__Host-ayvo_portal_out', 's1');
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      Response.json({ code: 'UNAUTHENTICATED' }, { status: 401 }),
    );
    expect((await out()).status).toBe(204);
    expect([...jar.keys()]).toEqual([]);
  });

  /** The sessions each core call was made for, in order. */
  const sessionsSent = (core: { mock: { calls: unknown[][] } }) =>
    core.mock.calls.map(
      (c) => (c[1] as { headers: Record<string, string> }).headers['x-ayvo-portal-session'],
    );
  const signIn = () =>
    mfa(
      new Request('http://localhost:3300/auth/mfa', {
        method: 'POST',
        headers: { ...ORIGIN, 'content-type': 'application/json' },
        body: JSON.stringify({ code: '123456' }),
      }),
    );

  it('outage → new sign-in → sign-out: the core is asked to end both sessions; 204 only when both are ended (review 5818871541)', async () => {
    jar.set('__Host-ayvo_portal', 'old');
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      Response.json({ code: 'PORTAL_BUSY' }, { status: 503 }),
    );
    expect((await out()).status).toBe(503);
    expect(jar.get('__Host-ayvo_portal_out')).toBe('old');

    // A new sign-in in the same browser.
    jar.set('__Host-ayvo_portal_pre', 'p'.repeat(43));
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      Response.json({ step: 'DONE', session: 'new', maxAgeSeconds: 3600 }),
    );
    expect((await signIn()).status).toBe(200);
    expect(jar.get('__Host-ayvo_portal')).toBe('new');
    expect(jar.get('__Host-ayvo_portal_out')).toBe('old');

    // Signing out of the new session: the old one is still down at the core.
    vi.restoreAllMocks();
    let core = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(null, { status: 204 }))
      .mockResolvedValueOnce(Response.json({ code: 'PORTAL_BUSY' }, { status: 503 }));
    const res = await out();
    expect([res.status, (await res.json()).code]).toEqual([503, 'LOGOUT_INCOMPLETE']);
    expect(sessionsSent(core)).toEqual(['new', 'old']);
    expect(jar.has('__Host-ayvo_portal')).toBe(false);
    expect(jar.get('__Host-ayvo_portal_out')).toBe('old');
    vi.restoreAllMocks();

    // Both confirmed: the same action with the core healthy answers 204 and keeps nothing.
    jar.set('__Host-ayvo_portal', 'new2');
    core = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(null, { status: 204 }))
      .mockResolvedValueOnce(new Response(null, { status: 204 }));
    expect((await out()).status).toBe(204);
    expect(sessionsSent(core)).toEqual(['new2', 'old']);
    expect([...jar.keys()]).toEqual([]);
  });

  it('both sessions unconfirmed: both are kept for the retry, which ends them', async () => {
    jar.set('__Host-ayvo_portal', 'new');
    jar.set('__Host-ayvo_portal_out', 'old');
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new TypeError('connect ECONNREFUSED'));
    expect((await out()).status).toBe(503);
    vi.restoreAllMocks();
    const core = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response(null, { status: 204 }));
    expect((await out()).status).toBe(204);
    expect(sessionsSent(core).sort()).toEqual(['new', 'old']);
    expect([...jar.keys()]).toEqual([]);
  });

  it('a full list of unfinished sign-outs refuses a new sign-in before the core', async () => {
    jar.set('__Host-ayvo_portal_out', ['a', 'b', 'c', 'd'].join(','));
    jar.set('__Host-ayvo_portal_pre', 'p'.repeat(43));
    const core = vi.spyOn(globalThis, 'fetch');
    const res = await signIn();
    expect([res.status, (await res.json()).code]).toEqual([409, 'LOGOUT_INCOMPLETE']);
    expect(core).not.toHaveBeenCalled();
    expect(jar.has('__Host-ayvo_portal')).toBe(false);
  });

  it('nothing to end: 204 without calling the core', async () => {
    const core = vi.spyOn(globalThis, 'fetch');
    expect((await out()).status).toBe(204);
    expect(core).not.toHaveBeenCalled();
  });
});
