import type { PrismaClient } from '../generated/prisma/client.js';

export type BootstrapResult =
  | { ok: true; userId: string; email: string }
  | { ok: false; reason: 'ALREADY_BOOTSTRAPPED' | 'ADMIN_EXISTS' | 'USER_EXISTS' };

/**
 * One-time bootstrap of the first administrator (ADR 0022). The database allows a single
 * `identity_bootstrap` row ever, so a second run fails even if this check were bypassed. ADMIN
 * holds every permission through role_permissions; warehouse-scoped permissions still need a
 * warehouse scope, so the first administrator is granted every existing warehouse (as data —
 * the guard evaluates scopes as for any other user).
 */
export function bootstrapFirstAdmin(
  prisma: PrismaClient,
  input: { email: string; displayName: string },
): Promise<BootstrapResult> {
  return prisma.$transaction(async (tx) => {
    if (await tx.identityBootstrap.findFirst())
      return { ok: false, reason: 'ALREADY_BOOTSTRAPPED' };
    if ((await tx.userRole.count({ where: { roleCode: 'ADMIN', revokedAt: null } })) > 0) {
      return { ok: false, reason: 'ADMIN_EXISTS' };
    }
    if (await tx.user.findUnique({ where: { email: input.email } }))
      return { ok: false, reason: 'USER_EXISTS' };
    const user = await tx.user.create({
      data: { email: input.email, displayName: input.displayName },
    });
    await tx.userRole.create({
      data: {
        userId: user.id,
        roleCode: 'ADMIN',
        grantReason: 'Bootstrap of the first administrator',
      },
    });
    // A CLI outside the Nest container: reads the location catalogue directly (read-only).
    const warehouses = await tx.inventoryLocation.findMany({
      select: { id: true, code: true },
      orderBy: { code: 'asc' },
    });
    for (const w of warehouses) {
      await tx.userScope.create({ data: { userId: user.id, type: 'WAREHOUSE', locationId: w.id } });
    }
    await tx.identityBootstrap.create({ data: { userId: user.id, email: user.email } });
    await tx.auditEvent.create({
      data: {
        type: 'ADMIN_BOOTSTRAPPED',
        targetUserId: user.id,
        reason: 'Bootstrap of the first administrator',
        payload: { email: user.email, warehouses: warehouses.map((w) => w.code) },
      },
    });
    return { ok: true, userId: user.id, email: user.email };
  });
}
