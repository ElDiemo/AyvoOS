import type {
  AdminUserDetail,
  AdminUserSummary,
  CreateUserRequest,
  PermissionCode,
  RoleCode,
} from '@ayvo/types';
import { Injectable } from '@nestjs/common';
import { AuditService } from '../audit/audit.service.js';
import { domainError } from '../common/domain-error.js';
import { PrismaService } from '../database/prisma.service.js';
import type { Prisma } from '../generated/prisma/client.js';
import { InventoryService } from '../inventory/inventory.service.js';
import { SitesService } from '../sites/sites.service.js';
import { AccessService, toAccessibleSite } from './access.service.js';
import { SessionsService } from './sessions.service.js';

const notFound = () => domainError(404, 'USER_NOT_FOUND', 'No such user');

/** Who performs an administrative change: their id and their current permissions. */
export interface Actor {
  userId: string;
  permissions: ReadonlySet<PermissionCode>;
}

/**
 * Administration of users, role assignments and site/warehouse scopes (ADMIN,
 * `identity:users_manage`). Every change needs a reason, is audited and takes effect on the
 * user's next request. The last active ADMIN can neither lose the role nor be deactivated. No
 * actor can hand out a role with a permission the actor does not hold (no privilege escalation).
 */
@Injectable()
export class UsersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly sessions: SessionsService,
    private readonly inventory: InventoryService,
    private readonly sites: SitesService,
    private readonly access: AccessService,
  ) {}

  async warehouses() {
    const sites = new Map((await this.sites.all()).map((s) => [s.id, s]));
    return (await this.inventory.listLocations()).map((l) => ({
      code: l.code,
      name: l.name,
      siteId: l.siteId,
      siteCode: sites.get(l.siteId)?.code ?? null,
    }));
  }

  async sitesForAssignment() {
    return (await this.sites.all()).map((s) => ({
      id: s.id,
      code: s.code,
      name: s.name,
      active: s.active,
      warehouses: s.locations.map((l) => ({ code: l.code, name: l.name })),
    }));
  }

  async list(): Promise<AdminUserSummary[]> {
    const users = await this.prisma.user.findMany({
      include: {
        roles: {
          where: { revokedAt: null },
          select: { role: { select: { code: true, name: true } } },
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
          include: {
            grantedByUser: { select: { email: true } },
            role: { select: { code: true, name: true, isSystem: true } },
          },
          orderBy: { roleCode: 'asc' },
        },
        identities: { where: { unlinkedAt: null }, select: { id: true } },
      },
    });
    if (!user) throw notFound();
    const snapshot = await this.access.snapshot(id);
    return {
      ...this.summary(user),
      roleGrants: user.roles.map((r) => ({
        role: r.role.code,
        name: r.role.name,
        system: r.role.isSystem,
        grantedAt: r.grantedAt.toISOString(),
        grantedBy: r.grantedByUser?.email ?? null,
      })),
      scopes: snapshot.scopes.map((s) => ({
        id: s.id,
        type: s.type as AdminUserDetail['scopes'][number]['type'],
        siteId: s.siteId,
        siteCode: s.siteCode,
        locationCode: s.locationCode,
        scopeRef: s.scopeRef,
        grantedAt: s.grantedAt.toISOString(),
      })),
      effectiveAccess: {
        permissions: [...snapshot.permissions].sort(),
        globalSiteAccess: snapshot.globalSiteAccess,
        sites: snapshot.sites.map(toAccessibleSite),
      },
      deactivatedAt: user.deactivatedAt?.toISOString() ?? null,
      deactivationReason: user.deactivationReason,
      activeSessions: await this.sessions.countActive(id),
      audit: await this.audit.list({ OR: [{ targetUserId: id }, { actorUserId: id }] }),
    };
  }

  async create(actor: Actor, request: CreateUserRequest): Promise<AdminUserDetail> {
    const id = await this.prisma.$transaction(async (tx) => {
      if (await tx.user.findUnique({ where: { email: request.email } })) {
        throw domainError(409, 'USER_EXISTS', 'A user with this e-mail already exists');
      }
      const user = await tx.user.create({
        data: { email: request.email, displayName: request.displayName, createdBy: actor.userId },
      });
      await this.audit.record(
        {
          type: 'USER_CREATED',
          actorUserId: actor.userId,
          targetUserId: user.id,
          reason: request.reason,
        },
        tx,
      );
      for (const role of new Set(request.roles)) {
        await this.addRole(tx, actor, user.id, role, request.reason);
      }
      for (const siteId of new Set(request.siteIds)) {
        await this.addSiteScope(tx, actor.userId, user.id, siteId, request.reason);
      }
      for (const code of new Set(request.warehouseCodes)) {
        await this.addWarehouseScope(tx, actor.userId, user.id, code, request.reason);
      }
      return user.id;
    });
    return this.get(id);
  }

  async grantRole(actor: Actor, userId: string, role: RoleCode, reason: string) {
    await this.prisma.$transaction(async (tx) => {
      await this.requireUser(tx, userId);
      await this.addRole(tx, actor, userId, role, reason);
    });
    return this.get(userId);
  }

  async revokeRole(actor: Actor, userId: string, role: RoleCode, reason: string) {
    await this.prisma.$transaction(async (tx) => {
      const user = await this.requireUser(tx, userId);
      if (role === 'ADMIN' && user.status === 'ACTIVE') await this.assertNotLastAdmin(tx, userId);
      const revoked = await tx.userRole.updateMany({
        where: { userId, roleCode: role, revokedAt: null },
        data: { revokedAt: new Date(), revokedBy: actor.userId, revokeReason: reason },
      });
      if (revoked.count === 0)
        throw domainError(409, 'ROLE_NOT_GRANTED', 'The user does not have this role');
      await this.audit.record(
        {
          type: 'ROLE_REVOKED',
          actorUserId: actor.userId,
          targetUserId: userId,
          reason,
          payload: { role },
        },
        tx,
      );
    });
    return this.get(userId);
  }

  async grantSite(actor: Actor, userId: string, siteId: string, reason: string) {
    await this.prisma.$transaction(async (tx) => {
      await this.requireUser(tx, userId);
      await this.addSiteScope(tx, actor.userId, userId, siteId, reason);
    });
    return this.get(userId);
  }

  /** Ends access to a site — and to every warehouse of it — in one transaction. */
  async revokeSite(actor: Actor, userId: string, siteId: string, reason: string) {
    await this.prisma.$transaction(async (tx) => {
      await this.requireUser(tx, userId);
      const site = await tx.site.findUnique({ where: { id: siteId } });
      if (!site) throw domainError(422, 'UNKNOWN_SITE', 'No such site');
      const now = new Date();
      const warehouses = await tx.userScope.findMany({
        where: { userId, type: 'WAREHOUSE', revokedAt: null, location: { siteId } },
        include: { location: { select: { code: true } } },
      });
      for (const w of warehouses) {
        await tx.userScope.update({
          where: { id: w.id },
          data: { revokedAt: now, revokedBy: actor.userId },
        });
        await this.audit.record(
          {
            type: 'SCOPE_REVOKED',
            actorUserId: actor.userId,
            targetUserId: userId,
            siteId,
            reason,
            payload: { warehouse: w.location!.code, site: site.code },
          },
          tx,
        );
      }
      const revoked = await tx.userScope.updateMany({
        where: { userId, type: 'SITE', siteId, revokedAt: null },
        data: { revokedAt: now, revokedBy: actor.userId },
      });
      if (revoked.count === 0)
        throw domainError(409, 'SCOPE_NOT_GRANTED', 'The user has no access to this site');
      await this.audit.record(
        {
          type: 'SCOPE_REVOKED',
          actorUserId: actor.userId,
          targetUserId: userId,
          siteId,
          reason,
          payload: { site: site.code },
        },
        tx,
      );
    });
    return this.get(userId);
  }

  async grantWarehouse(actor: Actor, userId: string, code: string, reason: string) {
    await this.prisma.$transaction(async (tx) => {
      await this.requireUser(tx, userId);
      await this.addWarehouseScope(tx, actor.userId, userId, code, reason);
    });
    return this.get(userId);
  }

  async revokeWarehouse(actor: Actor, userId: string, code: string, reason: string) {
    await this.prisma.$transaction(async (tx) => {
      await this.requireUser(tx, userId);
      const location = await this.inventory.locationByCode(code, tx);
      if (!location) throw domainError(422, 'UNKNOWN_WAREHOUSE', 'No such warehouse');
      const revoked = await tx.userScope.updateMany({
        where: { userId, type: 'WAREHOUSE', locationId: location.id, revokedAt: null },
        data: { revokedAt: new Date(), revokedBy: actor.userId },
      });
      if (revoked.count === 0)
        throw domainError(409, 'SCOPE_NOT_GRANTED', 'The user has no access to this warehouse');
      await this.audit.record(
        {
          type: 'SCOPE_REVOKED',
          actorUserId: actor.userId,
          targetUserId: userId,
          siteId: location.siteId,
          reason,
          payload: { warehouse: code },
        },
        tx,
      );
    });
    return this.get(userId);
  }

  async deactivate(actor: Actor, userId: string, reason: string) {
    if (actor.userId === userId) {
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
          deactivatedBy: actor.userId,
          deactivationReason: reason,
        },
      });
      // Access ends now: open sessions are revoked in the same transaction.
      await this.sessions.revokeAllForUser(userId, 'USER_DEACTIVATED', tx);
      await this.audit.record(
        { type: 'USER_DEACTIVATED', actorUserId: actor.userId, targetUserId: userId, reason },
        tx,
      );
    });
    return this.get(userId);
  }

  async reactivate(actor: Actor, userId: string, reason: string) {
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
        { type: 'USER_REACTIVATED', actorUserId: actor.userId, targetUserId: userId, reason },
        tx,
      );
    });
    return this.get(userId);
  }

  private async addRole(
    tx: Prisma.TransactionClient,
    actor: Actor,
    userId: string,
    code: RoleCode,
    reason: string,
  ) {
    const role = await tx.role.findUnique({
      where: { code },
      include: { permissions: { select: { permissionCode: true } } },
    });
    if (!role) throw domainError(422, 'UNKNOWN_ROLE', 'No such role');
    if (!role.active) throw domainError(409, 'ROLE_INACTIVE', 'An inactive role cannot be granted');
    assertCanGrant(
      actor,
      role.permissions.map((p) => p.permissionCode as PermissionCode),
    );
    const open = await tx.userRole.findFirst({
      where: { userId, roleCode: code, revokedAt: null },
    });
    if (open) throw domainError(409, 'ROLE_ALREADY_GRANTED', 'The user already has this role');
    await tx.userRole.create({
      data: { userId, roleCode: code, grantedBy: actor.userId, grantReason: reason },
    });
    await this.audit.record(
      {
        type: 'ROLE_GRANTED',
        actorUserId: actor.userId,
        targetUserId: userId,
        reason,
        payload: { role: code },
      },
      tx,
    );
  }

  private async addSiteScope(
    tx: Prisma.TransactionClient,
    actorId: string,
    userId: string,
    siteId: string,
    reason: string,
  ) {
    const site = await tx.site.findUnique({ where: { id: siteId } });
    if (!site) throw domainError(422, 'UNKNOWN_SITE', 'No such site');
    const open = await tx.userScope.findFirst({
      where: { userId, type: 'SITE', siteId, revokedAt: null },
    });
    if (open)
      throw domainError(409, 'SCOPE_ALREADY_GRANTED', 'The user already has access to this site');
    await tx.userScope.create({ data: { userId, type: 'SITE', siteId, grantedBy: actorId } });
    await this.audit.record(
      {
        type: 'SCOPE_GRANTED',
        actorUserId: actorId,
        targetUserId: userId,
        siteId,
        reason,
        payload: { site: site.code },
      },
      tx,
    );
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
    const siteAccess = await tx.userScope.findFirst({
      where: { userId, type: 'SITE', siteId: location.siteId, revokedAt: null },
    });
    if (!siteAccess) {
      throw domainError(
        422,
        'SITE_ACCESS_REQUIRED',
        'Grant access to the warehouse’s site first; a warehouse only narrows a site',
      );
    }
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
        siteId: location.siteId,
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

  /**
   * Serialised by locking all open ADMIN grants AND their users: under READ COMMITTED a waiting
   * transaction re-checks the locked rows after the other commits, so a concurrent deactivation
   * of one admin and revocation of the other cannot both pass (review P1). The database checks
   * the same invariant again at commit (`ayvo_last_admin_guard`).
   */
  private async assertNotLastAdmin(tx: Prisma.TransactionClient, userId: string) {
    const admins = await tx.$queryRaw<{ user_id: string }[]>`
      SELECT r."user_id" FROM "user_roles" r JOIN "users" u ON u."id" = r."user_id"
      WHERE r."role_code" = 'ADMIN' AND r."revoked_at" IS NULL AND u."status" = 'ACTIVE'
      FOR UPDATE OF r, u`;
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
    roles: { role: { code: string; name: string } }[];
    identities: { id: string }[];
  }): AdminUserSummary {
    return {
      id: user.id,
      email: user.email,
      displayName: user.displayName,
      status: user.status,
      roles: user.roles.map((r) => ({ code: r.role.code, name: r.role.name })),
      linked: user.identities.length > 0,
      lastLoginAt: user.lastLoginAt?.toISOString() ?? null,
      createdAt: user.createdAt.toISOString(),
    };
  }
}

/**
 * No privilege escalation: an actor can hand out (assign, or put into a role) only permissions
 * the actor holds right now.
 */
export function assertCanGrant(actor: Actor, permissions: readonly PermissionCode[]): void {
  const missing = permissions.filter((p) => !actor.permissions.has(p));
  if (missing.length > 0) {
    throw domainError(
      403,
      'PRIVILEGE_ESCALATION',
      `You cannot grant permissions you do not hold: ${missing.join(', ')}`,
    );
  }
}
