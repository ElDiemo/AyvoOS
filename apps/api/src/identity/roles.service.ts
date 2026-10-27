import {
  isPermissionCode,
  permissionModule,
  type CreateRoleRequest,
  type PermissionCatalog,
  type PermissionCode,
  type Role,
  type RoleCatalog,
  type RoleDetail,
  type UpdateRoleRequest,
} from '@ayvo/types';
import { Injectable } from '@nestjs/common';
import { AuditService } from '../audit/audit.service.js';
import { domainError } from '../common/domain-error.js';
import { PrismaService } from '../database/prisma.service.js';
import type { Prisma } from '../generated/prisma/client.js';
import { assertCanGrant, type Actor } from './users.service.js';

const notFound = () => domainError(404, 'ROLE_NOT_FOUND', 'No such role');

const roleInclude = {
  permissions: { select: { permissionCode: true }, orderBy: { permissionCode: 'asc' } },
  _count: { select: { grants: { where: { revokedAt: null } } } },
} satisfies Prisma.RoleInclude;
type RoleRecord = Prisma.RoleGetPayload<{ include: typeof roleInclude }>;

/**
 * Roles (doc 021 §7a). System roles are protected templates that change only by reviewed
 * migrations; ADMIN (`identity:roles_manage`) creates custom roles from checkboxes, renames,
 * describes, duplicates and deactivates them. A custom role holds exactly the permissions chosen
 * for it — never a security-administration permission, never one added later by a migration
 * unless ADMIN adds it. Every change needs a reason and an audit event, and applies to every
 * holder on their next request.
 */
