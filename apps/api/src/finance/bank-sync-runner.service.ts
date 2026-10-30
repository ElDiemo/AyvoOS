import { randomUUID } from 'node:crypto';
import {
  Inject,
  Injectable,
  Logger,
  type OnModuleDestroy,
  type OnModuleInit,
} from '@nestjs/common';
import { BankSyncService } from './bank-sync.service.js';
import type { FinanceCaller } from './finance-access.guard.js';
import { FINANCE_ENV, type FinanceEnv } from './finance-env.js';
import { PaymentsService } from './payments.service.js';

/** Who a scheduled round acts as: no user and no permissions — only a name on its records. */
const SCHEDULED: FinanceCaller = {
  principal: {
    userId: '00000000-0000-0000-0000-000000000000',
    displayName: 'Plánované načtení',
    permissions: [],
    globalSiteAccess: false,
    siteIds: [],
  },
  sessionToken: '',
};

/**
 * Scheduled reading of the bank (doc 041 §9, proposal): off unless RB_PREMIUM_SYNC_SECONDS is set,
 * which has no default and no deployment sets it. A round does what a person does by hand, through
 * the same code and limits: reads each account (slot fencing, one deadline, bounded data), then
 * records payments from what was read (exact-VS matching only; anything unclear waits for a
 * person). A failure stays visible as that run's result and the next round simply tries again:
 * no retry of its own, no second record of invoices or payments, nothing ever sent to the bank.
 */
@Injectable()
export class BankSyncRunner implements OnModuleInit, OnModuleDestroy {
  private readonly log = new Logger(BankSyncRunner.name);
  private timer: NodeJS.Timeout | null = null;
  private running = false;

  constructor(
    private readonly bank: BankSyncService,
    private readonly payments: PaymentsService,
    @Inject(FINANCE_ENV) private readonly env: FinanceEnv,
  ) {}

  get enabled(): boolean {
    return this.timer !== null;
  }

  onModuleInit(): void {
    const seconds = this.env.RB_PREMIUM_SYNC_SECONDS;
    if (seconds === undefined) return;
    this.timer = setInterval(() => void this.tick(), seconds * 1000);
    this.timer.unref();
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** One round; never overlaps itself in this process, other processes are fenced by the slots. */
  async tick(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      const { runs, busy } = await this.bank.syncScheduled(SCHEDULED);
      const succeeded = runs.filter((r) => r.status === 'SUCCEEDED').length;
      // Counts and codes only: never an account's transactions.
      this.log.log(`Bank round: ${succeeded}/${runs.length} read, ${busy} busy`);
      if (succeeded > 0) {
        const loaded = await this.payments.importBank(randomUUID(), SCHEDULED);
        this.log.log(
          `Bank round: ${loaded.created.length} payments, ${loaded.matched} matched, ${loaded.toReview} to review`,
        );
      }
    } catch (error) {
      this.log.warn(`Bank round failed: ${error instanceof Error ? error.name : 'unknown'}`);
    } finally {
      this.running = false;
    }
  }
}
