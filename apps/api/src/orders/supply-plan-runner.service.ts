import {
  Inject,
  Injectable,
  Logger,
  type OnModuleDestroy,
  type OnModuleInit,
} from '@nestjs/common';
import { ENV, type Env } from '../config/env.js';
import { SupplyPlansService } from './supply-plans.service.js';

/**
 * The background round of supply plans (doc 032), in the application's existing infrastructure
 * (as ShipmentPoller — no separate scheduler). Everything it needs is in the database, so a
 * restart simply continues and fills the missing future occurrences; several processes are safe
 * (plan row lock + unique occurrence). Off when SUPPLY_PLAN_SECONDS is 0 (tests drive it).
 */
@Injectable()
export class SupplyPlanRunner implements OnModuleInit, OnModuleDestroy {
  private readonly log = new Logger(SupplyPlanRunner.name);
  private timer: NodeJS.Timeout | null = null;
  private running = false;

  constructor(
    private readonly plans: SupplyPlansService,
    @Inject(ENV) private readonly env: Env,
  ) {}

  onModuleInit(): void {
    if (this.env.SUPPLY_PLAN_SECONDS === 0) return;
    this.timer = setInterval(() => void this.tick(), this.env.SUPPLY_PLAN_SECONDS * 1000);
    this.timer.unref();
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  async tick(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      await this.plans.runDue();
    } catch (error) {
      this.log.warn(`Supply plan round failed: ${String(error)}`);
    } finally {
      this.running = false;
    }
  }
}
