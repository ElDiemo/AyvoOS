import type { SiteDependency } from '@ayvo/types';
import { Injectable } from '@nestjs/common';
import type { Prisma } from '../generated/prisma/client.js';

/** Reports what of a module still depends on an active site (doc 022 §6–7). */
export type SiteDependencyCheck = (
  siteId: string,
  db: Prisma.TransactionClient,
) => Promise<SiteDependency[]>;

/**
 * Modules that keep records on a site (hotels served by it, its orders) register their check
 * here, so the sites module refuses a deactivation without reading their tables (ADR 0001). The
 * checks run inside the deactivation transaction, under the site lock; writers that create such
 * records take a share lock on the site row first, so neither side acts on a stale result.
 */
@Injectable()
export class SiteDependencyRegistry {
  private readonly checks: SiteDependencyCheck[] = [];

  register(check: SiteDependencyCheck): void {
    this.checks.push(check);
  }

  async run(siteId: string, db: Prisma.TransactionClient): Promise<SiteDependency[]> {
    const found: SiteDependency[] = [];
    for (const check of this.checks) found.push(...(await check(siteId, db)));
    return found;
  }
}

/**
 * A share lock on one site row: conflicts with the site lock of every site change (deactivation
 * included) and is held until the caller's transaction ends.
 */
export async function lockSiteShared(tx: Prisma.TransactionClient, siteId: string): Promise<void> {
  await tx.$queryRaw`SELECT 1 FROM "sites" WHERE "id" = ${siteId}::uuid FOR SHARE`;
}
