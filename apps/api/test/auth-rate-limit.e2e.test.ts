import { randomInt } from 'node:crypto';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createTestApp, hasDatabase, type TestApp } from './support/test-app.js';

/**
 * Sign-in rate limiting (doc 021 §5b): Redis counters per client IP, X-Forwarded-For only from
 * trusted proxies, a clean 429 and recovery after the window. Each test uses its own TEST-NET
 * client address, so runs never share counters.
 */
describe.skipIf(!hasDatabase)('sign-in rate limiting', () => {
  let t: TestApp;
  const http = () => request(t.app.getHttpServer());
  const ip = () => `198.18.${randomInt(0, 255)}.${randomInt(1, 254)}`;
  const email = `rate-${randomInt(1e9)}@ayvo.test`;

  beforeAll(async () => {
    t = await createTestApp(
      {
        TRUSTED_PROXY_CIDRS: '127.0.0.1,::1',
        AUTH_RATE_LIMIT_WINDOW_SECONDS: '2',
        AUTH_RATE_LIMIT_LOGIN_MAX: '3',
        AUTH_RATE_LIMIT_CALLBACK_MAX: '5',
        AUTH_RATE_LIMIT_CALLBACK_FAILURES_MAX: '2',
      },
      {},
      { auth: 'real', redis: 'real' },
    );
    await t.prisma.user.create({ data: { email, displayName: 'Rate Test' } });
  });
  afterAll(() => t?.close());

  async function signIn(client: string) {
    const start = await http()
      .get('/api/auth/login')
      .set('X-Forwarded-For', client)
      .query({ next: '/', login_hint: email });
    if (start.status !== 302) return start;
    const binding = /ayvo_login=([^;]+)/.exec(String(start.headers['set-cookie']))![1];
    const authorize = new URL(start.headers.location!);
    const provider = await http().get(authorize.pathname + authorize.search);
    const callback = new URL(provider.headers.location!);
    return http()
      .get(callback.pathname + callback.search)
      .set('X-Forwarded-For', client)
      .set('Cookie', `ayvo_login=${binding}`);
  }

  it('a normal sign-in passes; excessive attempts get a clean 429; the window recovers', async () => {
    const client = ip();
    const ok = await signIn(client);
    expect(ok.status).toBe(302);
    expect(ok.headers.location).toBe('/');
    for (let i = 0; i < 2; i++) {
      await http().get('/api/auth/login').set('X-Forwarded-For', client).expect(302);
    }
    const limited = await http()
      .get('/api/auth/login')
      .set('X-Forwarded-For', client)
      .set('Accept', 'application/json');
    expect(limited.status).toBe(429);
    expect(limited.body).toEqual({
      statusCode: 429,
      code: 'RATE_LIMITED',
      message: 'Too many sign-in attempts. Try again later.',
    });
    expect(Number(limited.headers['retry-after'])).toBeGreaterThanOrEqual(1);
    expect(limited.headers['set-cookie']).toBeUndefined();
    // A browser gets a short Czech page; nothing about the limit or the client is revealed.
    const page = await http()
      .get('/api/auth/login')
      .set('X-Forwarded-For', client)
      .set('Accept', 'text/html');
    expect(page.status).toBe(429);
    expect(page.text).toContain('Příliš mnoho pokusů');
    expect(page.text).not.toContain(client);
    // Another client is not affected.
    await http().get('/api/auth/login').set('X-Forwarded-For', ip()).expect(302);
    // After the window the same client may sign in again.
    await vi.waitFor(
      async () => {
        const again = await http().get('/api/auth/login').set('X-Forwarded-For', client);
        expect(again.status).toBe(302);
      },
      { timeout: 8000, interval: 250 },
    );
    expect((await signIn(client)).headers.location).toBe('/');
  });

  it('failed callbacks block further callbacks before the state is touched', async () => {
    const client = ip();
    for (let i = 0; i < 2; i++) {
      const bad = await http()
        .get('/api/auth/callback')
        .query({ code: 'x', state: 'y' })
        .set('X-Forwarded-For', client);
      expect(bad.headers.location).toBe('/login?error=invalid');
    }
    // Even a valid attempt from this client now waits — and its state is not consumed.
    const start = await http()
      .get('/api/auth/login')
      .set('X-Forwarded-For', client)
      .query({ next: '/', login_hint: email })
      .expect(302);
    const binding = /ayvo_login=([^;]+)/.exec(String(start.headers['set-cookie']))![1];
    const authorize = new URL(start.headers.location!);
    const provider = await http().get(authorize.pathname + authorize.search);
    const callback = new URL(provider.headers.location!);
    const blocked = await http()
      .get(callback.pathname + callback.search)
      .set('X-Forwarded-For', client)
      .set('Cookie', `ayvo_login=${binding}`);
    expect(blocked.status).toBe(429);
    await vi.waitFor(
      async () => {
        const res = await http()
          .get(callback.pathname + callback.search)
          .set('X-Forwarded-For', client)
          .set('Cookie', `ayvo_login=${binding}`);
        expect(res.status).toBe(302);
        expect(res.headers.location).toBe('/');
      },
      { timeout: 8000, interval: 250 },
    );
  });

  it('X-Forwarded-For from an untrusted peer cannot dodge the limit', async () => {
    const untrusted = await createTestApp(
      {
        TRUSTED_PROXY_CIDRS: '',
        AUTH_RATE_LIMIT_WINDOW_SECONDS: '600',
        AUTH_RATE_LIMIT_LOGIN_MAX: '1',
      },
      {},
      { auth: 'real', redis: 'real' },
    );
    try {
      // The peer (127.0.0.1) is the client; its key is cleared so earlier runs do not matter.
      await t.redis.client.del('ayvo:rl:auth:login:127.0.0.1', 'ayvo:rl:auth:login:::1');
      const r = () => request(untrusted.app.getHttpServer()).get('/api/auth/login');
      await r().set('X-Forwarded-For', ip()).expect(302);
      expect((await r().set('X-Forwarded-For', ip())).status).toBe(429);
    } finally {
      await t.redis.client.del('ayvo:rl:auth:login:127.0.0.1', 'ayvo:rl:auth:login:::1');
      await untrusted.close();
    }
  });

  it('an unavailable rate-limit store does not lock everyone out', async () => {
    const noRedis = await createTestApp(
      { REDIS_URL: 'redis://127.0.0.1:1', AUTH_RATE_LIMIT_LOGIN_MAX: '1' },
      {},
      { auth: 'real', redis: 'real' },
    );
    try {
      for (let i = 0; i < 3; i++) {
        await request(noRedis.app.getHttpServer()).get('/api/auth/login').expect(302);
      }
    } finally {
      await noRedis.close();
    }
  });
});
