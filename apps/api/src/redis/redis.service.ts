import { Inject, Injectable, Logger, type OnModuleDestroy } from '@nestjs/common';
import { Redis } from 'ioredis';
import { ENV, type Env } from '../config/env.js';

/**
 * Redis is non-authoritative (ADR 0010): cache, queues, rate limiting only.
 * Never store business state here that is not also persisted in PostgreSQL.
 */
@Injectable()
export class RedisService implements OnModuleDestroy {
  private readonly logger = new Logger(RedisService.name);
  readonly client: Redis;

  constructor(@Inject(ENV) env: Env) {
    this.client = new Redis(env.REDIS_URL, {
      lazyConnect: true,
      maxRetriesPerRequest: 1,
      retryStrategy: (attempt) => Math.min(attempt * 500, 10_000),
    });
    // Connection failures surface as AggregateError with an empty message; fall back to the code.
    this.client.on('error', (error: NodeJS.ErrnoException) =>
      this.logger.warn(`Redis error: ${error.message || error.code || error.name}`),
    );
  }

  async ping(): Promise<string> {
    if (this.client.status === 'wait') await this.client.connect();
    return this.client.ping();
  }

  async onModuleDestroy(): Promise<void> {
    this.client.disconnect();
  }
}
