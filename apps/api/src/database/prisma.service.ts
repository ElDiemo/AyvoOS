import { Inject, Injectable, type OnModuleDestroy } from '@nestjs/common';
import { PrismaPg } from '@prisma/adapter-pg';
import { ENV, type Env } from '../config/env.js';
import { PrismaClient } from '../generated/prisma/client.js';

/**
 * Options of every core runtime connection: this image knows the portal's operational boundary
 * (v6) and applies its read rule itself, so row-level security shows it every grant hotel. An
 * older image does not send it and sees only hotels no fence closes (migration
 * 20261115090000_portal_boundary_old_image_guard) — a return to it never bypasses a fence.
 */
export const CORE_CONNECTION_OPTIONS = '-c ayvo.portal_boundary=v6';

/**
 * Single PrismaClient for the whole monolith. Connects lazily on first query,
 * so the API can start (and report `degraded` health) while PostgreSQL is down.
 */
@Injectable()
export class PrismaService extends PrismaClient implements OnModuleDestroy {
  constructor(@Inject(ENV) env: Env) {
    super({
      adapter: new PrismaPg({
        connectionString: env.DATABASE_URL,
        options: CORE_CONNECTION_OPTIONS,
      }),
    });
  }

  async onModuleDestroy(): Promise<void> {
    await this.$disconnect();
  }
}
