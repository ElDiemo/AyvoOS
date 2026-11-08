import { Inject, Injectable, type OnModuleDestroy } from '@nestjs/common';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../generated/finance-prisma/client.js';
import { FINANCE_ENV, type FinanceEnv } from './finance-env.js';

/** The application name of the portal pool's connections (visible in pg_stat_activity). */
export const FINANCE_PORTAL_APPLICATION = 'ayvo-finance-portal';

/**
 * Finance's database client for hotel portal reads (ADR 0045 §8): its own pool of
 * `FINANCE_PORTAL_DB_POOL_MAX` (1) connection beside the staff pool (4), which stays whole. The same
 * runtime role (`finance` schema only). Its work is bounded: the wait for its connection and each
 * statement, lock waits included, time out.
 */
@Injectable()
export class FinancePortalPrismaService extends PrismaClient implements OnModuleDestroy {
  constructor(@Inject(FINANCE_ENV) env: FinanceEnv) {
    super({
      adapter: new PrismaPg({
        connectionString: env.FINANCE_DATABASE_URL,
        max: env.FINANCE_PORTAL_DB_POOL_MAX,
        application_name: FINANCE_PORTAL_APPLICATION,
        connectionTimeoutMillis: env.FINANCE_PORTAL_DB_ACQUIRE_TIMEOUT_MS,
        statement_timeout: env.FINANCE_PORTAL_DB_STATEMENT_TIMEOUT_MS,
        idle_in_transaction_session_timeout: env.FINANCE_PORTAL_DB_STATEMENT_TIMEOUT_MS,
      }),
    });
  }

  async onModuleDestroy(): Promise<void> {
    await this.$disconnect();
  }
}
