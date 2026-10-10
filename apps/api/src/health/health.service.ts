import type { DependencyStatus, HealthResponse } from '@ayvo/types';
import { Inject, Injectable } from '@nestjs/common';
import { ENV, type Env } from '../config/env.js';
import { PrismaService } from '../database/prisma.service.js';
import { RedisService } from '../redis/redis.service.js';

const CHECK_TIMEOUT_MS = 2_000;

async function probe(check: () => Promise<unknown>): Promise<DependencyStatus> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error('timeout')), CHECK_TIMEOUT_MS);
  });
  try {
    await Promise.race([check(), timeout]);
    return 'up';
  } catch {
    return 'down';
  } finally {
    clearTimeout(timer);
  }
}

@Injectable()
export class HealthService {
  constructor(
    @Inject(ENV) private readonly env: Env,
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
  ) {}

  async check(): Promise<HealthResponse> {
    const [database, redis] = await Promise.all([
      probe(() => this.prisma.$queryRaw`SELECT 1`),
      probe(() => this.redis.ping()),
    ]);

    return {
      status: database === 'up' && redis === 'up' ? 'ok' : 'degraded',
      service: 'ayvo-api',
      environment: this.env.APP_ENV,
      timestamp: new Date().toISOString(),
      checks: { database, redis },
    };
  }
}
