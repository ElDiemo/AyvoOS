import {
  ACTIVITY_KINDS,
  IN_PROGRESS_STAGES,
  PROSPECT_STAGES,
  SALES_TIME_ZONE,
  type SalesResults,
  type SalesResultsQuery,
} from '@ayvo/types';
import { Injectable } from '@nestjs/common';
import { PrismaService } from '../database/prisma.service.js';
import { Prisma } from '../generated/prisma/client.js';
import { addDays, salesToday } from './sales-access.js';

const zero = <K extends string>(keys: readonly K[]) =>
  Object.fromEntries(keys.map((k) => [k, 0])) as Record<K, number>;

/**
 * "Výsledky obchodu" for the owner (sales:manage): everyone's prospects, read only from what
 * Obchod already records. Activities count in their current version only (a correction replaces
 * the activity it corrects; a withdrawn one never counts), on the day they happened.
 */
@Injectable()
export class SalesResultsService {
  constructor(private readonly prisma: PrismaService) {}

  async results(q: SalesResultsQuery): Promise<SalesResults> {
    const today = salesToday();
    const since = addDays(today, -(q.days - 1));
    // The period's start: midnight of `since` in the sales time zone.
    const from = Prisma.sql`(${since}::date::timestamp AT TIME ZONE ${SALES_TIME_ZONE})`;
    const inProgress = Prisma.join(IN_PROGRESS_STAGES.map((s) => Prisma.sql`${s}`));
    const current = Prisma.sql`NOT a."withdrawn" AND NOT EXISTS (
        SELECT 1 FROM "sales_activities" c WHERE c."corrects_id" = a."id")`;
    const noOpenTask = Prisma.sql`NOT EXISTS (SELECT 1 FROM "sales_tasks" t
        WHERE t."prospect_id" = p."id" AND t."status" = 'OPEN')`;

    const [funnel, reached, created, activities, totals, people] = await Promise.all([
      this.prisma.$queryRaw<{ stage: string; n: number }[]>`
        SELECT p."stage", count(*)::int AS "n" FROM "sales_prospects" p
         WHERE p."archived_at" IS NULL GROUP BY p."stage"`,
      this.prisma.$queryRaw<{ stage: string; n: number }[]>`
        SELECT e."payload"->>'to' AS "stage", count(DISTINCT e."prospect_id")::int AS "n"
          FROM "sales_events" e
         WHERE e."type" = 'STAGE_CHANGED' AND e."occurred_at" >= ${from}
         GROUP BY 1`,
      this.prisma.$queryRaw<{ n: number }[]>`
        SELECT count(*)::int AS "n" FROM "sales_prospects" p WHERE p."created_at" >= ${from}`,
      this.prisma.$queryRaw<{ kind: string; n: number }[]>`
        SELECT a."kind", count(*)::int AS "n" FROM "sales_activities" a
         WHERE ${current} AND a."occurred_at" >= ${from} GROUP BY a."kind"`,
      this.prisma.$queryRaw<{ missing: number; overdue: number }[]>`
        SELECT
          (SELECT count(*)::int FROM "sales_prospects" p
            WHERE p."archived_at" IS NULL AND p."stage" IN (${inProgress}) AND ${noOpenTask}) AS "missing",
          (SELECT count(*)::int FROM "sales_tasks" t JOIN "sales_prospects" p ON p."id" = t."prospect_id"
            WHERE t."status" = 'OPEN' AND p."archived_at" IS NULL AND t."due_on" < ${today}::date) AS "overdue"`,
      this.prisma.$queryRaw<
        {
          id: string;
          name: string;
          in_progress: number;
          missing: number;
          calls: number;
          meetings: number;
          offers: number;
          won: number;
        }[]
      >`
        SELECT u."id", u."display_name" AS "name",
          (SELECT count(*)::int FROM "sales_prospects" p WHERE p."owner_id" = u."id"
             AND p."archived_at" IS NULL AND p."stage" IN (${inProgress})) AS "in_progress",
          (SELECT count(*)::int FROM "sales_prospects" p WHERE p."owner_id" = u."id"
             AND p."archived_at" IS NULL AND p."stage" IN (${inProgress}) AND ${noOpenTask}) AS "missing",
          (SELECT count(*)::int FROM "sales_activities" a WHERE a."author_id" = u."id"
             AND ${current} AND a."occurred_at" >= ${from} AND a."kind" = 'CALL') AS "calls",
          (SELECT count(*)::int FROM "sales_activities" a WHERE a."author_id" = u."id"
             AND ${current} AND a."occurred_at" >= ${from} AND a."kind" = 'MEETING') AS "meetings",
          (SELECT count(*)::int FROM "sales_activities" a WHERE a."author_id" = u."id"
             AND ${current} AND a."occurred_at" >= ${from} AND a."kind" = 'OFFER') AS "offers",
          (SELECT count(DISTINCT e."prospect_id")::int FROM "sales_events" e
             JOIN "sales_prospects" p ON p."id" = e."prospect_id"
            WHERE p."owner_id" = u."id" AND e."type" = 'STAGE_CHANGED'
              AND e."payload"->>'to' = 'WON' AND e."occurred_at" >= ${from}) AS "won"
          FROM "users" u
         WHERE EXISTS (SELECT 1 FROM "sales_prospects" p WHERE p."owner_id" = u."id")
            OR EXISTS (SELECT 1 FROM "sales_activities" a WHERE a."author_id" = u."id"
                        AND a."occurred_at" >= ${from})
         ORDER BY u."display_name", u."email"`,
    ]);
    const byStage = (rows: { stage: string; n: number }[]) => {
      const out = zero(PROSPECT_STAGES);
      for (const r of rows)
        if ((PROSPECT_STAGES as readonly string[]).includes(r.stage))
          out[r.stage as (typeof PROSPECT_STAGES)[number]] = r.n;
      return out;
    };
    const kinds = zero(ACTIVITY_KINDS);
    for (const r of activities)
      if ((ACTIVITY_KINDS as readonly string[]).includes(r.kind))
        kinds[r.kind as (typeof ACTIVITY_KINDS)[number]] = r.n;
    return {
      days: q.days,
      since,
      today,
      funnel: byStage(funnel),
      reached: byStage(reached),
      created: created[0]!.n,
      activities: kinds,
      withoutNextStep: totals[0]!.missing,
      overdueTasks: totals[0]!.overdue,
      people: people.map((p) => ({
        id: p.id,
        name: p.name,
        inProgress: p.in_progress,
        withoutNextStep: p.missing,
        calls: p.calls,
        meetings: p.meetings,
        offers: p.offers,
        won: p.won,
      })),
    };
  }
}
