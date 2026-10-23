import { Inject, Injectable } from '@nestjs/common';
import type { IncomingMessage } from 'node:http';
import { clientIp, TrustedProxies } from '../common/client-ip.js';
import { domainError } from '../common/domain-error.js';
import { ENV, type Env } from '../config/env.js';
import { RedisService } from '../redis/redis.service.js';

/** Independent anonymous card quota. Never consumes the sign-in quota; fails closed. */
@Injectable()
export class EmployeeCardRateLimit {
  private readonly proxies: TrustedProxies;
  constructor(
    private readonly redis: RedisService,
    @Inject(ENV) env: Env,
  ) {
    this.proxies = new TrustedProxies(env.TRUSTED_PROXY_CIDRS);
  }
  async check(req: IncomingMessage): Promise<void> {
    let count: number;
    try {
      const ip = clientIp(req, this.proxies);
      const key = `ayvo:rl:employee-card:${ip}`;
      const result = await (
        await this.redis.ready()
      )
        .multi()
        .incr(key)
        .pexpire(key, 60_000, 'NX')
        .exec();
      if (!result || result.some(([error]) => error)) throw new Error('quota unavailable');
      count = Number(result[0]?.[1]);
      if (!Number.isInteger(count) || count < 1) throw new Error('invalid quota');
    } catch {
      throw domainError(503, 'EMPLOYEE_CARD_UNAVAILABLE', 'Vizitka je dočasně nedostupná.');
    }
    if (count > 120)
      throw domainError(429, 'EMPLOYEE_CARD_RATE_LIMIT', 'Zkuste to prosím za chvíli.');
  }
}
