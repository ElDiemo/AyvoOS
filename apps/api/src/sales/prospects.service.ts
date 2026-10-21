import { ForbiddenException, Injectable } from '@nestjs/common';
import {
  CONTACT_ACTIVITY_KINDS,
  IN_PROGRESS_STAGES,
  PROSPECT_PAGE_SIZE,
  stageChangeNeedsReason,
  type ChangeOwnerRequest,
  type ChangeStageRequest,
  type CreateProspectRequest,
  type DuplicateHint,
  type DuplicateQuery,
  type ProspectDetail,
  type ProspectListQuery,
  type ProspectPage,
  type ProspectStage,
  type ProspectSummary,
  type SalesOverview,
  type Salesperson,
  type UpdateProspectRequest,
} from '@ayvo/types';
import { CODE_PREFIX, formatCode } from '../common/codes.js';
import { domainError, domainErrorWithDetails } from '../common/domain-error.js';
import { allocateSerials } from '../database/code-counters.js';
import { OperationRequestsService } from '../database/operation-requests.service.js';
import { PrismaService } from '../database/prisma.service.js';
import { Prisma } from '../generated/prisma/client.js';
import {
  addDays,
  changed,
  salesEvent,
  salesToday,
  visibleProspect,
  type Db,
  type SalesScope,
} from './sales-access.js';
import { emailKey, nameKey, phoneKey, websiteKey } from './sales-keys.js';
import { SalesViews } from './sales-views.js';

/** The profile fields of a prospect, compared and recorded field by field. */
const PROFILE_FIELDS = [
  'name',
  'countryCode',
  'city',
  'addressLine1',
  'addressLine2',
  'postalCode',
  'roomsEstimate',
  'accommodationType',
  'website',
  'source',
  'priority',
  'note',
] as const;
type ProfileField = (typeof PROFILE_FIELDS)[number];

/** The current versions of the contact activities of prospect `p` (not withdrawn, not corrected). */
const CONTACT_KINDS = Prisma.join(CONTACT_ACTIVITY_KINDS.map((k) => Prisma.sql`${k}`));
const lastContactSql = Prisma.sql`(
  SELECT max(a."occurred_at") FROM "sales_activities" a
  WHERE a."prospect_id" = p."id" AND NOT a."withdrawn" AND a."kind" IN (${CONTACT_KINDS})
    AND NOT EXISTS (SELECT 1 FROM "sales_activities" c WHERE c."corrects_id" = a."id"))`;

interface SummaryRow {
  code: string;
  name: string;
  country_code: string;
  city: string | null;
  stage: ProspectStage;
  priority: 'A' | 'B' | 'C' | null;
  rooms_estimate: number | null;
  owner_id: string;
  owner_name: string;
  last_contact: Date | null;
  next_id: string | null;
  next_title: string | null;
  next_due: Date | null;
  next_assignee: string | null;
  open_tasks: number;
  total: number;
}

const escapeLike = (s: string) => s.replace(/[\\%_]/g, (c) => `\\${c}`);

/**
 * Prospects of Obchod (doc 034): list, overview, detail, duplicates and the changes of the
 * prospect itself (profile, stage, owner). Contacts, activities and tasks: SalesWorkService.
 */
