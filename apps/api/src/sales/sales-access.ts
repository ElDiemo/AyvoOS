import { NotFoundException } from '@nestjs/common';
import { SALES_TIME_ZONE } from '@ayvo/types';
import { domainError, domainErrorWithDetails } from '../common/domain-error.js';
import type { Prisma } from '../generated/prisma/client.js';
import type { Principal } from '../identity/principal.js';

export type Db = Prisma.TransactionClient;

/**
 * Who sees what in Obchod (doc 034 §7): `sales:manage` sees every prospect; anyone else only the
 * prospects they own. Every read and write goes through this scope — never through a role name.
 */
export interface SalesScope {
  userId: string;
  all: boolean;
}

export const scopeOf = (p: Principal): SalesScope => ({
  userId: p.userId,
  all: p.permissions.has('sales:manage'),
});

/** SQL condition: the prospect alias `p` is visible in this scope. */
export const visibleTo = (scope: SalesScope): Prisma.SalesProspectWhereInput =>
  scope.all ? {} : { ownerId: scope.userId };

/**
 * The prospect by its code, or 404 — also when it exists but belongs to another salesperson, so
 * that neither the URL nor the API reveals it. `lock` takes the row lock that serialises writes.
 */
export async function visibleProspect(db: Db, code: string, scope: SalesScope, lock = false) {
  if (lock) {
    await db.$executeRaw`SELECT 1 FROM "sales_prospects" WHERE "code" = ${code} FOR UPDATE`;
  }
  const row = await db.salesProspect.findUnique({ where: { code } });
  if (!row || (!scope.all && row.ownerId !== scope.userId)) {
    throw new NotFoundException('Prospect not found');
  }
  return row;
}

/**
 * An archived prospect takes no new work — no edits, stage or owner changes, contacts, activities
 * or tasks — until it is restored (doc 034 §3a; also held by the database).
 */
export function assertActive(row: { archivedAt: Date | null }) {
  if (row.archivedAt) {
    throw domainError(
      409,
      'PROSPECT_ARCHIVED',
      'This prospect is archived; restore it before working on it',
    );
  }
}

/** A stale edit: the row moved on since the user loaded it (never silently overwritten). */
export function changed(code: string, what: string, revision: number) {
  return domainErrorWithDetails(
    409,
    code,
    `This ${what} was changed in the meantime; reload it and apply your change again`,
    { revision },
  );
}

/** Today (YYYY-MM-DD) in the sales time zone — never the device's or the server's zone. */
export function salesToday(now = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: SALES_TIME_ZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now);
}

export function addDays(iso: string, days: number): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

export const dateOnly = (d: Date) => d.toISOString().slice(0, 10);
export const asDate = (iso: string) => new Date(`${iso}T00:00:00Z`);

/** A wall-clock time of the sales time zone ("2026-10-20T14:30") as an instant (PostgreSQL). */
export async function salesInstant(db: Db, local: string): Promise<Date> {
  const rows = await db.$queryRaw<{ t: Date }[]>`
    SELECT (${local}::timestamp AT TIME ZONE ${SALES_TIME_ZONE}) AS "t"`;
  return rows[0]!.t;
}

/** Records one change in the append-only history (same transaction as the change). */
export function salesEvent(
  db: Db,
  e: {
    prospectId: string;
    type: string;
    actorId: string;
    requestId: string;
    contactId?: string | null;
    taskId?: string | null;
    payload: Record<string, unknown>;
  },
) {
  return db.salesEvent.create({
    data: {
      prospectId: e.prospectId,
      type: e.type,
      actorId: e.actorId,
      requestId: e.requestId,
      contactId: e.contactId ?? null,
      taskId: e.taskId ?? null,
      payload: e.payload as Prisma.InputJsonObject,
    },
  });
}
