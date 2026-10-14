import type {
  CreateWorkstationRequest,
  ManagedWorkstation,
  Workstation as WorkstationDto,
  WorkstationStatusChangeRequest,
} from '@ayvo/types';
import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import { generatePublicToken } from '../assets/public-token.js';
import { AuditService } from '../audit/audit.service.js';
import { domainError } from '../common/domain-error.js';
import { publicQrUrl } from '../common/qr-policy.js';
import { isUniqueViolation } from '../common/unique-violation.js';
import { ENV, type Env } from '../config/env.js';
import { OperationRequestsService } from '../database/operation-requests.service.js';
import { PrismaService } from '../database/prisma.service.js';
import type { Prisma } from '../generated/prisma/client.js';
import { InventoryService } from '../inventory/inventory.service.js';
import type { SiteContext } from '../inventory/warehouse-context.js';

export const workstationInclude = {
  site: { select: { code: true, name: true } },
  location: { select: { code: true, name: true } },
  category: { select: { code: true, name: true } },
} satisfies Prisma.WorkstationInclude;
export type WorkstationRecord = Prisma.WorkstationGetPayload<{
  include: typeof workstationInclude;
}>;

export const toWorkstation = (w: WorkstationRecord): WorkstationDto => ({
  code: w.code,
  name: w.name,
  mode: w.mode,
  category: w.category,
  site: w.site,
  warehouse: w.location,
  status: w.status,
  createdAt: w.createdAt.toISOString(),
});

const notFound = () => new NotFoundException('Workstation not found');

/**
 * Workstations (doc 026): work modes at a site, each with a station QR registered in the shared
 * QR registry (kind WORKSTATION). Managed per active site; another site's station is "not found".
 * Deactivating a station ends its active work session (CLOSED, with the reason) in the same
 * transaction — a crate in progress never depends on a session (owner B4).
 */
