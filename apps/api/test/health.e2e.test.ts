import { healthResponseSchema } from '@ayvo/types';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { afterEach, describe, expect, it } from 'vitest';
import { configureApp } from '../src/app.setup.js';
import { ConfigModule } from '../src/config/config.module.js';
import { ENV, loadEnv } from '../src/config/env.js';
import { PrismaService } from '../src/database/prisma.service.js';
import { HealthModule } from '../src/health/health.module.js';
import { RedisService } from '../src/redis/redis.service.js';
import { DatabaseModule } from '../src/database/database.module.js';
import { RedisModule } from '../src/redis/redis.module.js';

const testEnv = loadEnv({
  APP_ENV: 'test',
  DATABASE_URL: 'postgresql://user:pass@localhost:5432/ayvo_test',
  REDIS_URL: 'redis://localhost:6379',
});

async function createApp(deps: { dbUp: boolean; redisUp: boolean }): Promise<INestApplication> {
  const moduleRef = await Test.createTestingModule({
    imports: [ConfigModule, DatabaseModule, RedisModule, HealthModule],
  })
    .overrideProvider(ENV)
    .useValue(testEnv)
    .overrideProvider(PrismaService)
    .useValue({
      $queryRaw: () => (deps.dbUp ? Promise.resolve([1]) : Promise.reject(new Error('db down'))),
      $disconnect: () => Promise.resolve(),
    })
    .overrideProvider(RedisService)
    .useValue({
      ping: () => (deps.redisUp ? Promise.resolve('PONG') : Promise.reject(new Error('down'))),
    })
    .compile();

  const app = configureApp(moduleRef.createNestApplication());
  await app.init();
  return app;
}

describe('GET /api/health', () => {
  let app: INestApplication | undefined;

  afterEach(async () => {
    await app?.close();
  });

  it('reports ok when PostgreSQL and Redis are reachable', async () => {
    app = await createApp({ dbUp: true, redisUp: true });
    const res = await request(app.getHttpServer()).get('/api/health').expect(200);

    const body = healthResponseSchema.parse(res.body);
    expect(body.status).toBe('ok');
    expect(body.environment).toBe('test');
    expect(body.checks).toEqual({ database: 'up', redis: 'up' });
  });

  it('reports degraded (not a crash) when a dependency is down', async () => {
    app = await createApp({ dbUp: false, redisUp: true });
    const res = await request(app.getHttpServer()).get('/api/health').expect(200);

    const body = healthResponseSchema.parse(res.body);
    expect(body.status).toBe('degraded');
    expect(body.checks.database).toBe('down');
  });

  // The reverse proxy forwards /api/* unchanged (ADR 0013): the prefix must be neither
  // stripped nor applied twice.
  it.each(['/health', '/api/api/health'])('does not serve %s', async (path) => {
    app = await createApp({ dbUp: true, redisUp: true });
    await request(app.getHttpServer()).get(path).expect(404);
  });
});
