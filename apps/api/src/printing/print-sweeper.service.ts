import {
  Inject,
  Injectable,
  Logger,
  type OnModuleDestroy,
  type OnModuleInit,
} from '@nestjs/common';
import { ENV, type Env } from '../config/env.js';
import { PrintQueueService } from './print-queue.service.js';

/**
 * Ends expired print job leases in the background (doc 030 §4): a claim never started returns to
 * the queue, a started job without a result becomes UNCERTAIN. Off when PRINT_SWEEP_SECONDS is 0
 * (tests drive it); the agent's claim also sweeps first.
 */
@Injectable()
export class PrintSweeper implements OnModuleInit, OnModuleDestroy {
  private readonly log = new Logger(PrintSweeper.name);
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private readonly queue: PrintQueueService,
    @Inject(ENV) private readonly env: Env,
  ) {}

  onModuleInit(): void {
    if (this.env.PRINT_SWEEP_SECONDS === 0) return;
    this.timer = setInterval(() => {
      this.queue.sweep().catch((e: unknown) => this.log.warn(`Print sweep failed: ${String(e)}`));
    }, this.env.PRINT_SWEEP_SECONDS * 1000);
    this.timer.unref();
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }
}
