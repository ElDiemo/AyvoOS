import { Inject, Injectable, type OnModuleDestroy } from '@nestjs/common';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../generated/finance-prisma/client.js';
import { FINANCE_ENV, type FinanceEnv } from './finance-env.js';

/**
 * Finance's own database client (ADR 0039): the runtime role `ayvo_finance`, schema `finance`
 * only, its own small pool. It cannot read or write a core table (PostgreSQL refuses).
 */
@Injectable()
export class FinancePrismaService extends PrismaClient implements OnModuleDestroy {
  constructor(@Inject(FINANCE_ENV) env: FinanceEnv) {
    super({ adapter: new PrismaPg({ connectionString: env.FINANCE_DATABASE_URL, max: 4 }) });
  }

  async onModuleDestroy(): Promise<void> {
    await this.$disconnect();
  }
}
