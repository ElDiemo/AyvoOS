import { HttpException, Inject, Injectable, Logger } from '@nestjs/common';
import { domainError } from '../common/domain-error.js';
import { ENV, type Env } from '../config/env.js';

/**
 * The portal routes' request limit (ADR 0045 §8): at most `PORTAL_MAX_IN_FLIGHT` (8) portal
 * requests per process, in front of the portal pool. The rest are refused with 503 at once, never
 * queued. A slot is released when its work ends, however it ends — and that work is bounded by
 * the portal pool's timeouts. Any failure that is not a domain answer is 503 without data.
 */
@Injectable()
export class PortalRequestLimit {
  private readonly logger = new Logger(PortalRequestLimit.name);
  private active = 0;

  constructor(@Inject(ENV) private readonly env: Env) {}

  /** Requests holding a slot now (tests and diagnostics). */
  get inFlight(): number {
    return this.active;
  }

  async run<T>(work: () => Promise<T>): Promise<T> {
    if (this.active >= this.env.PORTAL_MAX_IN_FLIGHT)
      throw domainError(503, 'PORTAL_BUSY', 'The hotel portal is busy; try again shortly');
    this.active++;
    try {
      return await work();
    } catch (error) {
      if (error instanceof HttpException) throw error;
      // A timeout or any other failure below the route: no data, never a broader answer (§8).
      this.logger.warn(`Portal request failed: ${(error as Error).name}`);
      throw domainError(503, 'PORTAL_UNAVAILABLE', 'The hotel portal is unavailable right now');
    } finally {
      this.active--;
    }
  }
}
