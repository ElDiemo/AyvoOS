import {
  Inject,
  Injectable,
  Logger,
  type OnModuleDestroy,
  type OnModuleInit,
} from '@nestjs/common';
import { FINANCE_ENV, type FinanceEnv } from './finance-env.js';
import { InvoiceDeliveriesService } from './invoice-deliveries.service.js';

/** At most this many messages per round, one at a time, so a backlog stays bounded. */
const MAX_PER_ROUND = 5;

/**
 * Works off the delivery queue (doc 043): off unless FINANCE_INVOICE_MAIL is set. Deliveries appear
 * only by a person's request; this never decides to send anything by itself. Other processes are
 * fenced by the row lock.
 */
@Injectable()
export class InvoiceDeliveryRunner implements OnModuleInit, OnModuleDestroy {
  private readonly log = new Logger(InvoiceDeliveryRunner.name);
  private timer: NodeJS.Timeout | null = null;
  private running = false;

  constructor(
    private readonly deliveries: InvoiceDeliveriesService,
    @Inject(FINANCE_ENV) private readonly env: FinanceEnv,
  ) {}

  onModuleInit(): void {
    if (!this.env.FINANCE_INVOICE_MAIL) return;
    this.timer = setInterval(() => void this.tick(), this.env.FINANCE_INVOICE_MAIL_POLL_MS);
    this.timer.unref();
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  async tick(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      await this.deliveries.settleInterrupted();
      for (let i = 0; i < MAX_PER_ROUND; i++) if (!(await this.deliveries.sendNext())) break;
    } catch (error) {
      this.log.warn(`Delivery round failed: ${error instanceof Error ? error.name : 'unknown'}`);
    } finally {
      this.running = false;
    }
  }
}
