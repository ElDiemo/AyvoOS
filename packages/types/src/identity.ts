import { z } from 'zod';

/**
 * Identity and access (Milestone 2C, ADR 0022, doc 021). Authentication is delegated to an
 * external OIDC provider; users, roles, permissions and scopes are authoritative in AYVO's
 * database and evaluated by the API on every request. These contracts are shared by API and web.
 */

export const ROLE_CODES = [
  'ADMIN',
  'WAREHOUSE_OPERATOR',
  'WAREHOUSE_SUPERVISOR',
  'PRODUCTION_OPERATOR',
  'PRODUCTION_SUPERVISOR',
  'SALES',
  'FINANCE',
  'HOTEL_USER',
] as const;
export const roleCodeSchema = z.enum(ROLE_CODES);
export type RoleCode = z.infer<typeof roleCodeSchema>;

/**
 * Every permission an API route may require. A route without an explicit permission (or an
 * explicit public/authenticated marker) is refused — deny by default.
 */
export const PERMISSION_CODES = [
  'identity:users_read',
  'identity:users_manage',
  'inventory:read',
  'inventory:stock_summary',
  'inventory:receive',
  'inventory:correct',
  'inventory:items_manage',
  'procurement:suppliers_manage',
  'procurement:cost_read',
  'procurement:documents_read',
  'production:read',
  'production:bottles_create',
  'production:labels_print',
  'production:templates_manage',
  'production:label_apply',
] as const;
export const permissionCodeSchema = z.enum(PERMISSION_CODES);
export type PermissionCode = z.infer<typeof permissionCodeSchema>;

/** Permissions that also require a warehouse scope for the warehouse they act on. */
export const WAREHOUSE_SCOPED_PERMISSIONS: readonly PermissionCode[] = [
  'inventory:read',
  'inventory:stock_summary',
  'inventory:receive',
  'inventory:correct',
  'inventory:items_manage',
  'procurement:suppliers_manage',
  'production:label_apply',
];

export const userStatusSchema = z.enum(['ACTIVE', 'DEACTIVATED']);
export type UserStatus = z.infer<typeof userStatusSchema>;

export const scopeTypeSchema = z.enum(['WAREHOUSE', 'HOTEL_ORGANIZATION', 'HOTEL_SITE']);
export type ScopeType = z.infer<typeof scopeTypeSchema>;

/** Stable, language-neutral codes of authentication and authorization rejections. */
export const AUTH_ERROR_CODES = [
  'UNAUTHENTICATED',
  'SESSION_EXPIRED',
  'ACCOUNT_INACTIVE',
  'FORBIDDEN',
  'CSRF_REJECTED',
] as const;
export type AuthErrorCode = (typeof AUTH_ERROR_CODES)[number];

export const userScopeSchema = z.object({
  id: z.uuid(),
  type: scopeTypeSchema,
  /** WAREHOUSE: inventory location code (e.g. "MAIN"); hotel scopes later. */
  locationCode: z.string().nullable(),
  scopeRef: z.uuid().nullable(),
  grantedAt: z.iso.datetime(),
});
export type UserScope = z.infer<typeof userScopeSchema>;

/** GET /api/auth/me — the signed-in user as the server sees it right now. */
export const currentUserSchema = z.object({
  user: z.object({ id: z.uuid(), email: z.string(), displayName: z.string() }),
  roles: z.array(roleCodeSchema),
  permissions: z.array(permissionCodeSchema),
  scopes: z.array(userScopeSchema),
  session: z.object({ idleExpiresAt: z.iso.datetime(), absoluteExpiresAt: z.iso.datetime() }),
});
export type CurrentUser = z.infer<typeof currentUserSchema>;

export const logoutResponseSchema = z.object({
  /** Where the browser goes next: the provider's logout URL or the AYVO login page. */
  redirectUrl: z.string(),
});

export const reasonSchema = z.string().trim().min(3).max(500);

export const userRoleGrantSchema = z.object({
  role: roleCodeSchema,
  grantedAt: z.iso.datetime(),
  grantedBy: z.string().nullable(),
});

export const adminUserSummarySchema = z.object({
  id: z.uuid(),
  email: z.string(),
  displayName: z.string(),
  status: userStatusSchema,
  roles: z.array(roleCodeSchema),
  linked: z.boolean(),
  lastLoginAt: z.iso.datetime().nullable(),
  createdAt: z.iso.datetime(),
});
export type AdminUserSummary = z.infer<typeof adminUserSummarySchema>;

export const auditEventSchema = z.object({
  id: z.uuid(),
  type: z.string(),
  occurredAt: z.iso.datetime(),
  actor: z.string().nullable(),
  reason: z.string().nullable(),
  details: z.record(z.string(), z.unknown()),
});
export type AuditEvent = z.infer<typeof auditEventSchema>;

export const adminUserDetailSchema = adminUserSummarySchema.extend({
  roleGrants: z.array(userRoleGrantSchema),
  scopes: z.array(userScopeSchema),
  deactivatedAt: z.iso.datetime().nullable(),
  deactivationReason: z.string().nullable(),
  activeSessions: z.number().int(),
  audit: z.array(auditEventSchema),
});
export type AdminUserDetail = z.infer<typeof adminUserDetailSchema>;

export const roleCatalogSchema = z.array(
  z.object({
    code: roleCodeSchema,
    name: z.string(),
    permissions: z.array(permissionCodeSchema),
  }),
);
export type RoleCatalog = z.infer<typeof roleCatalogSchema>;

export const createUserRequestSchema = z.object({
  email: z
    .email()
    .max(254)
    .transform((e) => e.trim().toLowerCase()),
  displayName: z.string().trim().min(1).max(120),
  roles: z.array(roleCodeSchema).max(ROLE_CODES.length),
  warehouseCodes: z.array(z.string().regex(/^[A-Z0-9_-]{1,40}$/)).max(20),
  reason: reasonSchema,
});
export type CreateUserRequest = z.infer<typeof createUserRequestSchema>;

export const roleChangeRequestSchema = z.object({ role: roleCodeSchema, reason: reasonSchema });
export type RoleChangeRequest = z.infer<typeof roleChangeRequestSchema>;

export const warehouseScopeRequestSchema = z.object({
  warehouseCode: z.string().regex(/^[A-Z0-9_-]{1,40}$/),
  reason: reasonSchema,
});
export type WarehouseScopeRequest = z.infer<typeof warehouseScopeRequestSchema>;

export const statusChangeRequestSchema = z.object({ reason: reasonSchema });
export type StatusChangeRequest = z.infer<typeof statusChangeRequestSchema>;