@Injectable()
export class WorkstationsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly operations: OperationRequestsService,
    private readonly inventory: InventoryService,
    private readonly audit: AuditService,
    @Inject(ENV) private readonly env: Env,
  ) {}

  qrUrl(token: string): string {
    return publicQrUrl(this.env.PUBLIC_QR_BASE_URL, token);
  }

  leaseExpired(session: { leaseExpiresAt: Date }, now = new Date()): boolean {
    return session.leaseExpiresAt.getTime() <= now.getTime();
  }

  async list(siteId: string): Promise<ManagedWorkstation[]> {
    const rows = await this.prisma.workstation.findMany({
      where: { siteId },
      include: {
        ...workstationInclude,
        sessions: {
          where: { status: 'ACTIVE' },
          include: { user: { select: { displayName: true } } },
        },
      },
      orderBy: { code: 'asc' },
    });
    const now = new Date();
    return rows.map((w) => {
      const active = w.sessions[0];
      return {
        ...toWorkstation(w),
        qrUrl: this.qrUrl(w.qrToken),
        activeSession: active
          ? {
              user: active.user.displayName,
              lastActivityAt: active.lastActivityAt.toISOString(),
              leaseExpired: this.leaseExpired(active, now),
            }
          : null,
      };
    });
  }

  /** A station of the given site by code (management). */
  async findOfSite(code: string, siteId: string): Promise<WorkstationRecord> {
    const station = await this.prisma.workstation.findUnique({
      where: { code },
      include: workstationInclude,
    });
    if (!station || station.siteId !== siteId) throw notFound();
    return station;
  }

  async create(
    actorId: string,
    input: CreateWorkstationRequest,
    site: SiteContext,
  ): Promise<ManagedWorkstation> {
    const { result } = await this.operations.run(
      'WORKSTATION_CREATE',
      input.requestId,
      { actorId, siteId: site.siteId, ...input, requestId: undefined },
      async (tx) => {
        if (input.categoryCode) {
          const category = await tx.productCategory.findUnique({
            where: { code: input.categoryCode },
          });
          if (!category) throw domainError(422, 'UNKNOWN_CATEGORY', 'Unknown product category');
        }
        // v0.1: one warehouse per site, the station works in it (doc 022 §2).
        const warehouse = await this.inventory.siteDefaultLocation(site.siteId, tx);
        if (!warehouse) {
          throw domainError(409, 'SITE_WITHOUT_WAREHOUSE', 'The active site has no warehouse');
        }
        if (await tx.workstation.findUnique({ where: { code: input.code } })) throw codeTaken();
        let created: WorkstationRecord;
        try {
          created = await tx.workstation.create({
            data: {
              code: input.code,
              name: input.name,
              siteId: site.siteId,
              locationId: warehouse.id,
              mode: input.mode,
              categoryCode: input.categoryCode,
              qrToken: generatePublicToken(),
              createdBy: actorId,
              operationRequestId: input.requestId,
            },
            include: workstationInclude,
          });
        } catch (error) {
          if (isUniqueViolation(error)) throw codeTaken();
          throw error;
        }
        await tx.workstationEvent.create({
          data: {
            workstationId: created.id,
            type: 'CREATED',
            actorId,
            operationRequestId: input.requestId,
            reason: input.reason,
          },
        });
        await this.audit.record(
          {
            type: 'WORKSTATION_CREATED',
            actorUserId: actorId,
            siteId: site.siteId,
            reason: input.reason,
            payload: {
              workstation: created.code,
              mode: created.mode,
              category: created.categoryCode,
            },
          },
          tx,
        );
        return {
          ...toWorkstation(created),
          qrUrl: this.qrUrl(created.qrToken),
          activeSession: null,
        } satisfies ManagedWorkstation;
      },
    );
    return result;
  }

  /** Deactivate (ends an active session) or reactivate; reason required; audited. */
  async setStatus(
    actorId: string,
    code: string,
    target: 'ACTIVE' | 'INACTIVE',
    input: WorkstationStatusChangeRequest,
    siteId: string,
  ): Promise<ManagedWorkstation> {
    const kind = target === 'INACTIVE' ? 'WORKSTATION_DEACTIVATE' : 'WORKSTATION_REACTIVATE';
    await this.operations.run(
      kind,
      input.requestId,
      { actorId, siteId, code, reason: input.reason },
      async (tx) => {
        // Lock order (doc 026): station → its sessions.
        const locked = await tx.$queryRaw<{ id: string; status: string; site_id: string }[]>`
          SELECT "id", "status"::text, "site_id" FROM "workstations" WHERE "code" = ${code} FOR UPDATE`;
        const station = locked[0];
        if (!station || station.site_id !== siteId) throw notFound();
        if (station.status === target) {
          throw domainError(
            409,
            target === 'INACTIVE' ? 'ALREADY_INACTIVE' : 'ALREADY_ACTIVE',
            'The workstation already has this status',
          );
        }
        await tx.workstationEvent.create({
          data: {
            workstationId: station.id,
            type: target === 'INACTIVE' ? 'DEACTIVATED' : 'REACTIVATED',
            actorId,
            operationRequestId: input.requestId,
            reason: input.reason,
          },
        });
        await tx.workstation.update({ where: { id: station.id }, data: { status: target } });
        if (target === 'INACTIVE') {
          const active = await tx.workstationSession.findFirst({
            where: { workstationId: station.id, status: 'ACTIVE' },
          });
          if (active) {
            await tx.workstationSessionEvent.create({
              data: {
                sessionId: active.id,
                type: 'CLOSED',
                actorId,
                operationRequestId: input.requestId,
                reason: input.reason,
              },
            });
            await tx.workstationSession.update({
              where: { id: active.id },
              data: {
                status: 'CLOSED',
                closedAt: new Date(),
                closedBy: actorId,
                closeReason: input.reason,
              },
            });
          }
        }
        await this.audit.record(
          {
            type: target === 'INACTIVE' ? 'WORKSTATION_DEACTIVATED' : 'WORKSTATION_REACTIVATED',
            actorUserId: actorId,
            siteId,
            reason: input.reason,
            payload: { workstation: code },
          },
          tx,
        );
        return { code };
      },
    );
    const [station] = (await this.list(siteId)).filter((w) => w.code === code);
    return station!;
  }
}

const codeTaken = () =>
  domainError(409, 'CODE_TAKEN', 'A workstation with this code already exists');
