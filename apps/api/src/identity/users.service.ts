import type {
  AdminUserDetail,
  AdminUserSummary,
  CreateUserRequest,
  RoleCatalog,
  RoleCode,
} from '@ayvo/types';
import { Injectable } from '@nestjs/common';
import { domainError } from '../common/domain-error.js';
import { PrismaService } from '../database/prisma.service.js';
import type { Prisma } from '../generated/prisma/client.js';
import { InventoryService } from '../inventory/inventory.service.js';
import { AuditService } from './audit.service.js';
import { SessionsService } from './sessions.service.js';

const notFound = () => domainError(404, 'USER_NOT_FOUND', 'No such user');

/**
 * Administration of users, roles and scopes (ADMIN, `identity:users_manage`). Every change needs
 * a reason, is audited and takes effect on the user's next request. The last active ADMIN can
 * neither lose the role nor be deactivated.
 */
@Injectable()
export class UsersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly sessions: SessionsService,
    private readonly inventory: InventoryService,
  ) {}

  async roleCatalog(): Promise<RoleCatalog> {
    const roles = await this.prisma.role.findMany({
      include: {
        permissions: { select: { permissionCode: true }, orderBy: { permissionCode: 'asc' } },
      },
      orderBy: { code: 'asc' },
    });
    return roles.map((r) => ({
      code: r.code as RoleCode,
      name: r.name,
      permissions: r.permissions.map((p) => p.permissionCode) as RoleCatalog[number]['permissions'],
    }));
  }

  async warehouses() {
    return (await this.inventory.listLocations()).map((l) => ({ code: l.code, name: l.name }));
  }

  async list(): Promise<AdminUserSummary[]> {
    const users = await this.prisma.user.findMany({
      include: {
        roles: {
          where: { revokedAt: null },
          select: { roleCode: true },
          orderBy: { roleCode: 'asc' },
        },
        identities: { where: { unlinkedAt: null }, select: { id: true } },
      },
      orderBy: [{ status: 'asc' }, { email: 'asc' }],
    });
    return users.map((u) => this.summary(u));
  }

  async get(id: string): Promise<AdminUserDetail> {
    const user = await this.prisma.user.findUnique({
      where: { id },
      include: {
        roles: {
          where: { revokedAt: null },
          include: { grantedByUser: { select: { email: true } } },
          orderBy: { roleCode: 'asc' },
        },
        identities: { where: { unlinkedAt: null }, select: { id: true } },
        scopes: {
          where: { revokedAt: null },
          include: { location: { select: { code: true } } },
          orderBy: { grantedAt: 'asc' },
        },
      },
    });
    if (!user) throw notFound();
    const audit = await this.prisma.auditEvent.findMany({
      where: { OR: [{ targetUserId: id }, { actorUserId: id }] },
      orderBy: { occurredAt: 'desc' },
      take: 100,
    });
    const actorIds = [...new Set(audit.flatMap((a) => (a.actorUserId ? [a.actorUserId] : [])))];
    const actors = new Map(
      (
        await this.prisma.user.findMany({
          where: { id: { in: actorIds } },
          select: { id: true, email: true },
        })
      ).map((a) => [a.id, a.email]),
    );
    return {
      ...this.summary(user),
      roleGrants: user.roles.map((r) => ({
        role: r.roleCode as RoleCode,
        grantedAt: r.grantedAt.toISOString(),
        grantedBy: r.grantedByUser?.email ?? null,
      })),
      scopes: user.scopes.map((s) => ({
        id: s.id,
        type: s.type,
        locationCode: s.location?.code ?? null,
        scopeRef: s.scopeRef,
        grantedAt: s.grantedAt.toISOString(),
      })),
      deactivatedAt: user.deactivatedAt?.toISOString() ?? null,
      deactivationReason: user.deactivationReason,
      activeSessions: await this.sessions.countActive(id),
      audit: audit.map((a) => ({
        id: a.id,
        type: a.type,
        occurredAt: a.occurredAt.toISOString(),
        actor: a.actorUserId ? (actors.get(a.actorUserId) ?? null) : null,
        reason: a.reason,
        details: (a.payload ?? {}) as Record<string, unknown>,
      })),
    };
  }

  async create(actorId: string, request: CreateUserRequest): Promise<AdminUserDetail> {
    const id = await this.prisma.$transaction(async (tx) => {
      if (await tx.user.findUnique({ where: { email: request.email } })) {
        throw domainError(409, 'USER_EXISTS', 'A user with this e-mail already exists');
      }
      const user = await tx.user.create({
        data: { email: request.email, displayName: request.displayName, createdBy: actorId },
      });
      await this.audit.record(
        {
          type: 'USER_CREATED',
          actorUserId: actorId,
          targetUserId: user.id,
          reason: request.reason,
        },
        tx,
      );
      for (const role of new Set(request.roles)) {
        await tx.userRole.create({
          data: {
            userId: user.id,
            roleCode: role,
            grantedBy: actorId,
            grantReason: request.reason,
          },
        });
        await this.audit.record(
          {
            type: 'ROLE_GRANTED',
            actorUserId: actorId,
            targetUserId: user.id,
            reason: request.reason,
            payload: { role },
          },
          tx,
        );
      }
      for (const code of new Set(request.warehouseCodes)) {
        await this.addWarehouseScope(tx, actorId, user.id, code, request.reason);
      }
      return user.id;
    });
    return this.get(id);
  }

  async grantRole(actorId: string, userId: string, role: RoleCode, reason: string) {
    await this.prisma.$transaction(async (tx) => {
      await this.requireUser(tx, userId);
      const open = await tx.userRole.findFirst({
        where: { userId, roleCode: role, revokedAt: null },
      });
      if (open) throw domainError(409, 'ROLE_ALREADY_GRANTED', 'The user already has this role');
      await tx.userRole.create({
        data: { userId, roleCode: role, grantedBy: actorId, grantReason: reason },
      });
      await this.audit.record(
        {
          type: 'ROLE_GRANTED',
          actorUserId: actorId,
          targetUserId: userId,
          reason,
          payload: { role },
        },
        tx,
      );
    });
    return this.get(userId);
  }

  async revokeRole(actorId: string, userId: string, role: RoleCode, reason: string) {
    await this.prisma.$transaction(async (tx) => {
      const user = await this.requireUser(tx, userId);
      if (role === 'ADMIN' && user.status === 'ACTIVE') await this.assertNotLastAdmin(tx, userId);
      const revoked = await tx.userRole.updateMany({
        where: { userId, roleCode: role, revokedAt: null },
        data: { revokedAt: new Date(), revokedBy: actorId, revokeReason: reason },
      });
      if (revoked.count === 0)
        throw domainError(409, 'ROLE_NOT_GRANTED', 'The user does not have this role');
      await this.audit.record(
        {
          type: 'ROLE_REVOKED',
          actorUserId: actorId,
          targetUserId: userId,
          reason,
          payload: { role },
        },
        tx,
      );
    });
    return this.get(userId);
  }

  async grantWarehouse(actorId: string, userId: string, code: string, reason: string) {
    await this.prisma.$transaction(async (tx) => {
      await this.requireUser(tx, userId);
      await this.addWarehouseScope(tx, actorId, userId, code, reason);
    });
    return this.get(userId);
  }

  async revokeWarehouse(actorId: string, userId: string, code: string, reason: string) {
    await this.prisma.$transaction(async (tx) => {
      await this.requireUser(tx, userId);
      const location = await this.inventory.locationByCode(code, tx);
      if (!location) throw domainError(422, 'UNKNOWN_WAREHOUSE', 'No such warehouse');
      const revoked = await tx.userScope.updateMany({
        where: { userId, type: 'WAREHOUSE', locationId: location.id, revokedAt: null },
        data: { revokedAt: new Date(), revokedBy: actorId },
      });
      if (revoked.count === 0)
        throw domainError(409, 'SCOPE_NOT_GRANTED', 'The user has no access to this warehouse');
      await this.audit.record(
        {
          type: 'SCOPE_REVOKED',
          actorUserId: actorId,
          targetUserId: userId,
          reason,
          payload: { warehouse: code },
        },
        tx,
      );
    });
    return this.get(userId);
  }

  async deactivate(actorId: string, userId: string, reason: string) {
    if (actorId === userId) {
      throw domainError(409, 'CANNOT_DEACTIVATE_SELF', 'You cannot deactivate your own account');
    }
    await this.prisma.$transaction(async (tx) => {
      const user = await this.requireUser(tx, userId);
      if (user.status !== 'ACTIVE')
        throw domainError(409, 'ALREADY_DEACTIVATED', 'The user is already deactivated');
      await this.assertNotLastAdmin(tx, userId);
      await tx.user.update({
        where: { id: userId },
        data: {
          status: 'DEACTIVATED',
          deactivatedAt: new Date(),
          deactivatedBy: actorId,
          deactivationReason: reason,
        },
      });
      // Access ends now: open sessions are revoked in the same transaction.
      await this.sessions.revokeAllForUser(userId, 'USER_DEACTIVATED', tx);
      await this.audit.record(
        { type: 'USER_DEACTIVATED', actorUserId: actorId, targetUserId: userId, reason },
        tx,
      );
    });
    return this.get(userId);
  }

  async reactivate(actorId: string, userId: string, reason: string) {
    await this.prisma.$transaction(async (tx) => {
      const user = await this.requireUser(tx, userId);
      if (user.status === 'ACTIVE')
        throw domainError(409, 'ALREADY_ACTIVE', 'The user is already active');
      await tx.user.update({
        where: { id: userId },
        data: {
          status: 'ACTIVE',
          deactivatedAt: null,
          deactivatedBy: null,
          deactivationReason: null,
        },
      });
      await this.audit.record(
        { type: 'USER_REACTIVATED', actorUserId: actorId, targetUserId: userId, reason },
        tx,
      );
    });
    return this.get(userId);
  }

  private async addWarehouseScope(
    tx: Prisma.TransactionClient,
    actorId: string,
    userId: string,
    code: string,
    reason: string,
  ) {
    const location = await this.inventory.locationByCode(code, tx);
    if (!location) throw domainError(422, 'UNKNOWN_WAREHOUSE', 'No such warehouse');
    const open = await tx.userScope.findFirst({
      where: { userId, type: 'WAREHOUSE', locationId: location.id, revokedAt: null },
    });
    if (open)
      throw domainError(
        409,
        'SCOPE_ALREADY_GRANTED',
        'The user already has access to this warehouse',
      );
    await tx.userScope.create({
      data: { userId, type: 'WAREHOUSE', locationId: location.id, grantedBy: actorId },
    });
    await this.audit.record(
      {
        type: 'SCOPE_GRANTED',
        actorUserId: actorId,
        targetUserId: userId,
        reason,
        payload: { warehouse: code },
      },
      tx,
    );
  }

  private async requireUser(tx: Prisma.TransactionClient, userId: string) {
    // Row lock: concurrent administrative changes of one user are serialised.
    const rows = await tx.$queryRaw<{ id: string; status: string }[]>`
      SELECT "id", "status"::text AS "status" FROM "users" WHERE "id" = ${userId}::uuid FOR UPDATE`;
    if (!rows[0]) throw notFound();
    return rows[0];
  }

  /** Serialised by locking all open ADMIN grants: two admins cannot remove each other at once. */
  private async assertNotLastAdmin(tx: Prisma.TransactionClient, userId: string) {
    const admins = await tx.$queryRaw<{ user_id: string }[]>`
      SELECT r."user_id" FROM "user_roles" r JOIN "users" u ON u."id" = r."user_id"
      WHERE r."role_code" = 'ADMIN' AND r."revoked_at" IS NULL AND u."status" = 'ACTIVE'
      FOR UPDATE OF r`;
    if (admins.some((a) => a.user_id === userId) && admins.length <= 1) {
      throw domainError(409, 'LAST_ADMIN', 'The last active administrator cannot lose access');
    }
  }

  private summary(user: {
    id: string;
    email: string;
    displayName: string;
    status: 'ACTIVE' | 'DEACTIVATED';
    lastLoginAt: Date | null;
    createdAt: Date;
    roles: { roleCode: string }[];
    identities: { id: string }[];
  }): AdminUserSummary {
    return {
      id: user.id,
      email: user.email,
      displayName: user.displayName,
      status: user.status,
      roles: user.roles.map((r) => r.roleCode as RoleCode),
      linked: user.identities.length > 0,
      lastLoginAt: user.lastLoginAt?.toISOString() ?? null,
      createdAt: user.createdAt.toISOString(),
    };
  }
}