@Injectable()
export class ProspectsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly operations: OperationRequestsService,
    private readonly views: SalesViews,
  ) {}

  // --- reading -------------------------------------------------------------------------------

  /** The visible prospects with their next open task; stable order (next task, name, code). */
  async list(scope: SalesScope, q: ProspectListQuery): Promise<ProspectPage> {
    const today = salesToday();
    const where: Prisma.Sql[] = [];
    // Without sales:manage only one's own prospects, whatever the query says.
    if (!scope.all || q.owner === 'me')
      where.push(Prisma.sql`p."owner_id" = ${scope.userId}::uuid`);
    else if (q.owner) where.push(Prisma.sql`p."owner_id" = ${q.owner}::uuid`);
    if (q.stage) where.push(Prisma.sql`p."stage" = ${q.stage}`);
    if (q.priority) where.push(Prisma.sql`p."priority" = ${q.priority}`);
    if (q.country) where.push(Prisma.sql`p."country_code" = ${q.country}`);
    if (q.next === 'overdue') where.push(Prisma.sql`n."due_on" < ${today}::date`);
    if (q.next === 'today') where.push(Prisma.sql`n."due_on" = ${today}::date`);
    if (q.next === 'week') {
      where.push(
        Prisma.sql`n."due_on" > ${today}::date AND n."due_on" <= ${addDays(today, 7)}::date`,
      );
    }
    if (q.next === 'none') where.push(Prisma.sql`n."id" IS NULL`);
    if (q.q) {
      const like = `%${escapeLike(q.q)}%`;
      const key = nameKey(q.q);
      const digits = q.q.replace(/\D/g, '');
      where.push(Prisma.sql`(
        p."name" ILIKE ${like} OR p."city" ILIKE ${like} OR p."code" ILIKE ${like}
        OR (${key} <> '' AND p."name_key" LIKE ${`%${escapeLike(key)}%`})
        OR EXISTS (SELECT 1 FROM "sales_contacts" c WHERE c."prospect_id" = p."id"
          AND (c."label" ILIKE ${like} OR c."email" ILIKE ${like}
               OR (length(${digits}) >= 4 AND c."phone_key" LIKE ${`%${digits.slice(-9)}%`}))))`);
    }
    const page = q.page;
    const rows = await this.summaries(where, PROSPECT_PAGE_SIZE, (page - 1) * PROSPECT_PAGE_SIZE);
    return {
      items: rows.map(toSummary),
      total: rows[0]?.total ?? (page > 1 ? await this.count(where) : 0),
      page,
      pageSize: PROSPECT_PAGE_SIZE,
      today,
    };
  }

  private summaries(where: Prisma.Sql[], limit: number, offset: number, order?: Prisma.Sql) {
    const cond = where.length ? Prisma.sql`WHERE ${Prisma.join(where, ' AND ')}` : Prisma.empty;
    return this.prisma.$queryRaw<SummaryRow[]>`
      WITH "next" AS (
        SELECT DISTINCT ON (t."prospect_id") t."prospect_id", t."id", t."title", t."due_on", t."assignee_id"
        FROM "sales_tasks" t WHERE t."status" = 'OPEN'
        ORDER BY t."prospect_id", t."due_on", t."created_at", t."id")
      SELECT p."code", p."name", p."country_code", p."city", p."stage", p."priority",
             p."rooms_estimate", p."owner_id", o."display_name" AS "owner_name",
             ${lastContactSql} AS "last_contact",
             n."id" AS "next_id", n."title" AS "next_title", n."due_on" AS "next_due",
             nu."display_name" AS "next_assignee",
             (SELECT count(*) FROM "sales_tasks" t WHERE t."prospect_id" = p."id" AND t."status" = 'OPEN')::int AS "open_tasks",
             count(*) OVER ()::int AS "total"
      FROM "sales_prospects" p
      JOIN "users" o ON o."id" = p."owner_id"
      LEFT JOIN "next" n ON n."prospect_id" = p."id"
      LEFT JOIN "users" nu ON nu."id" = n."assignee_id"
      ${cond}
      ORDER BY ${order ?? Prisma.sql`n."due_on" ASC NULLS LAST, p."name" ASC, p."code" ASC`}
      LIMIT ${limit} OFFSET ${offset}`;
  }

  private async count(where: Prisma.Sql[]): Promise<number> {
    const cond = where.length ? Prisma.sql`WHERE ${Prisma.join(where, ' AND ')}` : Prisma.empty;
    const rows = await this.prisma.$queryRaw<{ n: number }[]>`
      WITH "next" AS (
        SELECT DISTINCT ON (t."prospect_id") t."prospect_id", t."id", t."due_on"
        FROM "sales_tasks" t WHERE t."status" = 'OPEN'
        ORDER BY t."prospect_id", t."due_on", t."created_at", t."id")
      SELECT count(*)::int AS "n" FROM "sales_prospects" p
      LEFT JOIN "next" n ON n."prospect_id" = p."id" ${cond}`;
    return rows[0]!.n;
  }

  /** The salesperson's working overview: tasks today / overdue / next 7 days, work in progress. */
  async overview(scope: SalesScope, wantAll: boolean): Promise<SalesOverview> {
    const all = scope.all && wantAll;
    const today = salesToday();
    const mine: Prisma.SalesTaskWhereInput = all
      ? { status: 'OPEN' }
      : // My tasks on prospects I may see (an owner change moves them with the prospect).
        {
          status: 'OPEN',
          assigneeId: scope.userId,
          prospect: scope.all ? {} : { ownerId: scope.userId },
        };
    const due = (dueOn: Prisma.DateTimeFilter) => ({ ...mine, dueOn });
    const d = (iso: string) => new Date(`${iso}T00:00:00Z`);
    const [overdue, dueToday, upcoming, counts] = await Promise.all([
      this.views.tasks(due({ lt: d(today) }), 50),
      this.views.tasks(due({ equals: d(today) }), 50),
      this.views.tasks(due({ gt: d(today), lte: d(addDays(today, 7)) }), 50),
      Promise.all([
        this.prisma.salesTask.count({ where: due({ lt: d(today) }) }),
        this.prisma.salesTask.count({ where: due({ equals: d(today) }) }),
        this.prisma.salesTask.count({ where: due({ gt: d(today), lte: d(addDays(today, 7)) }) }),
      ]),
    ]);
    const where = [
      Prisma.sql`p."stage" IN (${Prisma.join(IN_PROGRESS_STAGES.map((s) => Prisma.sql`${s}`))})`,
    ];
    if (!all) where.push(Prisma.sql`p."owner_id" = ${scope.userId}::uuid`);
    // Without a next step first: nobody knows what happens next with those.
    const inProgress = await this.summaries(
      where,
      20,
      0,
      Prisma.sql`(n."id" IS NULL) DESC, n."due_on" ASC NULLS LAST, p."name" ASC, p."code" ASC`,
    );
    const withoutNextStep = await this.count([...where, Prisma.sql`n."id" IS NULL`]);
    return {
      today,
      scope: all ? 'all' : 'me',
      overdue,
      dueToday,
      upcoming,
      inProgress: inProgress.map(toSummary),
      counts: {
        overdue: counts[0],
        dueToday: counts[1],
        upcoming: counts[2],
        inProgress: inProgress[0]?.total ?? 0,
        withoutNextStep,
      },
    };
  }

  async detail(scope: SalesScope, code: string): Promise<ProspectDetail> {
    const row = await visibleProspect(this.prisma, code, scope);
    const detail = await this.views.detail(row.id);
    const contacts = detail.contacts.filter((c) => !c.retired);
    const duplicates = await this.duplicates(scope, {
      name: row.name,
      countryCode: row.countryCode,
      website: row.website ?? undefined,
      emails: contacts.map((c) => c.email).filter((e): e is string => !!e),
      phones: contacts.map((c) => c.phone).filter((p): p is string => !!p),
      exclude: row.id,
    });
    return { ...detail, duplicates };
  }

  /** "Možná duplicita" while typing: only what the user may see, the rest as a count. */
  async checkDuplicates(scope: SalesScope, q: DuplicateQuery): Promise<DuplicateHint> {
    let exclude: string | undefined;
    if (q.exclude) exclude = (await visibleProspect(this.prisma, q.exclude, scope)).id;
    return this.duplicates(scope, {
      name: q.name,
      countryCode: q.countryCode,
      website: q.website,
      emails: q.email ? [q.email] : [],
      phones: q.phone ? [q.phone] : [],
      exclude,
    });
  }

  private async duplicates(
    scope: SalesScope,
    c: {
      name?: string;
      countryCode?: string;
      website?: string;
      emails: string[];
      phones: string[];
      exclude?: string;
    },
    db: Db = this.prisma,
  ): Promise<DuplicateHint> {
    const name = c.name?.trim() ? nameKey(c.name) : null;
    const site = websiteKey(c.website ?? null);
    const emails = c.emails.map(emailKey).filter((e): e is string => !!e);
    const phones = c.phones.map(phoneKey).filter((p): p is string => !!p);
    if (!name && !site && !emails.length && !phones.length) return { accessible: [], hidden: 0 };
    const none = Prisma.sql`NULL`;
    const rows = await db.$queryRaw<
      {
        code: string;
        name: string;
        city: string | null;
        owner_id: string;
        owner: string;
        by_name: boolean;
        by_site: boolean;
        by_email: boolean;
        by_phone: boolean;
      }[]
    >`
      SELECT * FROM (
        SELECT p."code", p."name", p."city", p."owner_id", o."display_name" AS "owner",
          (${name}::text IS NOT NULL AND p."name_key" = ${name} AND p."country_code" = ${c.countryCode ?? null}) AS "by_name",
          (${site}::text IS NOT NULL AND p."website_key" = ${site}) AS "by_site",
          EXISTS (SELECT 1 FROM "sales_contacts" x WHERE x."prospect_id" = p."id" AND x."retired_at" IS NULL
                  AND x."email_key" = ANY(${emails.length ? emails : none}::text[])) AS "by_email",
          EXISTS (SELECT 1 FROM "sales_contacts" x WHERE x."prospect_id" = p."id" AND x."retired_at" IS NULL
                  AND x."phone_key" = ANY(${phones.length ? phones : none}::text[])) AS "by_phone"
        FROM "sales_prospects" p JOIN "users" o ON o."id" = p."owner_id"
        WHERE p."id" IS DISTINCT FROM ${c.exclude ?? null}::uuid) d
      WHERE "by_name" OR "by_site" OR "by_email" OR "by_phone"
      ORDER BY "code"
      LIMIT 50`;
    const visible = rows.filter((r) => scope.all || r.owner_id === scope.userId);
    return {
      accessible: visible.map((r) => ({
        code: r.code,
        name: r.name,
        city: r.city,
        owner: r.owner,
        reasons: [
          ...(r.by_name ? (['NAME'] as const) : []),
          ...(r.by_site ? (['WEBSITE'] as const) : []),
          ...(r.by_email ? (['EMAIL'] as const) : []),
          ...(r.by_phone ? (['PHONE'] as const) : []),
        ],
      })),
      // Another salesperson's prospects: never a name, city or contact — only how many.
      hidden: rows.length - visible.length,
    };
  }

  /** People who can own prospects (active, holding sales:work) — for ADMIN's assignment. */
  salespeople(): Promise<Salesperson[]> {
    return this.prisma.$queryRaw<Salesperson[]>`
      SELECT u."id", u."display_name" AS "name", u."email" FROM "users" u
      WHERE u."status" = 'ACTIVE' AND EXISTS (
        SELECT 1 FROM "user_roles" ur
        JOIN "roles" r ON r."code" = ur."role_code" AND r."active"
        JOIN "role_permissions" rp ON rp."role_code" = r."code" AND rp."permission_code" = 'sales:work'
        WHERE ur."user_id" = u."id" AND ur."revoked_at" IS NULL)
      ORDER BY u."display_name", u."email"`;
  }

  // --- changes -------------------------------------------------------------------------------

  async create(scope: SalesScope, input: CreateProspectRequest): Promise<{ code: string }> {
    if (input.ownerId && input.ownerId !== scope.userId && !scope.all) {
      throw new ForbiddenException('Only an administrator assigns prospects to other people');
    }
    const ownerId = input.ownerId ?? scope.userId;
    const { result } = await this.operations.run(
      'SALES_PROSPECT_CREATE',
      input.requestId,
      { actorId: scope.userId, ...input, requestId: undefined },
      async (tx) => {
        if (ownerId !== scope.userId) await this.assertSalesperson(tx, ownerId);
        if (!input.acknowledgeDuplicates) {
          const hint = await this.duplicates(
            scope,
            {
              name: input.name,
              countryCode: input.countryCode,
              website: input.website ?? undefined,
              emails: input.contact?.email ? [input.contact.email] : [],
              phones: input.contact?.phone ? [input.contact.phone] : [],
            },
            tx,
          );
          if (hint.accessible.length || hint.hidden) {
            throw domainErrorWithDetails(
              409,
              'POSSIBLE_DUPLICATE',
              'A similar prospect exists; confirm to create this one anyway',
              hint,
            );
          }
        }
        const { first: serial } = await allocateSerials(tx, 'sales_prospect', 1);
        const prospect = await tx.salesProspect.create({
          data: {
            serial,
            code: formatCode(CODE_PREFIX.salesProspect, serial),
            ...profileData(input),
            ownerId,
            createdBy: scope.userId,
            updatedBy: scope.userId,
          },
        });
        await salesEvent(tx, {
          prospectId: prospect.id,
          type: 'PROSPECT_CREATED',
          actorId: scope.userId,
          requestId: input.requestId,
          payload: { name: prospect.name, ownerId, stage: prospect.stage },
        });
        if (input.contact) {
          const contact = await tx.salesContact.create({
            data: {
              prospectId: prospect.id,
              ...contactData(input.contact),
              createdBy: scope.userId,
              updatedBy: scope.userId,
            },
          });
          await salesEvent(tx, {
            prospectId: prospect.id,
            type: 'CONTACT_ADDED',
            actorId: scope.userId,
            requestId: input.requestId,
            contactId: contact.id,
            payload: { label: contact.label },
          });
        }
        return { code: prospect.code };
      },
    );
    return result;
  }

  async update(scope: SalesScope, code: string, input: UpdateProspectRequest) {
    await this.operations.run(
      'SALES_PROSPECT_UPDATE',
      input.requestId,
      { actorId: scope.userId, code, ...input, requestId: undefined },
      async (tx) => {
        const row = await visibleProspect(tx, code, scope, true);
        if (row.revision !== input.revision) {
          throw changed('PROSPECT_CHANGED', 'prospect', row.revision);
        }
        const next = profileData(input);
        const changes: Record<string, { before: unknown; after: unknown }> = {};
        for (const f of PROFILE_FIELDS) {
          const before = row[f as ProfileField];
          const after = next[f as ProfileField];
          if (before !== after) changes[f] = { before, after };
        }
        if (!Object.keys(changes).length) {
          throw domainError(422, 'PROSPECT_UNCHANGED', 'Nothing was changed');
        }
        await tx.salesProspect.update({
          where: { id: row.id },
          data: {
            ...next,
            revision: row.revision + 1,
            updatedAt: new Date(),
            updatedBy: scope.userId,
          },
        });
        await salesEvent(tx, {
          prospectId: row.id,
          type: 'PROSPECT_UPDATED',
          actorId: scope.userId,
          requestId: input.requestId,
          payload: { changes },
        });
        return { code };
      },
    );
    return this.detail(scope, code);
  }

  async changeStage(scope: SalesScope, code: string, input: ChangeStageRequest) {
    await this.operations.run(
      'SALES_STAGE_CHANGE',
      input.requestId,
      { actorId: scope.userId, code, ...input, requestId: undefined },
      async (tx) => {
        const row = await visibleProspect(tx, code, scope, true);
        if (row.revision !== input.revision) {
          throw changed('PROSPECT_CHANGED', 'prospect', row.revision);
        }
        const from = row.stage as ProspectStage;
        if (from === input.stage) {
          throw domainError(422, 'STAGE_UNCHANGED', 'The prospect is already in this stage');
        }
        if (stageChangeNeedsReason(from, input.stage) && !input.reason) {
          throw domainError(
            422,
            'STAGE_REASON_REQUIRED',
            'Going back or reopening a result needs a reason',
          );
        }
        if ((input.stage === 'LOST') !== (input.lostReason !== null)) {
          throw domainError(
            422,
            'LOST_REASON_REQUIRED',
            'A lost prospect needs the reason why (and only a lost one has it)',
          );
        }
        await tx.salesProspect.update({
          where: { id: row.id },
          data: {
            stage: input.stage,
            lostReason: input.lostReason,
            revision: row.revision + 1,
            updatedAt: new Date(),
            updatedBy: scope.userId,
          },
        });
        await salesEvent(tx, {
          prospectId: row.id,
          type: 'STAGE_CHANGED',
          actorId: scope.userId,
          requestId: input.requestId,
          payload: {
            from,
            to: input.stage,
            reason: input.reason,
            lostReason: input.lostReason,
            previousLostReason: row.lostReason,
          },
        });
        return { code };
      },
    );
    return this.detail(scope, code);
  }

  /** ADMIN's (sales:manage) assignment; the previous owner's open tasks move with the prospect. */
  async changeOwner(scope: SalesScope, code: string, input: ChangeOwnerRequest) {
    await this.operations.run(
      'SALES_OWNER_CHANGE',
      input.requestId,
      { actorId: scope.userId, code, ...input, requestId: undefined },
      async (tx) => {
        const row = await visibleProspect(tx, code, scope, true);
        if (row.revision !== input.revision) {
          throw changed('PROSPECT_CHANGED', 'prospect', row.revision);
        }
        if (row.ownerId === input.ownerId) {
          throw domainError(422, 'OWNER_UNCHANGED', 'This person already owns the prospect');
        }
        const owner = await this.assertSalesperson(tx, input.ownerId);
        const previous = await tx.user.findUniqueOrThrow({
          where: { id: row.ownerId },
          select: { id: true, displayName: true },
        });
        await tx.salesProspect.update({
          where: { id: row.id },
          data: {
            ownerId: input.ownerId,
            revision: row.revision + 1,
            updatedAt: new Date(),
            updatedBy: scope.userId,
          },
        });
        const moved = await tx.salesTask.findMany({
          where: { prospectId: row.id, status: 'OPEN', assigneeId: row.ownerId },
        });
        for (const t of moved) {
          await tx.salesTask.update({
            where: { id: t.id },
            data: {
              assigneeId: input.ownerId,
              revision: t.revision + 1,
              updatedAt: new Date(),
              updatedBy: scope.userId,
            },
          });
          await salesEvent(tx, {
            prospectId: row.id,
            type: 'TASK_UPDATED',
            actorId: scope.userId,
            requestId: input.requestId,
            taskId: t.id,
            payload: {
              title: t.title,
              cause: 'OWNER_CHANGED',
              changes: {
                assignee: { before: previous.displayName, after: owner.displayName },
              },
            },
          });
        }
        await salesEvent(tx, {
          prospectId: row.id,
          type: 'OWNER_CHANGED',
          actorId: scope.userId,
          requestId: input.requestId,
          payload: {
            from: { id: previous.id, name: previous.displayName },
            to: { id: owner.id, name: owner.displayName },
            reason: input.reason,
            movedTasks: moved.length,
          },
        });
        return { code };
      },
    );
    return this.detail(scope, code);
  }

  /** An active user holding sales:work (the only people who can own prospects). */
  async assertSalesperson(db: Db, userId: string) {
    const rows = await db.$queryRaw<{ id: string; displayName: string }[]>`
      SELECT u."id", u."display_name" AS "displayName" FROM "users" u
      WHERE u."id" = ${userId}::uuid AND u."status" = 'ACTIVE' AND EXISTS (
        SELECT 1 FROM "user_roles" ur
        JOIN "roles" r ON r."code" = ur."role_code" AND r."active"
        JOIN "role_permissions" rp ON rp."role_code" = r."code" AND rp."permission_code" = 'sales:work'
        WHERE ur."user_id" = u."id" AND ur."revoked_at" IS NULL)`;
    if (!rows[0]) {
      throw domainError(
        422,
        'NOT_A_SALESPERSON',
        'This person cannot own prospects (an active user with the Obchod permission is needed)',
      );
    }
    return rows[0];
  }
}

