import { createHash, randomUUID } from 'node:crypto';
import {
  isPlannedRole,
  type AdminUserDetail,
  type AdminUserSummary,
  type CreateUserRequest,
  type PermissionCode,
  type RoleCode,
  type UpdateUserAccessRequest,
} from '@ayvo/types';
import { Injectable, Logger } from '@nestjs/common';
import { AuditService } from '../audit/audit.service.js';
import { domainError, idempotencyConflict } from '../common/domain-error.js';
import { canonicalJson } from '../database/operation-requests.service.js';
import { PrismaService } from '../database/prisma.service.js';
import type { Prisma } from '../generated/prisma/client.js';
import { InventoryService } from '../inventory/inventory.service.js';
import { SitesService } from '../sites/sites.service.js';
import { AccessService, toAccessibleSite } from './access.service.js';
import { invitationView, InvitationsService } from './invitations.service.js';
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
  private readonly logger = new Logger(UsersService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly sessions: SessionsService,
    private readonly inventory: InventoryService,
    private readonly sites: SitesService,
    private readonly access: AccessService,
    private readonly invitations: InvitationsService,
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
        invitations: { orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], take: 1 },
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
        invitations: { orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], take: 1 },
      },
    });
    if (!user) throw notFound();
    const snapshot = await this.access.snapshot(id);
    return {
      ...this.summary(user),
      invitation: invitationView(user.invitations[0] ?? null),
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
    // Roles and sites are in place before the invitation is sent. If sending fails, the prepared
    // user stays without any way to sign in — FAILED (refused) or SENDING (no answer; retry is
    // safe) — the failure is audited by the invitation service, logged here and shown to the
    // administrator with a "send again" action; never a partially authorized account.
    try {
      await this.invitations.send(actor.userId, id, randomUUID(), request.reason);
    } catch (error) {
      this.logger.warn(
        JSON.stringify({
          event: 'invitation_send_on_create_failed',
          userId: id,
          code:
            (error as { getResponse?: () => { code?: string } }).getResponse?.().code ??
            'UNEXPECTED',
        }),
      );
    }
    return this.get(id);
  }

  async sendInvitation(actor: Actor, userId: string, requestId: string, reason: string) {
    await this.invitations.send(actor.userId, userId, requestId, reason);
    return this.get(userId);
  }

  async resendInvitation(actor: Actor, userId: string, requestId: string, reason: string) {
    await this.invitations.resend(actor.userId, userId, requestId, reason);
    return this.get(userId);
  }

  async revokeInvitation(actor: Actor, userId: string, requestId: string, reason: string) {
    await this.invitations.revoke(actor.userId, userId, requestId, reason);
    return this.get(userId);
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
      await this.removeRole(tx, actor, user, role, reason);
    });
    return this.get(userId);
  }

  /**
   * Replaces the user's roles, sites and narrower warehouses with the requested state in ONE
   * transaction (doc 021 §7): everything is validated and applied, or nothing is. The same rules as
   * the single grants apply (planned roles refused, no privilege escalation, a warehouse only
   * narrows a site in the new state, the last active administrator keeps ADMIN). Idempotent per
   * request id for this user: the request id and a hash of the request live in the append-only
   * audit event `USER_ACCESS_UPDATED`, checked under the user's row lock; the same id with the
   * same request returns the current state, with another request IDEMPOTENCY_CONFLICT.
   */
  async updateAccess(
    actor: Actor,
    userId: string,
    input: UpdateUserAccessRequest,
  ): Promise<AdminUserDetail> {
    const want = {
      roles: [...input.roles].sort(),
      siteIds: [...input.siteIds].sort(),
      warehouseCodes: [...input.warehouseCodes].sort(),
    };
    const requestHash = createHash('sha256')
      .update(canonicalJson({ ...want, reason: input.reason }))
      .digest('hex');
    await this.prisma.$transaction(async (tx) => {
      // Lock order as in every user change: the user row first, then (for ADMIN) the admin rows.
      const user = await this.requireUser(tx, userId);
      const previous = await tx.auditEvent.findFirst({
        where: {
          type: 'USER_ACCESS_UPDATED',
          targetUserId: userId,
          payload: { path: ['requestId'], equals: input.requestId },
        },
      });
      if (previous) {
        if ((previous.payload as Record<string, unknown>).requestHash === requestHash) return;
        throw idempotencyConflict();
      }

      const before = await this.accessState(tx, userId);
      const sites = await tx.site.findMany({
        where: { id: { in: [...new Set([...want.siteIds, ...before.siteIds])] } },
      });
      if (want.siteIds.some((id) => !sites.some((s) => s.id === id))) {
        throw domainError(422, 'UNKNOWN_SITE', 'No such site');
      }
      for (const code of want.warehouseCodes) {
        const location = await this.inventory.locationByCode(code, tx);
        if (!location) throw domainError(422, 'UNKNOWN_WAREHOUSE', 'No such warehouse');
        if (!want.siteIds.includes(location.siteId)) {
          throw domainError(
            422,
            'SITE_ACCESS_REQUIRED',
            'A warehouse only narrows a site the user keeps access to',
          );
        }
      }
      const diff = <T>(a: T[], b: T[]) => a.filter((x) => !b.includes(x));
      const change = {
        addRoles: diff(want.roles, before.roles),
        removeRoles: diff(before.roles, want.roles),
        addSites: diff(want.siteIds, before.siteIds),
        removeSites: diff(before.siteIds, want.siteIds),
        addWarehouses: diff(want.warehouseCodes, before.warehouseCodes),
        removeWarehouses: diff(before.warehouseCodes, want.warehouseCodes),
      };
      if (Object.values(change).every((l) => l.length === 0)) {
        throw domainError(422, 'NO_CHANGES', 'The requested access equals the current access');
      }

      // Removals first (warehouses before their sites), then additions (sites before warehouses).
      for (const code of change.removeWarehouses) {
        await this.removeWarehouseScope(tx, actor, userId, code, input.reason);
      }
      for (const siteId of change.removeSites) {
        await this.removeSiteScope(tx, actor, userId, siteId, input.reason);
      }
      for (const role of change.removeRoles) {
        await this.removeRole(tx, actor, user, role, input.reason);
      }
      for (const role of change.addRoles) {
        await this.addRole(tx, actor, userId, role, input.reason);
      }
      for (const siteId of change.addSites) {
        await this.addSiteScope(tx, actor.userId, userId, siteId, input.reason);
      }
      for (const code of change.addWarehouses) {
        await this.addWarehouseScope(tx, actor.userId, userId, code, input.reason);
      }

      const siteCode = (id: string) => sites.find((s) => s.id === id)?.code ?? id;
      const view = (state: AccessState) => ({
        roles: state.roles,
        sites: state.siteIds.map(siteCode).sort(),
        warehouses: state.warehouseCodes,
      });
      await this.audit.record(
        {
          type: 'USER_ACCESS_UPDATED',
          actorUserId: actor.userId,
          targetUserId: userId,
          reason: input.reason,
          payload: {
            requestId: input.requestId,
            requestHash,
            before: view(before),
            after: view(want),
            added: {
              roles: change.addRoles,
              sites: change.addSites.map(siteCode),
              warehouses: change.addWarehouses,
            },
            removed: {
              roles: change.removeRoles,
              sites: change.removeSites.map(siteCode),
              warehouses: change.removeWarehouses,
            },
          },
        },
        tx,
      );
    });
    return this.get(userId);
  }

  /** The open role and scope assignments of a user (sorted). */
  private async accessState(tx: Prisma.TransactionClient, userId: string): Promise<AccessState> {
    const roles = await tx.userRole.findMany({
      where: { userId, revokedAt: null },
      select: { roleCode: true },
    });
    const scopes = await tx.userScope.findMany({
      where: { userId, revokedAt: null },
      include: { location: { select: { code: true } } },
    });
    return {
      roles: roles.map((r) => r.roleCode).sort(),
      siteIds: scopes
        .filter((s) => s.type === 'SITE' && s.siteId)
        .map((s) => s.siteId!)
        .sort(),
      warehouseCodes: scopes
        .filter((s) => s.type === 'WAREHOUSE' && s.location)
        .map((s) => s.location!.code)
        .sort(),
    };
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
      await this.removeSiteScope(tx, actor, userId, siteId, reason);
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
      await this.removeWarehouseScope(tx, actor, userId, code, reason);
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
    // Planned system roles are templates only: never newly assigned, whatever the client sends
    // (doc 021 §4c). Every assignment path (user creation, role grant) passes here.
    if (isPlannedRole(code)) {
      throw domainError(
        422,
        'ROLE_NOT_AVAILABLE',
        'This system role is planned for a future module and cannot be assigned yet',
      );
    }
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

  private async removeRole(
    tx: Prisma.TransactionClient,
    actor: Actor,
    user: { id: string; status: string },
    role: RoleCode,
    reason: string,
  ) {
    if (role === 'ADMIN' && user.status === 'ACTIVE') await this.assertNotLastAdmin(tx, user.id);
    const revoked = await tx.userRole.updateMany({
      where: { userId: user.id, roleCode: role, revokedAt: null },
      data: { revokedAt: new Date(), revokedBy: actor.userId, revokeReason: reason },
    });
    if (revoked.count === 0)
      throw domainError(409, 'ROLE_NOT_GRANTED', 'The user does not have this role');
    await this.audit.record(
      {
        type: 'ROLE_REVOKED',
        actorUserId: actor.userId,
        targetUserId: user.id,
        reason,
        payload: { role },
      },
      tx,
    );
  }

  /** Ends access to a site and to every narrower warehouse of it. */
  private async removeSiteScope(
    tx: Prisma.TransactionClient,
    actor: Actor,
    userId: string,
    siteId: string,
    reason: string,
  ) {
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
  }

  private async removeWarehouseScope(
    tx: Prisma.TransactionClient,
    actor: Actor,
    userId: string,
    code: string,
    reason: string,
  ) {
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
    invitations: Parameters<typeof invitationView>[0][];
  }): AdminUserSummary {
    return {
      id: user.id,
      email: user.email,
      displayName: user.displayName,
      status: user.status,
      roles: user.roles.map((r) => ({ code: r.role.code, name: r.role.name })),
      linked: user.identities.length > 0,
      invitationState: invitationView(user.invitations[0] ?? null)?.state ?? null,
      lastLoginAt: user.lastLoginAt?.toISOString() ?? null,
      createdAt: user.createdAt.toISOString(),
    };
  }
}

interface AccessState {
  roles: string[];
  siteIds: string[];
  warehouseCodes: string[];
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
