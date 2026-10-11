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
  | 'SCOPE_GRANTED'
  | 'SCOPE_REVOKED';

export interface AuditInput {
  type: AuditType;
  actorUserId?: string | null;
  targetUserId?: string | null;
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
        reason: input.reason ?? null,
        payload: input.payload ?? {},
      },
    });
  }
}
