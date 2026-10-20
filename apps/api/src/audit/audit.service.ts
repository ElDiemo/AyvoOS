import type { AuditEvent as AuditEventDto } from '@ayvo/types';
import { Injectable } from '@nestjs/common';
import type { Prisma } from '../generated/prisma/client.js';
import { PrismaService } from '../database/prisma.service.js';

/** Security and administration audit events (append-only, enforced by the database). */
export type AuditType =
  | 'LOGIN_SUCCEEDED'
  | 'LOGIN_DENIED'
  | 'LOGOUT'
  | 'SESSION_REVOKED'
  | 'IDENTITY_LINKED'
  | 'ADMIN_BOOTSTRAPPED'
  | 'USER_CREATED'
  | 'USER_DEACTIVATED'
  | 'USER_REACTIVATED'
  | 'ROLE_GRANTED'
  | 'ROLE_REVOKED'
  | 'USER_ACCESS_UPDATED'
  | 'SCOPE_GRANTED'
  | 'SCOPE_REVOKED'
  | 'ROLE_CREATED'
  | 'ROLE_UPDATED'
  | 'ROLE_DEACTIVATED'
  | 'ROLE_REACTIVATED'
  | 'SITE_CREATED'
  | 'SITE_UPDATED'
  | 'SITE_DEACTIVATED'
  | 'SITE_REACTIVATED'
  | 'WAREHOUSE_CREATED'
  | 'ACTIVE_SITE_SELECTED'
  | 'RECEIPT_COSTS_RECORDED'
  | 'RECEIPT_COST_CORRECTED'
  | 'INVITATION_SENT'
  | 'INVITATION_RESENT'
  | 'INVITATION_REVOKED'
  | 'INVITATION_FAILED'
  | 'INVITATION_ACCEPTED'
  | 'INVITATION_INTERRUPTED'
  | 'INVITATION_ACTION_SKIPPED'
  | 'CATALOG_COMPONENT_CREATED'
  | 'CRATE_TYPE_CREATED'
  | 'PRODUCT_CREATED'
  | 'PRODUCT_RENAMED'
  | 'PRODUCT_ARCHIVED'
  | 'RECIPE_DRAFT_CREATED'
  | 'RECIPE_DRAFT_UPDATED'
  | 'RECIPE_ACTIVATED'
  | 'RECIPE_ARCHIVED'
  | 'WORKSTATION_CREATED'
  | 'WORKSTATION_DEACTIVATED'
  | 'WORKSTATION_REACTIVATED'
  | 'STATION_SESSION_TAKEN_OVER'
  | 'PRODUCT_LABEL_APPROVED'
  | 'PRODUCT_LABEL_REVOKED'
  | 'HOTEL_CREATED'
  | 'CARRIER_SETTINGS_UPDATED'
  | 'CARRIER_CONNECTION_VERIFIED'
  | 'CARRIER_CONNECTION_VERIFY_FAILED'
  | 'CARRIER_CREDENTIALS_REPLACED';

export interface AuditInput {
  type: AuditType;
  actorUserId?: string | null;
  targetUserId?: string | null;
  /** The site a site-specific event concerns (doc 022). */
  siteId?: string | null;
  reason?: string | null;
  /** Small, non-secret details (never tokens, codes or keys). */
  payload?: Prisma.InputJsonObject;
}

@Injectable()
export class AuditService {
  constructor(private readonly prisma: PrismaService) {}

  record(input: AuditInput, db: Prisma.TransactionClient = this.prisma) {
    return db.auditEvent.create({
      data: {
        type: input.type,
        actorUserId: input.actorUserId ?? null,
        targetUserId: input.targetUserId ?? null,
        siteId: input.siteId ?? null,
        reason: input.reason ?? null,
        payload: input.payload ?? {},
      },
    });
  }

  /** Recent events matching `where`, with actor e-mails and site codes resolved. */
  async list(where: Prisma.AuditEventWhereInput, take = 100): Promise<AuditEventDto[]> {
    const events = await this.prisma.auditEvent.findMany({
      where,
      orderBy: { occurredAt: 'desc' },
      take,
      include: { site: { select: { code: true } } },
    });
    const actorIds = [...new Set(events.flatMap((a) => (a.actorUserId ? [a.actorUserId] : [])))];
    const actors = new Map(
      (
        await this.prisma.user.findMany({
          where: { id: { in: actorIds } },
          select: { id: true, email: true },
        })
      ).map((a) => [a.id, a.email]),
    );
    return events.map((a) => ({
      id: a.id,
      type: a.type,
      occurredAt: a.occurredAt.toISOString(),
      actor: a.actorUserId ? (actors.get(a.actorUserId) ?? null) : null,
      site: a.site?.code ?? null,
      reason: a.reason,
      details: (a.payload ?? {}) as Record<string, unknown>,
    }));
  }
}