@Injectable()
export class RolesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async permissions(): Promise<PermissionCatalog> {
    const rows = await this.prisma.permission.findMany({ orderBy: { code: 'asc' } });
    // A newer database may hold codes this version does not know: never offered here.
    return rows
      .filter((p) => isPermissionCode(p.code))
      .map((p) => ({
        code: p.code as PermissionCode,
        description: p.description,
        module: permissionModule(p.code as PermissionCode),
        warehouseScoped: p.warehouseScoped,
        securityAdmin: p.securityAdmin,
      }));
  }

  async catalog(): Promise<RoleCatalog> {
    const roles = await this.prisma.role.findMany({
      include: roleInclude,
      orderBy: [{ isSystem: 'desc' }, { active: 'desc' }, { code: 'asc' }],
    });
    return roles.map(toDto);
  }

  async detail(id: string): Promise<RoleDetail> {
    const role = await this.prisma.role.findUnique({ where: { id }, include: roleInclude });
    if (!role) throw notFound();
    const holders = await this.prisma.userRole.findMany({
      where: { roleCode: role.code, revokedAt: null },
      select: { user: { select: { id: true, email: true, displayName: true } } },
      orderBy: { grantedAt: 'asc' },
    });
    return {
      ...toDto(role),
      holders: holders.map((h) => h.user),
      audit: await this.audit.list({
        type: { in: ['ROLE_CREATED', 'ROLE_UPDATED', 'ROLE_DEACTIVATED', 'ROLE_REACTIVATED'] },
        payload: { path: ['role'], equals: role.code },
      }),
    };
  }

  async create(actor: Actor, input: CreateRoleRequest): Promise<RoleDetail> {
    const id = await this.prisma.$transaction(async (tx) => {
      await this.assertAssignable(tx, actor, input.permissions);
      if (await tx.role.findUnique({ where: { code: input.code } })) {
        throw domainError(409, 'ROLE_EXISTS', 'A role with this code already exists');
      }
      if (input.copiedFrom && !(await tx.role.findUnique({ where: { code: input.copiedFrom } }))) {
        throw domainError(422, 'UNKNOWN_ROLE', 'The role to duplicate does not exist');
      }
      const role = await tx.role.create({
        data: {
          code: input.code,
          name: input.name,
          description: input.description,
          createdBy: actor.userId,
          updatedBy: actor.userId,
        },
      });
      if (input.permissions.length > 0) {
        await tx.rolePermission.createMany({
          data: input.permissions.map((permissionCode) => ({
            roleCode: role.code,
            permissionCode,
          })),
        });
      }
      await this.audit.record(
        {
          type: 'ROLE_CREATED',
          actorUserId: actor.userId,
          reason: input.reason,
          payload: {
            role: role.code,
            name: role.name,
            permissions: [...input.permissions].sort(),
            copiedFrom: input.copiedFrom,
          },
        },
        tx,
      );
      return role.id;
    });
    return this.detail(id);
  }

  async update(actor: Actor, id: string, input: UpdateRoleRequest): Promise<RoleDetail> {
    await this.prisma.$transaction(async (tx) => {
      const role = await this.lockCustom(tx, id);
      await this.assertAssignable(tx, actor, input.permissions);
      const before = new Set(role.permissions.map((p) => p.permissionCode));
      const after = new Set<string>(input.permissions);
      const added = [...after].filter((p) => !before.has(p)).sort();
      // Codes this version does not know (a newer database) are kept as they are: this version
      // can neither show nor grant them, so it never removes them either.
      const removed = [...before].filter((p) => isPermissionCode(p) && !after.has(p)).sort();
      if (removed.length > 0) {
        await tx.rolePermission.deleteMany({
          where: { roleCode: role.code, permissionCode: { in: removed } },
        });
      }
      if (added.length > 0) {
        await tx.rolePermission.createMany({
          data: added.map((permissionCode) => ({ roleCode: role.code, permissionCode })),
        });
      }
      await tx.role.update({
        where: { id },
        data: {
          name: input.name,
          description: input.description,
          updatedBy: actor.userId,
          updatedAt: new Date(),
        },
      });
      await this.audit.record(
        {
          type: 'ROLE_UPDATED',
          actorUserId: actor.userId,
          reason: input.reason,
          payload: {
            role: role.code,
            ...(role.name !== input.name ? { renamedFrom: role.name, name: input.name } : {}),
            added,
            removed,
            holders: role._count.grants,
          },
        },
        tx,
      );
    });
    return this.detail(id);
  }

  /** Refused while users hold the role: they must be reassigned or have it removed first. */
  async deactivate(actor: Actor, id: string, reason: string): Promise<RoleDetail> {
    await this.prisma.$transaction(async (tx) => {
      const role = await this.lockCustom(tx, id);
      if (!role.active) throw domainError(409, 'ROLE_ALREADY_INACTIVE', 'The role is inactive');
      // Lock the open grants so no assignment slips in between the check and the change.
      const holders = await tx.$queryRaw<{ id: string }[]>`
        SELECT "id" FROM "user_roles" WHERE "role_code" = ${role.code} AND "revoked_at" IS NULL
        FOR UPDATE`;
      if (holders.length > 0) {
        throw domainError(
          409,
          'ROLE_IN_USE',
          `${holders.length} user(s) still hold this role; reassign or remove it from them first`,
        );
      }
      await tx.role.update({
        where: { id },
        data: {
          active: false,
          deactivatedAt: new Date(),
          updatedBy: actor.userId,
          updatedAt: new Date(),
        },
      });
      await this.audit.record(
        {
          type: 'ROLE_DEACTIVATED',
          actorUserId: actor.userId,
          reason,
          payload: { role: role.code },
        },
        tx,
      );
    });
    return this.detail(id);
  }

  async reactivate(actor: Actor, id: string, reason: string): Promise<RoleDetail> {
    await this.prisma.$transaction(async (tx) => {
      const role = await this.lockCustom(tx, id);
      if (role.active) throw domainError(409, 'ROLE_ALREADY_ACTIVE', 'The role is active');
      await tx.role.update({
        where: { id },
        data: { active: true, deactivatedAt: null, updatedBy: actor.userId, updatedAt: new Date() },
      });
      await this.audit.record(
        {
          type: 'ROLE_REACTIVATED',
          actorUserId: actor.userId,
          reason,
          payload: { role: role.code },
        },
        tx,
      );
    });
    return this.detail(id);
  }

  /** A custom role, row-locked; system roles are immutable through the application. */
  private async lockCustom(tx: Prisma.TransactionClient, id: string): Promise<RoleRecord> {
    const locked = await tx.$queryRaw<{ id: string }[]>`
      SELECT "id" FROM "roles" WHERE "id" = ${id}::uuid FOR UPDATE`;
    if (!locked[0]) throw notFound();
    const role = await tx.role.findUniqueOrThrow({ where: { id }, include: roleInclude });
    if (role.isSystem) {
      throw domainError(
        409,
        'SYSTEM_ROLE_IMMUTABLE',
        'System roles change only through reviewed code and migrations',
      );
    }
    return role;
  }

  /** Current, non-security permissions the actor holds (no unknown codes, no escalation). */
  private async assertAssignable(
    tx: Prisma.TransactionClient,
    actor: Actor,
    permissions: readonly PermissionCode[],
  ): Promise<void> {
    const rows = await tx.permission.findMany({ where: { code: { in: [...permissions] } } });
    if (rows.length !== new Set(permissions).size) {
      throw domainError(422, 'UNKNOWN_PERMISSION', 'Unknown or obsolete permission');
    }
    const security = rows.filter((p) => p.securityAdmin).map((p) => p.code);
    if (security.length > 0) {
      throw domainError(
        422,
        'SECURITY_PERMISSION_RESERVED',
        `Only the ADMIN system role holds security administration: ${security.join(', ')}`,
      );
    }
    assertCanGrant(actor, permissions);
  }
}

function toDto(role: RoleRecord): Role {
  return {
    id: role.id,
    code: role.code,
    name: role.name,
    description: role.description,
    system: role.isSystem,
    active: role.active,
    permissions: role.permissions.map((p) => p.permissionCode).filter(isPermissionCode),
    assignedUsers: role._count.grants,
    createdAt: role.createdAt.toISOString(),
    updatedAt: role.updatedAt.toISOString(),
  };
}
