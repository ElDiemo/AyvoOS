import { Inject, Injectable, Logger } from '@nestjs/common';
import type { IncomingMessage } from 'node:http';
import { clientIp, TrustedProxies } from '../common/client-ip.js';
import { ENV, type Env } from '../config/env.js';
import { RedisService } from '../redis/redis.service.js';

export type AuthBucket = 'login' | 'callback' | 'callback_failure';

export interface RateDecision {
  allowed: boolean;
  retryAfterSeconds: number;
}

/**
 * Rate limits of the sign-in routes (doc 021 §5b), per client IP, in Redis so that every API
 * instance shares the counters (ADR 0010: Redis is non-authoritative — counters only). Fixed
 * window: the first hit starts the window, the counter disappears with it. If Redis is
 * unavailable the request is allowed and the failure logged: the identity provider and the
 * one-time state/PKCE checks still protect sign-in, and an outage must not lock everyone out.
 */
@Injectable()
export class AuthRateLimitService {
  private readonly logger = new Logger(AuthRateLimitService.name);
  private readonly proxies: TrustedProxies;

  constructor(
    private readonly redis: RedisService,
    @Inject(ENV) private readonly env: Env,
  ) {
    this.proxies = new TrustedProxies(env.TRUSTED_PROXY_CIDRS);
  }

  clientIp(req: IncomingMessage): string {
    return clientIp(req, this.proxies);
  }

  private max(bucket: AuthBucket): number {
    return bucket === 'login'
      ? this.env.AUTH_RATE_LIMIT_LOGIN_MAX
      : bucket === 'callback'
        ? this.env.AUTH_RATE_LIMIT_CALLBACK_MAX
        : this.env.AUTH_RATE_LIMIT_CALLBACK_FAILURES_MAX;
  }

  static key(bucket: AuthBucket, ip: string): string {
    return `ayvo:rl:auth:${bucket}:${ip}`;
  }

  /** Counts one attempt; refused once the window's maximum is exceeded. */
  async hit(bucket: AuthBucket, ip: string): Promise<RateDecision> {
    return this.run(bucket, ip, true);
  }

  /** Whether the bucket is already exhausted, without counting (failures are counted later). */
  async check(bucket: AuthBucket, ip: string): Promise<RateDecision> {
    return this.run(bucket, ip, false);
  }

  private async run(bucket: AuthBucket, ip: string, count: boolean): Promise<RateDecision> {
    const key = AuthRateLimitService.key(bucket, ip);
    const windowMs = this.env.AUTH_RATE_LIMIT_WINDOW_SECONDS * 1000;
    try {
      const client = this.redis.client;
      if (client.status === 'wait') await client.connect();
      let current: number;
      let ttl: number;
      if (count) {
        const result = await client.multi().incr(key).pexpire(key, windowMs, 'NX').pttl(key).exec();
        current = Number(result?.[0]?.[1] ?? 0);
        ttl = Number(result?.[2]?.[1] ?? windowMs);
      } else {
        const [value, pttl] = await Promise.all([client.get(key), client.pttl(key)]);
        current = Number(value ?? 0);
        ttl = pttl;
      }
      const limit = this.max(bucket);
      const exceeded = count ? current > limit : current >= limit;
      return { allowed: !exceeded, retryAfterSeconds: Math.max(1, Math.ceil(ttl / 1000)) };
    } catch (error) {
      this.logger.error(
        `Rate limit store unavailable (${bucket}); request allowed: ${(error as Error).message}`,
      );
      return { allowed: true, retryAfterSeconds: 0 };
    }
  }
}
