import {
  Inject,
  Injectable,
  Logger,
  type OnModuleDestroy,
  type OnModuleInit,
} from '@nestjs/common';
import { ENV, type Env } from '../config/env.js';
import { ShipmentCarrierFlow } from './shipment-carrier-flow.service.js';
import { ShipmentTrackingService } from './shipment-tracking.service.js';

/**
 * Bounded background polling of accepted carrier requests and of label downloads (doc 029 §3).
 * The state (next look, count) is in the database, so a restart simply continues; several API
 * processes share the work (SKIP LOCKED). Off when CARRIER_POLL_SECONDS is 0 (tests drive it).
 */
@Injectable()
export class ShipmentPoller implements OnModuleInit, OnModuleDestroy {
  private readonly log = new Logger(ShipmentPoller.name);
  private timer: NodeJS.Timeout | null = null;
  private running = false;

  constructor(
    private readonly flow: ShipmentCarrierFlow,
    private readonly tracking: ShipmentTrackingService,
    @Inject(ENV) private readonly env: Env,
  ) {}

  onModuleInit(): void {
    if (this.env.CARRIER_POLL_SECONDS === 0) return;
    this.timer = setInterval(() => void this.tick(), this.env.CARRIER_POLL_SECONDS * 1000);
    this.timer.unref();
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  async tick(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      await this.flow.pollDue();
      // The ZPL of labelled shipments for printing (doc 030 §2).
      await this.flow.variantsDue();
      // Tracking of labelled shipments at their carrier (doc 031).
      await this.tracking.due();
    } catch (error) {
      this.log.warn(`Carrier polling failed: ${String(error)}`);
    } finally {
      this.running = false;
    }
  }
}
