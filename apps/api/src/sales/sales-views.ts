import { Injectable } from '@nestjs/common';
import {
  CONTACT_ACTIVITY_KINDS,
  type ActivityKind,
  type ProspectDetail,
  type SalesActivity,
  type SalesEvent,
  type SalesTask,
} from '@ayvo/types';
import { PrismaService } from '../database/prisma.service.js';
import type { Prisma } from '../generated/prisma/client.js';
import { dateOnly, salesToday, type Db } from './sales-access.js';

const taskInclude = {
  prospect: { select: { code: true, name: true } },
  assignee: { select: { id: true, displayName: true } },
  contact: { select: { id: true, label: true } },
  creator: { select: { displayName: true } },
  closer: { select: { displayName: true } },
} satisfies Prisma.SalesTaskInclude;
type TaskRow = Prisma.SalesTaskGetPayload<{ include: typeof taskInclude }>;

const activityInclude = {
  author: { select: { displayName: true } },
  contact: { select: { id: true, label: true } },
} satisfies Prisma.SalesActivityInclude;
type ActivityRow = Prisma.SalesActivityGetPayload<{ include: typeof activityInclude }>;

/** Read models of Obchod (doc 034 §9). Visibility is checked by the callers. */
@Injectable()
export class SalesViews {
  constructor(private readonly prisma: PrismaService) {}

  async tasks(where: Prisma.SalesTaskWhereInput, take: number, skip = 0, closed = false) {
    const rows = await this.prisma.salesTask.findMany({
      where,
      include: taskInclude,
      orderBy: closed
        ? [{ closedAt: 'desc' }, { id: 'asc' }]
        : [{ dueOn: 'asc' }, { createdAt: 'asc' }, { id: 'asc' }],
      take,
      skip,
    });
    return rows.map(toTask);
  }

  /** The detail of a prospect, read with `db` (the caller's snapshot, after its access check). */
  async detail(
    prospectId: string,
    db: Db = this.prisma,
  ): Promise<Omit<ProspectDetail, 'duplicates'>> {
    const p = await db.salesProspect.findUniqueOrThrow({
      where: { id: prospectId },
      include: {
        owner: { select: { id: true, displayName: true } },
        creator: { select: { displayName: true } },
        archiver: { select: { displayName: true } },
        contacts: {
          include: { retirer: { select: { displayName: true } } },
          orderBy: [{ isPrimary: 'desc' }, { createdAt: 'asc' }, { id: 'asc' }],
        },
        tasks: { include: taskInclude },
        activities: { include: activityInclude },
        events: {
          include: { actor: { select: { displayName: true } } },
          orderBy: [{ occurredAt: 'desc' }, { id: 'desc' }],
        },
      },
    });
    const activities = currentActivities(p.activities);
    const contactTimes = activities
      .filter((a) => !a.withdrawn && CONTACT_ACTIVITY_KINDS.includes(a.kind))
      .map((a) => a.occurredAt)
      .sort();
    const open = p.tasks
      .filter((t) => t.status === 'OPEN')
      .sort((a, b) => +a.dueOn - +b.dueOn || +a.createdAt - +b.createdAt);
    const closed = p.tasks
      .filter((t) => t.status !== 'OPEN')
      .sort((a, b) => +(b.closedAt ?? 0) - +(a.closedAt ?? 0));
    return {
      code: p.code,
      name: p.name,
      countryCode: p.countryCode,
      city: p.city,
      addressLine1: p.addressLine1,
      addressLine2: p.addressLine2,
      postalCode: p.postalCode,
      roomsEstimate: p.roomsEstimate,
      accommodationType: p.accommodationType as ProspectDetail['accommodationType'],
      website: p.website,
      source: p.source,
      priority: p.priority as ProspectDetail['priority'],
      stage: p.stage as ProspectDetail['stage'],
      lostReason: p.lostReason,
      note: p.note,
      owner: { id: p.owner.id, name: p.owner.displayName },
      revision: p.revision,
      archived:
        p.archivedAt && p.archiveReason
          ? {
              at: p.archivedAt.toISOString(),
              by: p.archiver?.displayName ?? '',
              reason: p.archiveReason,
            }
          : null,
      createdAt: p.createdAt.toISOString(),
      createdBy: p.creator.displayName,
      firstContactAt: contactTimes[0] ?? null,
      lastContactAt: contactTimes.at(-1) ?? null,
      contacts: p.contacts.map((c) => ({
        id: c.id,
        label: c.label,
        position: c.position,
        email: c.email,
        phone: c.phone,
        note: c.note,
        isPrimary: c.isPrimary,
        revision: c.revision,
        retired:
          c.retiredAt && c.retireReason
            ? {
                at: c.retiredAt.toISOString(),
                by: c.retirer?.displayName ?? '',
                reason: c.retireReason,
              }
            : null,
      })),
      openTasks: open.map(toTask),
      closedTasks: closed.map(toTask),
      activities,
      events: p.events.map((e): SalesEvent => ({
        id: e.id,
        type: e.type as SalesEvent['type'],
        occurredAt: e.occurredAt.toISOString(),
        actor: e.actor.displayName,
        payload: e.payload as Record<string, unknown>,
      })),
      today: salesToday(),
    };
  }
}

/**
 * The current version of every activity, newest event first, each with its earlier versions
 * (oldest first). A withdrawal is the current version of a withdrawn activity.
 */
function currentActivities(rows: ActivityRow[]): SalesActivity[] {
  const byId = new Map(rows.map((r) => [r.id, r]));
  const corrected = new Set(rows.map((r) => r.correctsId).filter(Boolean));
  return rows
    .filter((r) => !corrected.has(r.id))
    .map((r) => {
      const earlier: ActivityRow[] = [];
      let prev = r.correctsId ? byId.get(r.correctsId) : undefined;
      while (prev) {
        earlier.unshift(prev);
        prev = prev.correctsId ? byId.get(prev.correctsId) : undefined;
      }
      // A withdrawal keeps showing what was withdrawn (its last real version).
      const shown = r.withdrawn ? (earlier.at(-1) ?? r) : r;
      return {
        ...version(r),
        kind: shown.kind as ActivityKind,
        occurredAt: shown.occurredAt.toISOString(),
        contact: shown.contact ? { id: shown.contact.id, label: shown.contact.label } : null,
        earlier: earlier.map(version),
      };
    })
    .sort((a, b) => (a.occurredAt < b.occurredAt ? 1 : a.occurredAt > b.occurredAt ? -1 : 0));
}

function version(r: ActivityRow) {
  return {
    id: r.id,
    kind: r.kind as ActivityKind,
    occurredAt: r.occurredAt.toISOString(),
    recordedAt: r.recordedAt.toISOString(),
    author: r.author.displayName,
    contact: r.contact ? { id: r.contact.id, label: r.contact.label } : null,
    content: r.content,
    outcome: r.outcome,
    withdrawn: r.withdrawn,
    correctionReason: r.correctionReason,
  };
}

export function toTask(t: TaskRow): SalesTask {
  return {
    id: t.id,
    prospect: t.prospect,
    title: t.title,
    note: t.note,
    dueOn: dateOnly(t.dueOn),
    status: t.status as SalesTask['status'],
    result: t.result,
    assignee: { id: t.assignee.id, name: t.assignee.displayName },
    contact: t.contact,
    revision: t.revision,
    createdAt: t.createdAt.toISOString(),
    createdBy: t.creator.displayName,
    closedAt: t.closedAt?.toISOString() ?? null,
    closedBy: t.closer?.displayName ?? null,
  };
}

export { taskInclude };
