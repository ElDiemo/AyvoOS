import { Inject, Injectable, Logger } from '@nestjs/common';
import type { IncomingMessage } from 'node:http';
import { clientIp, TrustedProxies } from '../common/client-ip.js';
import { ENV, type Env } from '../config/env.js';
import { RedisService } from '../redis/redis.service.js';

export type AuthBucket = 'login' | 'callback' | 'callback_failure';

export interface RateDecision {
  allowed: boolean;
  retryAfterSeconds: number;
  /** The store could not decide: sign-in is refused (503), never left unlimited. */
  unavailable?: boolean;
}

/**
 * Rate limits of the sign-in routes (doc 021 §5b), per client IP, in Redis so that every API
 * instance shares the counters (ADR 0010: Redis is non-authoritative — counters only). Fixed
 * window: the first hit starts the window, the counter disappears with it. If Redis cannot give a reliable answer, NEW sign-ins are refused with 503 (fail closed —
 * rate limiting is never silently switched off); established AYVO sessions live in PostgreSQL and
 * keep working. Failures are logged without addresses, credentials or tokens.
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
      const client = await this.redis.ready();
      // One transaction each, so the counter and its window are read together.
      const reply = count
        ? await client.multi().incr(key).pexpire(key, windowMs, 'NX').pttl(key).exec()
        : await client.multi().get(key).pttl(key).exec();
      const { current, ttl } = count ? afterHit(reply) : beforeHit(reply, windowMs);
      const limit = this.max(bucket);
      const exceeded = count ? current > limit : current >= limit;
      return { allowed: !exceeded, retryAfterSeconds: Math.max(1, Math.ceil(ttl / 1000)) };
    } catch (error) {
      this.logger.error(
        `Sign-in rate limit store unavailable (${bucket}): ${(error as Error).name}; sign-in refused`,
      );
      return { allowed: false, retryAfterSeconds: 30, unavailable: true };
    }
  }
}

type ExecReply = [Error | null, unknown][] | null;

/**
 * The checked slots of an EXEC reply. ioredis reports a failed command inside EXEC as an Error in
 * its slot (and an aborted transaction as null) instead of rejecting: any of that is no answer.
 */
function slots(reply: ExecReply, length: number): unknown[] {
  if (!Array.isArray(reply) || reply.length !== length) throw new Error('RateLimitExecAborted');
  for (const [error] of reply) if (error) throw new Error('RateLimitCommandFailed');
  return reply.map(([, value]) => value);
}

const positiveTtl = (ttl: unknown): ttl is number =>
  typeof ttl === 'number' && Number.isFinite(ttl) && ttl > 0;

/** INCR, PEXPIRE NX, PTTL: a counter ≥ 1 with a running window (PEXPIRE NX 0 = already running). */
export function afterHit(reply: ExecReply): { current: number; ttl: number } {
  const [incr, expire, ttl] = slots(reply, 3);
  if (typeof incr !== 'number' || !Number.isSafeInteger(incr) || incr < 1) {
    throw new Error('RateLimitBadCounter');
  }
  if (expire !== 0 && expire !== 1) throw new Error('RateLimitBadExpire');
  if (!positiveTtl(ttl)) throw new Error('RateLimitBadTtl');
  return { current: incr, ttl };
}

/**
 * GET, PTTL without counting: no counter yet (null, -2) is the normal state before a first attempt
 * — zero, never a refusal. An existing counter must be a whole number ≥ 0 with a running window.
 */
export function beforeHit(reply: ExecReply, windowMs: number): { current: number; ttl: number } {
  const [value, ttl] = slots(reply, 2);
  if (value === null) {
    if (ttl !== -2) throw new Error('RateLimitBadTtl');
    return { current: 0, ttl: windowMs };
  }
  if (typeof value !== 'string' || !/^\d{1,15}$/.test(value))
    throw new Error('RateLimitBadCounter');
  if (!positiveTtl(ttl)) throw new Error('RateLimitBadTtl');
  return { current: Number(value), ttl };
}
