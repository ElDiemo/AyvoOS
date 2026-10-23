import {
  Inject,
  Injectable,
  Logger,
  type CanActivate,
  type ExecutionContext,
} from '@nestjs/common';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { ENV, type Env } from '../config/env.js';
import { RedisService } from '../redis/redis.service.js';
import { clientIp, TrustedProxies } from './client-ip.js';
import { domainError } from './domain-error.js';

/**
 * Rate limit of the anonymous public routes (QR passports of bottles, crates and workstations):
 * at most PUBLIC_RATE_LIMIT_MAX requests per client IP and PUBLIC_RATE_LIMIT_WINDOW_SECONDS, in
 * Redis (counters only, ADR 0010). The client IP honours X-Forwarded-For only from
 * TRUSTED_PROXY_CIDRS: behind the public QR edge that is the visitor, so visitors are never one
 * address (doc 037). Exceeded → 429; without a reliable answer from Redis → 503 (fail closed, as
 * the sign-in limits). Nothing is logged about the client.
 */
@Injectable()
export class PublicRateLimitGuard implements CanActivate {
  private readonly logger = new Logger(PublicRateLimitGuard.name);
  private readonly proxies: TrustedProxies;

  constructor(
    private readonly redis: RedisService,
    @Inject(ENV) private readonly env: Env,
  ) {
    this.proxies = new TrustedProxies(env.TRUSTED_PROXY_CIDRS);
  }

  static key(ip: string): string {
    return `ayvo:rl:public:${ip}`;
  }

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const http = context.switchToHttp();
    const req = http.getRequest<IncomingMessage>();
    const res = http.getResponse<ServerResponse>();
    const key = PublicRateLimitGuard.key(clientIp(req, this.proxies));
    const windowMs = this.env.PUBLIC_RATE_LIMIT_WINDOW_SECONDS * 1000;
    let current: number;
    let ttl: number;
    try {
      const client = await this.redis.ready();
      const result = await client.multi().incr(key).pexpire(key, windowMs, 'NX').pttl(key).exec();
      current = Number(result?.[0]?.[1] ?? 0);
      ttl = Number(result?.[2]?.[1] ?? windowMs);
    } catch (error) {
      this.logger.error(`Public rate limit store unavailable: ${(error as Error).name}`);
      res.setHeader('Retry-After', '30');
      throw domainError(503, 'TEMPORARILY_UNAVAILABLE', 'Temporarily unavailable');
    }
    if (current > this.env.PUBLIC_RATE_LIMIT_MAX) {
      res.setHeader('Retry-After', String(Math.max(1, Math.ceil(ttl / 1000))));
      throw domainError(429, 'RATE_LIMITED', 'Too many requests');
    }
    return true;
  }
}
