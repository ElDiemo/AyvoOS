import { ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import type {
  CancelTaskRequest,
  CompleteTaskRequest,
  CorrectActivityRequest,
  CreateTaskRequest,
  ProspectDetail,
  RecordActivityRequest,
  RescheduleTaskRequest,
  RetireContactRequest,
  SaveContactRequest,
  TaskListQuery,
  TaskPage,
  UpdateTaskRequest,
} from '@ayvo/types';
import { domainError } from '../common/domain-error.js';
import { OperationRequestsService } from '../database/operation-requests.service.js';
import { PrismaService } from '../database/prisma.service.js';
import type { Prisma } from '../generated/prisma/client.js';
import { contactData, ProspectsService } from './prospects.service.js';
import {
  asDate,
  changed,
  dateOnly,
  salesEvent,
  salesInstant,
  salesToday,
  visibleProspect,
  type Db,
  type SalesScope,
} from './sales-access.js';
import { SalesViews } from './sales-views.js';

const TASK_PAGE_SIZE = 50;
const CONTACT_FIELDS = ['label', 'position', 'email', 'phone', 'note', 'isPrimary'] as const;

/**
 * The work on a prospect (doc 034 §5–6): contacts, activities (append-only, corrected by new
 * versions) and tasks. Every write checks that the user may see the prospect, under its row lock.
 * Nothing here changes the stage — not even completing a task or recording an offer.
 */
@Injectable()
export class SalesWorkService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly operations: OperationRequestsService,
    private readonly prospects: ProspectsService,
    private readonly views: SalesViews,
  ) {}

  // --- contacts ------------------------------------------------------------------------------

  async saveContact(
    scope: SalesScope,
    code: string,
    contactId: string | null,
    input: SaveContactRequest,
  ): Promise<ProspectDetail> {
    await this.operations.run(
      'SALES_CONTACT_SAVE',
      input.requestId,
      { actorId: scope.userId, code, contactId, ...input, requestId: undefined },
      async (tx) => {
        const p = await visibleProspect(tx, code, scope, true);
        const data = contactData(input);
        let id = contactId;
        if (id === null) {
          if (input.revision !== null)
            throw domainError(422, 'INVALID', 'A new contact has no revision');
          if (data.isPrimary) await this.unsetPrimary(tx, p.id, null, scope, input.requestId);
          const c = await tx.salesContact.create({
            data: { prospectId: p.id, ...data, createdBy: scope.userId, updatedBy: scope.userId },
          });
          id = c.id;
          await salesEvent(tx, {
            prospectId: p.id,
            type: 'CONTACT_ADDED',
            actorId: scope.userId,
            requestId: input.requestId,
            contactId: c.id,
            payload: { label: c.label },
          });
        } else {
          const c = await this.lockContact(tx, p.id, id);
          if (c.retiredAt) throw domainError(422, 'CONTACT_RETIRED', 'This contact is retired');
          if (c.revision !== input.revision)
            throw changed('CONTACT_CHANGED', 'contact', c.revision);
          const changes: Record<string, { before: unknown; after: unknown }> = {};
          for (const f of CONTACT_FIELDS) {
            if (c[f] !== data[f]) changes[f] = { before: c[f], after: data[f] };
          }
          if (!Object.keys(changes).length) {
            throw domainError(422, 'CONTACT_UNCHANGED', 'Nothing was changed');
          }
          if (data.isPrimary && !c.isPrimary) {
            await this.unsetPrimary(tx, p.id, c.id, scope, input.requestId);
          }
          await tx.salesContact.update({
            where: { id: c.id },
            data: {
              ...data,
              revision: c.revision + 1,
              updatedAt: new Date(),
              updatedBy: scope.userId,
            },
          });
          await salesEvent(tx, {
            prospectId: p.id,
            type: 'CONTACT_UPDATED',
            actorId: scope.userId,
            requestId: input.requestId,
            contactId: c.id,
            payload: { label: data.label, changes },
          });
        }
        return { id };
      },
    );
    return this.prospects.detail(scope, code);
  }

  /** One main contact: the previous one stops being main (recorded as its change). */
  private async unsetPrimary(
    tx: Db,
    prospectId: string,
    except: string | null,
    scope: SalesScope,
    requestId: string,
  ) {
    const current = await tx.salesContact.findFirst({
      where: {
        prospectId,
        isPrimary: true,
        retiredAt: null,
        id: except ? { not: except } : undefined,
      },
    });
    if (!current) return;
    await tx.salesContact.update({
      where: { id: current.id },
      data: {
        isPrimary: false,
        revision: current.revision + 1,
        updatedAt: new Date(),
        updatedBy: scope.userId,
      },
    });
    await salesEvent(tx, {
      prospectId,
      type: 'CONTACT_UPDATED',
      actorId: scope.userId,
      requestId,
      contactId: current.id,
      payload: { label: current.label, changes: { isPrimary: { before: true, after: false } } },
    });
  }

  async retireContact(
    scope: SalesScope,
    code: string,
    contactId: string,
    input: RetireContactRequest,
  ): Promise<ProspectDetail> {
    await this.operations.run(
      'SALES_CONTACT_SAVE',
      input.requestId,
      { actorId: scope.userId, code, contactId, retire: true, ...input, requestId: undefined },
      async (tx) => {
        const p = await visibleProspect(tx, code, scope, true);
        const c = await this.lockContact(tx, p.id, contactId);
        if (c.retiredAt) throw domainError(422, 'CONTACT_RETIRED', 'This contact is retired');
        if (c.revision !== input.revision) throw changed('CONTACT_CHANGED', 'contact', c.revision);
        await tx.salesContact.update({
          where: { id: c.id },
          data: {
            isPrimary: false,
            retiredAt: new Date(),
            retiredBy: scope.userId,
            retireReason: input.reason,
            revision: c.revision + 1,
            updatedAt: new Date(),
            updatedBy: scope.userId,
          },
        });
        await salesEvent(tx, {
          prospectId: p.id,
          type: 'CONTACT_RETIRED',
          actorId: scope.userId,
          requestId: input.requestId,
          contactId: c.id,
          payload: { label: c.label, reason: input.reason },
        });
        return { id: c.id };
      },
    );
    return this.prospects.detail(scope, code);
  }

  private async lockContact(tx: Db, prospectId: string, id: string) {
    await tx.$executeRaw`SELECT 1 FROM "sales_contacts" WHERE "id" = ${id}::uuid FOR UPDATE`;
    const c = await tx.salesContact.findFirst({ where: { id, prospectId } });
    if (!c) throw new NotFoundException('Contact not found');
    return c;
  }

  /** A contact of this prospect that may be used for new work (not retired). */
  private async activeContact(tx: Db, prospectId: string, id: string | null) {
    if (!id) return null;
    const c = await tx.salesContact.findFirst({ where: { id, prospectId } });
    if (!c) throw new NotFoundException('Contact not found');
    if (c.retiredAt) throw domainError(422, 'CONTACT_RETIRED', 'This contact is retired');
    return c;
  }

  // --- activities ----------------------------------------------------------------------------

  /** "Zapsat aktivitu": what really happened and when — optionally with the next task. */
  async recordActivity(
    scope: SalesScope,
    code: string,
    input: RecordActivityRequest,
  ): Promise<ProspectDetail> {
    await this.operations.run(
      'SALES_ACTIVITY_RECORD',
      input.requestId,
      { actorId: scope.userId, code, ...input, requestId: undefined },
      async (tx) => {
        const p = await visibleProspect(tx, code, scope, true);
        await this.activeContact(tx, p.id, input.contactId);
        const occurredAt = await this.pastInstant(tx, input.occurredAt);
        const a = await tx.salesActivity.create({
          data: {
            prospectId: p.id,
            kind: input.kind,
            occurredAt,
            authorId: scope.userId,
            contactId: input.contactId,
            content: input.content,
            outcome: input.outcome,
            requestId: input.requestId,
          },
        });
        if (input.followUp) {
          await this.newTask(tx, scope, p, {
            requestId: input.requestId,
            title: input.followUp.title,
            dueOn: input.followUp.dueOn,
            contactId: input.followUp.contactId,
            assigneeId: null,
            note: null,
          });
        }
        return { id: a.id };
      },
    );
    return this.prospects.detail(scope, code);
  }

  /** A correction (new version) or withdrawal of the current version of an activity. */
  async correctActivity(
    scope: SalesScope,
    code: string,
    activityId: string,
    input: CorrectActivityRequest,
  ): Promise<ProspectDetail> {
    await this.operations.run(
      'SALES_ACTIVITY_CORRECT',
      input.requestId,
      { actorId: scope.userId, code, activityId, ...input, requestId: undefined },
      async (tx) => {
        const p = await visibleProspect(tx, code, scope, true);
        const a = await tx.salesActivity.findFirst({
          where: { id: activityId, prospectId: p.id },
          include: { correctedBy: { select: { id: true } } },
        });
        if (!a) throw new NotFoundException('Activity not found');
        if (a.correctedBy.length) {
          throw domainError(
            409,
            'ACTIVITY_ALREADY_CORRECTED',
            'This version was corrected in the meantime; reload and correct the current one',
          );
        }
        if (a.withdrawn)
          throw domainError(422, 'ACTIVITY_WITHDRAWN', 'This activity was withdrawn');
        const base = {
          prospectId: p.id,
          authorId: scope.userId,
          correctsId: a.id,
          correctionReason: input.reason,
          requestId: input.requestId,
        };
        if (input.withdraw) {
          // Keeps the kind and time of what is withdrawn; no content.
          await tx.salesActivity.create({
            data: { ...base, kind: a.kind, occurredAt: a.occurredAt, withdrawn: true },
          });
        } else {
          if (input.contactId && input.contactId !== a.contactId) {
            await this.activeContact(tx, p.id, input.contactId);
          }
          await tx.salesActivity.create({
            data: {
              ...base,
              kind: input.kind,
              occurredAt: await this.pastInstant(tx, input.occurredAt),
              contactId: input.contactId,
              content: input.content,
              outcome: input.outcome,
            },
          });
        }
        return { id: a.id };
      },
    );
    return this.prospects.detail(scope, code);
  }

  /** The local time as an instant; an activity cannot happen in the future. */
  private async pastInstant(tx: Db, local: string): Promise<Date> {
    const at = await salesInstant(tx, local);
    if (+at > Date.now() + 5 * 60_000) {
      throw domainError(
        422,
        'ACTIVITY_IN_FUTURE',
        'An activity is something that already happened',
      );
    }
    if (at.getUTCFullYear() < 2000) throw domainError(422, 'INVALID_TIME', 'Check the date');
    return at;
  }

  // --- tasks ---------------------------------------------------------------------------------

  async listTasks(scope: SalesScope, q: TaskListQuery): Promise<TaskPage> {
    if (q.assignee !== 'me' && !scope.all) {
      throw new ForbiddenException("Only an administrator sees other people's tasks");
    }
    const where: Prisma.SalesTaskWhereInput = {
      status: q.status === 'OPEN' ? 'OPEN' : { in: ['DONE', 'CANCELLED'] },
      ...(q.assignee === 'me'
        ? { assigneeId: scope.userId }
        : q.assignee === 'all'
          ? {}
          : { assigneeId: q.assignee }),
      prospect: scope.all ? {} : { ownerId: scope.userId },
    };
    const [items, total] = await Promise.all([
      this.views.tasks(where, TASK_PAGE_SIZE, (q.page - 1) * TASK_PAGE_SIZE, q.status !== 'OPEN'),
      this.prisma.salesTask.count({ where }),
    ]);
    return { items, total, page: q.page, pageSize: TASK_PAGE_SIZE, today: salesToday() };
  }

  async createTask(
    scope: SalesScope,
    code: string,
    input: CreateTaskRequest,
  ): Promise<ProspectDetail> {
    await this.operations.run(
      'SALES_TASK_SAVE',
      input.requestId,
      { actorId: scope.userId, code, ...input, requestId: undefined },
      async (tx) => {
        const p = await visibleProspect(tx, code, scope, true);
        return { id: await this.newTask(tx, scope, p, input) };
      },
    );
    return this.prospects.detail(scope, code);
  }

  private async newTask(
    tx: Db,
    scope: SalesScope,
    p: { id: string; ownerId: string },
    input: CreateTaskRequest,
  ): Promise<string> {
    this.assertNotPast(input.dueOn);
    await this.activeContact(tx, p.id, input.contactId);
    const assigneeId = await this.assignee(tx, scope, p, input.assigneeId);
    const t = await tx.salesTask.create({
      data: {
        prospectId: p.id,
        contactId: input.contactId,
        title: input.title,
        note: input.note,
        assigneeId,
        dueOn: asDate(input.dueOn),
        createdBy: scope.userId,
        updatedBy: scope.userId,
      },
    });
    await salesEvent(tx, {
      prospectId: p.id,
      type: 'TASK_CREATED',
      actorId: scope.userId,
      requestId: input.requestId,
      taskId: t.id,
      payload: { title: t.title, dueOn: input.dueOn, assigneeId },
    });
    return t.id;
  }

  /**
   * Who does a task: the prospect's owner by default. Someone else only with sales:manage, and only
   * a person who may see the prospect (its owner or another sales:manage holder).
   */
  private async assignee(
    tx: Db,
    scope: SalesScope,
    p: { ownerId: string },
    wanted: string | null,
  ): Promise<string> {
    if (!wanted || wanted === p.ownerId) return p.ownerId;
    if (!scope.all) {
      throw new ForbiddenException('Only an administrator assigns tasks to someone else');
    }
    const ok = await tx.$queryRaw<{ ok: number }[]>`
      SELECT 1 AS "ok" FROM "users" u WHERE u."id" = ${wanted}::uuid AND u."status" = 'ACTIVE'
        AND EXISTS (SELECT 1 FROM "user_roles" ur
          JOIN "roles" r ON r."code" = ur."role_code" AND r."active"
          JOIN "role_permissions" rp ON rp."role_code" = r."code" AND rp."permission_code" = 'sales:manage'
          WHERE ur."user_id" = u."id" AND ur."revoked_at" IS NULL)`;
    if (!ok.length) {
      throw domainError(
        422,
        'ASSIGNEE_WITHOUT_ACCESS',
        'This person cannot see the prospect; assign the prospect to them first',
      );
    }
    return wanted;
  }

  private assertNotPast(dueOn: string) {
    if (dueOn < salesToday()) throw domainError(422, 'DUE_IN_PAST', 'The due date has passed');
  }

  /** The open task under its row lock, after the visibility check of its prospect. */
  private async openTask(tx: Db, scope: SalesScope, id: string, revision: number) {
    await tx.$executeRaw`SELECT 1 FROM "sales_tasks" WHERE "id" = ${id}::uuid FOR UPDATE`;
    const t = await tx.salesTask.findUnique({
      where: { id },
      include: { prospect: { select: { id: true, code: true, ownerId: true } } },
    });
    if (!t || (!scope.all && t.prospect.ownerId !== scope.userId)) {
      throw new NotFoundException('Task not found');
    }
    if (t.status !== 'OPEN') {
      throw domainError(409, 'TASK_CLOSED', 'This task was already completed or cancelled');
    }
    if (t.revision !== revision) throw changed('TASK_CHANGED', 'task', t.revision);
    return t;
  }

  async updateTask(scope: SalesScope, id: string, input: UpdateTaskRequest) {
    const { result } = await this.operations.run(
      'SALES_TASK_SAVE',
      input.requestId,
      { actorId: scope.userId, id, op: 'update', ...input, requestId: undefined },
      async (tx) => {
        const t = await this.openTask(tx, scope, id, input.revision);
        if (input.contactId !== t.contactId) {
          await this.activeContact(tx, t.prospectId, input.contactId);
        }
        const assigneeId = await this.assignee(tx, scope, t.prospect, input.assigneeId);
        const changes: Record<string, { before: unknown; after: unknown }> = {};
        if (t.title !== input.title) changes.title = { before: t.title, after: input.title };
        if (t.note !== input.note) changes.note = { before: t.note, after: input.note };
        if (t.contactId !== input.contactId) {
          changes.contactId = { before: t.contactId, after: input.contactId };
        }
        if (t.assigneeId !== assigneeId) {
          changes.assigneeId = { before: t.assigneeId, after: assigneeId };
        }
        if (!Object.keys(changes).length) {
          throw domainError(422, 'TASK_UNCHANGED', 'Nothing was changed');
        }
        await tx.salesTask.update({
          where: { id },
          data: {
            title: input.title,
            note: input.note,
            contactId: input.contactId,
            assigneeId,
            revision: t.revision + 1,
            updatedAt: new Date(),
            updatedBy: scope.userId,
          },
        });
        await salesEvent(tx, {
          prospectId: t.prospectId,
          type: 'TASK_UPDATED',
          actorId: scope.userId,
          requestId: input.requestId,
          taskId: id,
          payload: { title: input.title, changes },
        });
        return { code: t.prospect.code };
      },
    );
    return this.prospects.detail(scope, result.code);
  }

  async rescheduleTask(scope: SalesScope, id: string, input: RescheduleTaskRequest) {
    const { result } = await this.operations.run(
      'SALES_TASK_SAVE',
      input.requestId,
      { actorId: scope.userId, id, op: 'reschedule', ...input, requestId: undefined },
      async (tx) => {
        const t = await this.openTask(tx, scope, id, input.revision);
        const before = dateOnly(t.dueOn);
        if (before === input.dueOn) {
          throw domainError(422, 'TASK_UNCHANGED', 'The task is already due on this day');
        }
        this.assertNotPast(input.dueOn);
        await tx.salesTask.update({
          where: { id },
          data: {
            dueOn: asDate(input.dueOn),
            revision: t.revision + 1,
            updatedAt: new Date(),
            updatedBy: scope.userId,
          },
        });
        await salesEvent(tx, {
          prospectId: t.prospectId,
          type: 'TASK_RESCHEDULED',
          actorId: scope.userId,
          requestId: input.requestId,
          taskId: id,
          payload: { title: t.title, from: before, to: input.dueOn, reason: input.reason },
        });
        return { code: t.prospect.code };
      },
    );
    return this.prospects.detail(scope, result.code);
  }

  /** Done (an optional result) — never a stage change. */
  async completeTask(scope: SalesScope, id: string, input: CompleteTaskRequest) {
    return this.close(scope, id, input.requestId, input.revision, 'DONE', input.result);
  }

  async cancelTask(scope: SalesScope, id: string, input: CancelTaskRequest) {
    return this.close(scope, id, input.requestId, input.revision, 'CANCELLED', input.reason);
  }

  private async close(
    scope: SalesScope,
    id: string,
    requestId: string,
    revision: number,
    status: 'DONE' | 'CANCELLED',
    result: string | null,
  ) {
    const { result: out } = await this.operations.run(
      'SALES_TASK_SAVE',
      requestId,
      { actorId: scope.userId, id, op: status, revision, result },
      async (tx) => {
        const t = await this.openTask(tx, scope, id, revision);
        await tx.salesTask.update({
          where: { id },
          data: {
            status,
            result,
            closedAt: new Date(),
            closedBy: scope.userId,
            revision: t.revision + 1,
            updatedAt: new Date(),
            updatedBy: scope.userId,
          },
        });
        await salesEvent(tx, {
          prospectId: t.prospectId,
          type: status === 'DONE' ? 'TASK_DONE' : 'TASK_CANCELLED',
          actorId: scope.userId,
          requestId,
          taskId: id,
          payload: { title: t.title, result },
        });
        return { code: t.prospect.code };
      },
    );
    return this.prospects.detail(scope, out.code);
  }
}
