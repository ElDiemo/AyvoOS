import type { PermissionCode, RoleCode } from '@ayvo/types';
import { Injectable } from '@nestjs/common';
import { PrismaService } from '../database/prisma.service.js';

export interface AccessSnapshot {
  roles: RoleCode[];
  permissions: Set<PermissionCode>;
  warehouseIds: Set<string>;
  scopes: {
    id: string;
    type: string;
    locationCode: string | null;
    scopeRef: string | null;
    grantedAt: Date;
  }[];
}

/**
 * Current roles, permissions and scopes of a user, read from the database on every request —
 * a role change or deactivation applies to the very next request, not when a session renews.
 */
@Injectable()
export class AccessService {
  constructor(private readonly prisma: PrismaService) {}

  async snapshot(userId: string): Promise<AccessSnapshot> {
    const [grants, scopes] = await Promise.all([
      this.prisma.userRole.findMany({
        where: { userId, revokedAt: null },
        select: {
          roleCode: true,
          role: { select: { permissions: { select: { permissionCode: true } } } },
        },
        orderBy: { roleCode: 'asc' },
      }),
      this.prisma.userScope.findMany({
        where: { userId, revokedAt: null },
        select: {
          id: true,
          type: true,
          locationId: true,
          scopeRef: true,
          grantedAt: true,
          location: { select: { code: true } },
        },
        orderBy: { grantedAt: 'asc' },
      }),
    ]);
    return {
      roles: grants.map((g) => g.roleCode as RoleCode),
      permissions: new Set(
        grants.flatMap((g) => g.role.permissions.map((p) => p.permissionCode as PermissionCode)),
      ),
      warehouseIds: new Set(
        scopes.flatMap((s) => (s.type === 'WAREHOUSE' && s.locationId ? [s.locationId] : [])),
      ),
      scopes: scopes.map((s) => ({
        id: s.id,
        type: s.type,
        locationCode: s.location?.code ?? null,
        scopeRef: s.scopeRef,
        grantedAt: s.grantedAt,
      })),
    };
  }

  /** Which catalogue permissions need a warehouse scope (cached: the catalogue changes only by migration). */
  private scoped: Promise<Set<PermissionCode>> | null = null;
  warehouseScopedPermissions(): Promise<Set<PermissionCode>> {
    this.scoped ??= this.prisma.permission
      .findMany({ where: { warehouseScoped: true }, select: { code: true } })
      .then((rows) => new Set(rows.map((r) => r.code as PermissionCode)))
      .catch((error: unknown) => {
        this.scoped = null; // retry on the next request instead of caching a failure
        throw error;
      });
    return this.scoped;
  }
}
