import {
  Inject,
  Injectable,
  Logger,
  type OnModuleDestroy,
  type OnModuleInit,
} from '@nestjs/common';
import { ENV, type Env } from '../config/env.js';
import { CarrierPickupsService } from './carrier-pickups.service.js';
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
  private pickupsRunning = false;

  constructor(
    private readonly flow: ShipmentCarrierFlow,
    private readonly tracking: ShipmentTrackingService,
    private readonly pickups: CarrierPickupsService,
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

  /**
   * One round: the shipments' work (label requests, ZPL, tracking) and the pickups' work (doc 029
   * §11) side by side, each with its own single-flight guard and its own error handling — a pickup
   * call still waiting for its carrier (up to CARRIER_CALL_TIMEOUT_SECONDS per call) never makes the
   * next rounds skip labels, ZPL or tracking, and never starts a second pickup round meanwhile. The
   * work itself stays owned in the database (leases, SKIP LOCKED, the operations' own limits), as
   * between several API processes.
   */
  async tick(): Promise<void> {
    await Promise.all([this.shipmentsRound(), this.pickupsRound()]);
  }

  private async shipmentsRound(): Promise<void> {
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

  private async pickupsRound(): Promise<void> {
    if (this.pickupsRunning) return;
    this.pickupsRunning = true;
    try {
      // Accepted pickup orders and cancellations at their carrier (doc 029 §11).
      await this.pickups.pollDue();
    } catch (error) {
      this.log.warn(`Pickup polling failed: ${String(error)}`);
    } finally {
      this.pickupsRunning = false;
    }
  }
}
