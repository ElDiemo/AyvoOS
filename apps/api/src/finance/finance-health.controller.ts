import { Controller, Get, HttpCode, Inject } from '@nestjs/common';
import { ADMIN_PREFIX } from '../common/routes.js';
import { Public } from '../identity/access.decorators.js';
import { dependencyUnavailable } from './core-client.js';
import { FINANCE_ENV, type FinanceEnv } from './finance-env.js';
import { FinancePrismaService } from './finance-prisma.service.js';

/**
 * Health of the Finance unit (ADR 0039 §2): `live` = the process answers (the container health
 * check — it never depends on the core); `ready` = its database and the core answer, i.e. the
 * operations that need the core can be done now. No data, no secrets.
 */
@Controller(`${ADMIN_PREFIX}/finance/health`)
export class FinanceHealthController {
  constructor(
    private readonly prisma: FinancePrismaService,
    @Inject(FINANCE_ENV) private readonly env: FinanceEnv,
  ) {}

  @Public()
  @Get('live')
  live() {
    return { status: 'live' };
  }

  @Public()
  @Get('ready')
  @HttpCode(200)
  async ready() {
    try {
      await this.prisma.$queryRaw`SELECT 1`;
      const core = await fetch(`${this.env.CORE_INTERNAL_URL}/api/health`, {
        signal: AbortSignal.timeout(this.env.CORE_TIMEOUT_MS),
      });
      if (!core.ok) throw new Error('core');
    } catch {
      throw dependencyUnavailable();
    }
    return { status: 'ready' };
  }
}
