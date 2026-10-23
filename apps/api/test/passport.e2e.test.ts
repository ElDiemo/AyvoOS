import { publicBottlePassportSchema } from '@ayvo/types';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomBytes } from 'node:crypto';
import { PublicRateLimitGuard } from '../src/common/public-rate-limit.guard.js';
import { createTemplate, registerBottles } from './support/fixtures.js';
import { createTestApp, hasDatabase, type TestApp } from './support/test-app.js';

describe.skipIf(!hasDatabase)('public bottle passport', () => {
  let t: TestApp;
  let bottle: { id: string; code: string; publicToken: string; creationBatchId: string };

  beforeAll(async () => {
    t = await createTestApp({}, {}, { redis: 'real' });
    const version = await createTemplate(t.app);
    const { batch } = await registerBottles(t.app, version.versionId, 2);
    bottle = await t.prisma.bottle.findUniqueOrThrow({ where: { code: batch.firstBottleCode } });
  });
  afterAll(() => t?.close());

  const http = () => request(t.app.getHttpServer());

  it('resolves a valid public token to the whitelisted passport', async () => {
    const res = await http().get(`/api/public/bottles/${bottle.publicToken}`).expect(200);
    expect(res.body).toEqual({ bottleCode: bottle.code, reuseCycles: 0 });
    expect(publicBottlePassportSchema.parse(res.body)).toEqual(res.body);
    expect(res.headers['cache-control']).toBe('public, max-age=60');
  });

  it.each([
    ['unknown well-formed token', 'AAAAAAAAAAAAAAAAAAAAAA'],
    ['malformed token', 'not-a-token'],
    ['bottle code instead of token', 'AYV-B-000001'],
  ])('answers 404 for a %s', async (_case, token) => {
    const res = await http().get(`/api/public/bottles/${token}`).expect(404);
    expect(JSON.stringify(res.body)).not.toMatch(/prisma|sql|bottles|uuid/i);
  });

  it('cannot be resolved by internal id', async () => {
    await http().get(`/api/public/bottles/${bottle.id}`).expect(404);
  });

  it('exposes no internal or private fields', async () => {
    const res = await http().get(`/api/public/bottles/${bottle.publicToken}`).expect(200);
    expect(Object.keys(res.body as object).sort()).toEqual(['bottleCode', 'reuseCycles']);
    const text = JSON.stringify(res.body);
    for (const secret of [bottle.id, bottle.creationBatchId, bottle.publicToken])
      expect(text).not.toContain(secret);
    expect(text).not.toMatch(/batch|template|serial|status|created|co2|hotel|operator/i);
  });

  it('an unknown or DEV token reads nothing else and writes nothing', async () => {
    const tables = [
      'bottles',
      'bottle_events',
      'qr_identities',
      'audit_events',
      'operation_requests',
    ];
    const counts = async () =>
      Promise.all(
        tables.map(async (table) => {
          const rows = await t.prisma.$queryRawUnsafe<{ n: bigint }[]>(
            `SELECT count(*) AS n FROM "${table}"`,
          );
          return Number(rows[0]!.n);
        }),
      );
    const before = await counts();
    for (const token of [
      randomBytes(16).toString('base64url'),
      randomBytes(16).toString('base64url'),
    ]) {
      for (const kind of ['bottles', 'crates', 'workstations']) {
        await http().get(`/api/public/${kind}/${token}`).expect(404);
      }
    }
    expect(await counts()).toEqual(before);
  });

  describe('rate limit per visitor (doc 037)', () => {
    let limited: TestApp;
    const prefix = randomBytes(2).readUInt16BE();
    // TEST-NET-3 addresses, unique per run (the counters live in the shared Redis).
    const visitor = (n: number) => `203.0.113.${(prefix + n) % 250}`;
    beforeAll(async () => {
      // As in production: the API trusts the X-Forwarded-For of the web server only.
      limited = await createTestApp(
        { PUBLIC_RATE_LIMIT_MAX: '3', TRUSTED_PROXY_CIDRS: '127.0.0.1/32,::1/128' },
        {},
        { redis: 'real' },
      );
      for (const n of [1, 2])
        await (await limited.redis.ready()).del(PublicRateLimitGuard.key(visitor(n)));
    });
    afterAll(() => limited?.close());
    const as = (ip: string) =>
      request(limited.app.getHttpServer())
        .get(`/api/public/bottles/${bottle.publicToken}`)
        .set('X-Forwarded-For', ip);

    it('counts each visitor on its own; the exceeded one gets 429 with Retry-After', async () => {
      for (let i = 0; i < 3; i++) await as(visitor(1)).expect(200);
      const refused = await as(visitor(1)).expect(429);
      expect(refused.body).toMatchObject({ code: 'RATE_LIMITED' });
      expect(Number(refused.headers['retry-after'])).toBeGreaterThan(0);
      expect(JSON.stringify(refused.body)).not.toContain(visitor(1));
      // Another visitor behind the same web server is not affected.
      await as(visitor(2)).expect(200);
    });

    it('an X-Forwarded-For from an untrusted peer is ignored (no chosen address)', async () => {
      const direct = await createTestApp(
        { PUBLIC_RATE_LIMIT_MAX: '100000' },
        {},
        { redis: 'real' },
      );
      try {
        // TRUSTED_PROXY_CIDRS empty: the socket address counts, not the header.
        const key = PublicRateLimitGuard.key(visitor(3));
        await (await direct.redis.ready()).del(key);
        await request(direct.app.getHttpServer())
          .get(`/api/public/bottles/${bottle.publicToken}`)
          .set('X-Forwarded-For', visitor(3))
          .expect(200);
        expect(await (await direct.redis.ready()).exists(key)).toBe(0);
      } finally {
        await direct.close();
      }
    });
  });

  it('QR54-R1: a failed command inside EXEC (wrong key type) is no answer → 503, never allowed', async () => {
    // An isolated Redis database: the planted keys never meet another test's counters.
    const base = process.env.REDIS_URL ?? 'redis://localhost:6379';
    const isolated = await createTestApp(
      {
        REDIS_URL: `${base.replace(/\/\d+$/, '')}/15`,
        TRUSTED_PROXY_CIDRS: '127.0.0.1/32,::1/128',
      },
      {},
      { redis: 'real' },
    );
    try {
      const redis = await isolated.redis.ready();
      const ip = (n: number) => `198.51.100.${(randomBytes(1)[0]! % 200) + n}`;
      const wrongType = ip(1);
      const notANumber = ip(51);
      // INCR fails inside EXEC with WRONGTYPE / "not an integer": ioredis reports it in the slot.
      await redis.del(PublicRateLimitGuard.key(wrongType), PublicRateLimitGuard.key(notANumber));
      await redis.hset(PublicRateLimitGuard.key(wrongType), 'x', '1');
      await redis.set(PublicRateLimitGuard.key(notANumber), 'abc');
      for (const visitor of [wrongType, notANumber]) {
        const res = await request(isolated.app.getHttpServer())
          .get(`/api/public/bottles/${bottle.publicToken}`)
          .set('X-Forwarded-For', visitor);
        expect(res.status, visitor).toBe(503);
        expect(res.body).toMatchObject({ code: 'TEMPORARILY_UNAVAILABLE' });
        expect(Number(res.headers['retry-after'])).toBeGreaterThan(0);
      }
      await redis.del(PublicRateLimitGuard.key(wrongType), PublicRateLimitGuard.key(notANumber));
    } finally {
      await isolated.close();
    }
  });

  it('without a reliable rate limit store the public routes refuse (503), never unlimited', async () => {
    const noRedis = await createTestApp({}, {}, { redis: 'stub' });
    try {
      const res = await request(noRedis.app.getHttpServer())
        .get(`/api/public/bottles/${bottle.publicToken}`)
        .expect(503);
      expect(res.body).toMatchObject({ code: 'TEMPORARILY_UNAVAILABLE' });
    } finally {
      await noRedis.close();
    }
  });
});