function profileData(input: Pick<CreateProspectRequest, ProfileField>) {
  return {
    name: input.name,
    nameKey: nameKey(input.name),
    countryCode: input.countryCode,
    city: input.city,
    addressLine1: input.addressLine1,
    addressLine2: input.addressLine2,
    postalCode: input.postalCode,
    roomsEstimate: input.roomsEstimate,
    accommodationType: input.accommodationType,
    website: input.website,
    websiteKey: websiteKey(input.website),
    source: input.source,
    priority: input.priority,
    note: input.note,
  };
}

export function contactData(c: {
  label: string;
  position: string | null;
  email: string | null;
  phone: string | null;
  note: string | null;
  isPrimary: boolean;
}) {
  return {
    label: c.label,
    position: c.position,
    email: c.email,
    emailKey: emailKey(c.email),
    phone: c.phone,
    phoneKey: phoneKey(c.phone),
    note: c.note,
    isPrimary: c.isPrimary,
  };
}

function toSummary(r: SummaryRow): ProspectSummary {
  return {
    code: r.code,
    name: r.name,
    countryCode: r.country_code,
    city: r.city,
    stage: r.stage,
    priority: r.priority,
    roomsEstimate: r.rooms_estimate,
    owner: { id: r.owner_id, name: r.owner_name },
    lastContactAt: r.last_contact?.toISOString() ?? null,
    nextTask:
      r.next_id && r.next_title && r.next_due
        ? {
            id: r.next_id,
            title: r.next_title,
            dueOn: r.next_due.toISOString().slice(0, 10),
            assignee: r.next_assignee ?? '',
          }
        : null,
    openTasks: r.open_tasks,
  };
}
