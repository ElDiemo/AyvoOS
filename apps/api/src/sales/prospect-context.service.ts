import { Injectable } from '@nestjs/common';
import type { Principal } from '../identity/principal.js';
import { assertActive, scopeOf, visibleProspect, type Db } from './sales-access.js';

/** What another module may know about a prospect: its identity and the context to prefill from. */
export interface ProspectContext {
  id: string;
  code: string;
  name: string;
  addressLine1: string | null;
  addressLine2: string | null;
  postalCode: string | null;
  city: string | null;
  countryCode: string;
  roomsEstimate: number | null;
  archived: boolean;
}

const view = (row: Awaited<ReturnType<typeof visibleProspect>>): ProspectContext => ({
  id: row.id,
  code: row.code,
  name: row.name,
  addressLine1: row.addressLine1,
  addressLine2: row.addressLine2,
  postalCode: row.postalCode,
  city: row.city,
  countryCode: row.countryCode,
  roomsEstimate: row.roomsEstimate,
  archived: row.archivedAt !== null,
});

/**
 * The only way other modules (contract drafts, ADR 0043) see a prospect: through the caller's
 * sales scope (doc 034 §7) — another salesperson's prospect is 404 / null, as in Obchod itself.
 * Read-only; nothing of Obchod is written from outside.
 */
@Injectable()
export class ProspectContextService {
  /** The prospect by its code, or 404 when it does not exist or is out of the caller's scope. */
  async visibleByCode(db: Db, code: string, p: Principal, lock = false): Promise<ProspectContext> {
    return view(await visibleProspect(db, code, scopeOf(p), lock));
  }

  /** The prospect by its id if the caller may see it; otherwise null (never revealed). */
  async visibleById(db: Db, id: string, p: Principal): Promise<ProspectContext | null> {
    const row = await db.salesProspect.findUnique({ where: { id } });
    const scope = scopeOf(p);
    if (!row || (!scope.all && row.ownerId !== scope.userId)) return null;
    return view(row);
  }

  /** An archived prospect takes no new work (doc 034 §3a). */
  assertActive(prospect: ProspectContext): void {
    assertActive({ archivedAt: prospect.archived ? new Date(0) : null });
  }
}
