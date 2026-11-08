import { Inject, Injectable, type OnModuleDestroy } from '@nestjs/common';
import { PrismaPg } from '@prisma/adapter-pg';
import { ENV, type Env } from '../config/env.js';
import { PrismaClient } from '../generated/prisma/client.js';

/**
 * The hotel portal contract's own database client (ADR 0045 §8): its own pg pool of
 * `PORTAL_DB_POOL_MAX` (2) connections, a reserved resource. Portal routes use only this client,
 * so portal load can never take a connection staff work needs (the staff pool stays whole).
 * Its database work is bounded (§8): waiting for a connection and each statement time out, so a
 * stuck read never keeps a request slot or a connection. Same database, same runtime role.
 */
@Injectable()
export class PortalPrismaService extends PrismaClient implements OnModuleDestroy {
  constructor(@Inject(ENV) env: Env) {
    super({
      adapter: new PrismaPg({
        connectionString: env.DATABASE_URL,
        max: env.PORTAL_DB_POOL_MAX,
        // Waiting for a free portal connection is bounded…
        connectionTimeoutMillis: env.PORTAL_DB_ACQUIRE_TIMEOUT_MS,
        // …and so is every statement, lock waits included (the server cancels it). An open
        // transaction left idle never holds a connection for long either.
        statement_timeout: env.PORTAL_DB_STATEMENT_TIMEOUT_MS,
        idle_in_transaction_session_timeout: env.PORTAL_DB_STATEMENT_TIMEOUT_MS,
      }),
    });
  }

  async onModuleDestroy(): Promise<void> {
    await this.$disconnect();
  }
}
