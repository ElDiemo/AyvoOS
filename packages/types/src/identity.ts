import { z } from 'zod';

/**
 * Identity and access (Milestone 2C, ADR 0022, doc 021). Authentication is delegated to an
 * external OIDC provider; users, roles, permissions and scopes are authoritative in AYVO's
 * database and evaluated by the API on every request. These contracts are shared by API and web.
 */

/** The protected system roles (seeded and changed only by migration). */
export const SYSTEM_ROLE_CODES = [
  'ADMIN',
  'WAREHOUSE_OPERATOR',
  'WAREHOUSE_SUPERVISOR',
  'PRODUCTION_OPERATOR',
  'PRODUCTION_SUPERVISOR',
  'SALES',
  'FINANCE',
  'HOTEL_USER',
] as const;
/**
 * System roles that are templates for modules that do not exist yet (finance, hotel portfolio
 * and commissions, the external hotel portal; doc 021 §4c). Their records and permission templates
 * stay, but they are **not assignable** now: the API refuses every new assignment and the UI shows
 * them as "Připravuje se". An assignment that already exists is kept (shown, revocable).
 */
export const PLANNED_SYSTEM_ROLE_CODES = ['SALES', 'FINANCE', 'HOTEL_USER'] as const;
export type PlannedSystemRoleCode = (typeof PLANNED_SYSTEM_ROLE_CODES)[number];

/** Whether a role (system or custom) is a planned template that cannot be assigned yet. */
export function isPlannedRole(code: string): code is PlannedSystemRoleCode {
  return (PLANNED_SYSTEM_ROLE_CODES as readonly string[]).includes(code);
}

/** @deprecated use SYSTEM_ROLE_CODES */
export const ROLE_CODES = SYSTEM_ROLE_CODES;
export type SystemRoleCode = (typeof SYSTEM_ROLE_CODES)[number];

/** Any role code: a system role or a custom role created by ADMIN (doc 021 §7a). */
export const roleCodeSchema = z.string().regex(/^[A-Z][A-Z0-9_]{2,39}$/, 'A–Z, 0–9 and _');
export type RoleCode = z.infer<typeof roleCodeSchema>;

/**
 * Every permission an API route may require. A route without an explicit permission (or an
 * explicit public/authenticated marker) is refused — deny by default.
 */
export const PERMISSION_CODES = [
  'identity:users_read',
  'identity:users_manage',
  'identity:roles_manage',
  'sites:manage',
  'sites:all_access',
  'inventory:read',
  'inventory:stock_summary',
  'inventory:receive',
  'inventory:correct',
  'inventory:items_manage',
  'procurement:suppliers_manage',
  'procurement:cost_read',
  'procurement:cost_write',
  'procurement:documents_read',
  'production:read',
  'production:bottles_create',
  'production:labels_print',
  'production:templates_manage',
  'production:label_apply',
  'catalog:read',
  'catalog:product_manage',
  'catalog:recipe_approve',
  'crates:read',
  'crates:register',
] as const;
export const permissionCodeSchema = z.enum(PERMISSION_CODES);
export type PermissionCode = z.infer<typeof permissionCodeSchema>;

/**
 * Security administration: held only by the ADMIN system role, never by a custom role (enforced
 * by the database), so only ADMIN can change roles, users or sites.
 */
export const SECURITY_ADMIN_PERMISSIONS: readonly PermissionCode[] = [
  'identity:users_read',
  'identity:users_manage',
  'identity:roles_manage',
  'sites:manage',
  'sites:all_access',
];

/** Module of a permission (its code prefix) — the checkbox groups of the role editor. */
export const PERMISSION_MODULES = [
  'inventory',
  'procurement',
  'production',
  'catalog',
  'crates',
  'identity',
  'sites',
] as const;
export type PermissionModule = (typeof PERMISSION_MODULES)[number];
export const permissionModule = (code: PermissionCode): PermissionModule =>
  code.split(':')[0] as PermissionModule;

/**
 * Permissions bound to the active site without a warehouse (doc 022): their data is filtered by
 * that site (production series, bottles, print jobs; purchasing values and paperwork).
 */
export const SITE_SCOPED_PERMISSIONS: readonly PermissionCode[] = [
  'procurement:cost_read',
  'procurement:cost_write',
  'procurement:documents_read',
  'production:read',
  'production:bottles_create',
  'production:labels_print',
  'crates:read',
  'crates:register',
];

/** Permissions that also need the active site and access to its warehouse (doc 022). */
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

export const scopeTypeSchema = z.enum(['SITE', 'WAREHOUSE', 'HOTEL_ORGANIZATION', 'HOTEL_SITE']);
export type ScopeType = z.infer<typeof scopeTypeSchema>;

/** Stable, language-neutral codes of authentication and authorization rejections. */
export const AUTH_ERROR_CODES = [
  'UNAUTHENTICATED',
  'SESSION_EXPIRED',
  'ACCOUNT_INACTIVE',
  'FORBIDDEN',
  'CSRF_REJECTED',
  'SITE_REQUIRED',
  'SITE_FORBIDDEN',
  'SITE_INACTIVE',
  'SITE_WITHOUT_WAREHOUSE',
  'SITE_WITHOUT_PRODUCTION',
  'AUTH_UNAVAILABLE',
  'RATE_LIMITED',
] as const;
export type AuthErrorCode = (typeof AUTH_ERROR_CODES)[number];

export const userScopeSchema = z.object({
  id: z.uuid(),
  type: scopeTypeSchema,
  /** SITE: the site; WAREHOUSE: the site of the warehouse. */
  siteId: z.uuid().nullable(),
  siteCode: z.string().nullable(),
  /** WAREHOUSE: inventory location code (e.g. "MAIN"); hotel scopes later. */
  locationCode: z.string().nullable(),
  scopeRef: z.uuid().nullable(),
  grantedAt: z.iso.datetime(),
});
export type UserScope = z.infer<typeof userScopeSchema>;

/** A site as a signed-in user sees it (selection, shell). */
export const accessibleSiteSchema = z.object({
  id: z.uuid(),
  code: z.string(),
  name: z.string(),
  countryCode: z.string(),
  timeZone: z.string(),
  active: z.boolean(),
  capabilities: z.array(z.enum(['WAREHOUSE', 'PRODUCTION', 'RETURNS'])),
  /** The warehouses of this site the user may act on (all of them unless narrowed). */
  warehouses: z.array(z.object({ code: z.string(), name: z.string() })),
  allWarehouses: z.boolean(),
});
export type AccessibleSite = z.infer<typeof accessibleSiteSchema>;

/** GET /api/auth/me — the signed-in user as the server sees it right now. */
export const currentUserSchema = z.object({
  user: z.object({ id: z.uuid(), email: z.string(), displayName: z.string() }),
  roles: z.array(z.object({ code: roleCodeSchema, name: z.string() })),
  permissions: z.array(permissionCodeSchema),
  scopes: z.array(userScopeSchema),
  /** Every site the user may access (all sites for global access). */
  sites: z.array(accessibleSiteSchema),
  /** The site this session works at; null when several are possible and none is chosen. */
  activeSiteId: z.uuid().nullable(),
  /** Global site access (ADMIN: `sites:all_access`), evaluated explicitly by the server. */
  globalSiteAccess: z.boolean(),
  session: z.object({ idleExpiresAt: z.iso.datetime(), absoluteExpiresAt: z.iso.datetime() }),
});
export type CurrentUser = z.infer<typeof currentUserSchema>;

/** POST /api/auth/active-site — validated against the user's sites on the server. */
export const activeSiteRequestSchema = z.object({ siteId: z.uuid() });
export type ActiveSiteRequest = z.infer<typeof activeSiteRequestSchema>;

export const logoutResponseSchema = z.object({
  /** Where the browser goes next: the provider's logout URL or the AYVO login page. */
  redirectUrl: z.string(),
});

export const reasonSchema = z.string().trim().min(3).max(500);

export const userRoleGrantSchema = z.object({
  role: roleCodeSchema,
  name: z.string(),
  system: z.boolean(),
  grantedAt: z.iso.datetime(),
  grantedBy: z.string().nullable(),
});

export const roleRefSchema = z.object({ code: roleCodeSchema, name: z.string() });

/** Invitation states (doc 021 §7b); a pending invitation past its expiry is shown as EXPIRED. */
export const invitationStateSchema = z.enum([
  'SENDING',
  'PENDING',
  'ACCEPTED',
  'EXPIRED',
  'REVOKED',
  'FAILED',
]);
export type InvitationState = z.infer<typeof invitationStateSchema>;

/** What an administrator sees of an invitation — never its token or link. */
export const userInvitationViewSchema = z.object({
  state: invitationStateSchema,
  expiresAt: z.iso.datetime().nullable(),
  sentAt: z.iso.datetime().nullable(),
  acceptedAt: z.iso.datetime().nullable(),
  revokedAt: z.iso.datetime().nullable(),
  failureCode: z.string().nullable(),
});
export type UserInvitationView = z.infer<typeof userInvitationViewSchema>;

/** POST …/users/:id/invitations{,/resend,/revoke} — idempotent per request id. */
export const invitationActionRequestSchema = z.object({
  requestId: z.uuid(),
  reason: reasonSchema,
});
export type InvitationActionRequest = z.infer<typeof invitationActionRequestSchema>;

export const adminUserSummarySchema = z.object({
  id: z.uuid(),
  email: z.string(),
  displayName: z.string(),
  status: userStatusSchema,
  roles: z.array(roleRefSchema),
  linked: z.boolean(),
  /** State of the latest invitation (null: none — e.g. the bootstrap administrator). */
  invitationState: invitationStateSchema.nullable(),
  lastLoginAt: z.iso.datetime().nullable(),
  createdAt: z.iso.datetime(),
});
export type AdminUserSummary = z.infer<typeof adminUserSummarySchema>;

export const auditEventSchema = z.object({
  id: z.uuid(),
  type: z.string(),
  occurredAt: z.iso.datetime(),
  actor: z.string().nullable(),
  site: z.string().nullable(),
  reason: z.string().nullable(),
  details: z.record(z.string(), z.unknown()),
});
export type AuditEvent = z.infer<typeof auditEventSchema>;

/** What a user may do and where (the administration's effective-access preview). */
export const effectiveAccessSchema = z.object({
  permissions: z.array(permissionCodeSchema),
  globalSiteAccess: z.boolean(),
  sites: z.array(accessibleSiteSchema),
});
export type EffectiveAccess = z.infer<typeof effectiveAccessSchema>;

export const adminUserDetailSchema = adminUserSummarySchema.extend({
  invitation: userInvitationViewSchema.nullable(),
  roleGrants: z.array(userRoleGrantSchema),
  scopes: z.array(userScopeSchema),
  effectiveAccess: effectiveAccessSchema,
  deactivatedAt: z.iso.datetime().nullable(),
  deactivationReason: z.string().nullable(),
  activeSessions: z.number().int(),
  audit: z.array(auditEventSchema),
});
export type AdminUserDetail = z.infer<typeof adminUserDetailSchema>;

export const roleSchema = z.object({
  id: z.uuid(),
  code: roleCodeSchema,
  name: z.string(),
  description: z.string(),
  system: z.boolean(),
  active: z.boolean(),
  permissions: z.array(permissionCodeSchema),
  /** Users holding the role now. */
  assignedUsers: z.number().int(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});
export type Role = z.infer<typeof roleSchema>;
export const roleCatalogSchema = z.array(roleSchema);
export type RoleCatalog = z.infer<typeof roleCatalogSchema>;

export const roleDetailSchema = roleSchema.extend({
  holders: z.array(z.object({ id: z.uuid(), email: z.string(), displayName: z.string() })),
  audit: z.array(auditEventSchema),
});
export type RoleDetail = z.infer<typeof roleDetailSchema>;

/** GET /api/admin/identity/permissions — the catalogue the role editor offers. */
export const permissionCatalogSchema = z.array(
  z.object({
    code: permissionCodeSchema,
    description: z.string(),
    module: z.enum(PERMISSION_MODULES),
    warehouseScoped: z.boolean(),
    securityAdmin: z.boolean(),
  }),
);
export type PermissionCatalog = z.infer<typeof permissionCatalogSchema>;

const rolePermissionsSchema = z
  .array(permissionCodeSchema)
  .max(PERMISSION_CODES.length)
  .refine((p) => new Set(p).size === p.length, 'Duplicate permission');

/** POST /api/admin/identity/roles — a custom role (security permissions are refused). */
export const createRoleRequestSchema = z.object({
  code: roleCodeSchema,
  name: z.string().trim().min(1).max(80),
  description: z.string().trim().max(500),
  permissions: rolePermissionsSchema,
  /** The role this one was duplicated from (recorded in the audit). */
  copiedFrom: roleCodeSchema.nullable().default(null),
  reason: reasonSchema,
});
export type CreateRoleRequest = z.infer<typeof createRoleRequestSchema>;

/** POST /api/admin/identity/roles/:id — rename, describe and choose permissions (custom only). */
export const updateRoleRequestSchema = z.object({
  name: z.string().trim().min(1).max(80),
  description: z.string().trim().max(500),
  permissions: rolePermissionsSchema,
  reason: reasonSchema,
});
export type UpdateRoleRequest = z.infer<typeof updateRoleRequestSchema>;

export const createUserRequestSchema = z.object({
  // Normalized (trimmed, lower-case) before it is validated, stored or sent to the provider.
  email: z.string().trim().toLowerCase().pipe(z.email().max(254)),
  displayName: z.string().trim().min(1).max(120),
  roles: z.array(roleCodeSchema).max(50),
  /** Sites the user may access; warehouses may narrow a site (they must belong to listed sites). */
  siteIds: z.array(z.uuid()).max(50).default([]),
  warehouseCodes: z.array(z.string().regex(/^[A-Z0-9_-]{1,40}$/)).max(20),
  reason: reasonSchema,
});
export type CreateUserRequest = z.infer<typeof createUserRequestSchema>;

export const roleChangeRequestSchema = z.object({ role: roleCodeSchema, reason: reasonSchema });
export type RoleChangeRequest = z.infer<typeof roleChangeRequestSchema>;

/** GET /api/admin/identity/sites — sites and their warehouses for assigning access. */
export const assignableSitesSchema = z.array(
  z.object({
    id: z.uuid(),
    code: z.string(),
    name: z.string(),
    active: z.boolean(),
    warehouses: z.array(z.object({ code: z.string(), name: z.string() })),
  }),
);
export type AssignableSites = z.infer<typeof assignableSitesSchema>;

const uniqueList = <T extends z.ZodType>(item: T, max: number) =>
  z
    .array(item)
    .max(max)
    .refine((l) => new Set(l).size === l.length, 'Duplicate entry');

/**
 * POST /api/admin/identity/users/:id/access — the user's complete new access (roles, sites,
 * narrower warehouses), applied atomically: everything or nothing, one reason, idempotent per
 * `requestId` for this user, audited with the previous and the new state (doc 021 §7).
 */
export const updateUserAccessRequestSchema = z.object({
  requestId: z.uuid(),
  roles: uniqueList(roleCodeSchema, 50),
  siteIds: uniqueList(z.uuid(), 50),
  /** Each narrows one of `siteIds`; none for a site = all warehouses of that site. */
  warehouseCodes: uniqueList(z.string().regex(/^[A-Z0-9_-]{1,40}$/), 20),
  reason: reasonSchema,
});
export type UpdateUserAccessRequest = z.infer<typeof updateUserAccessRequestSchema>;

export const siteScopeRequestSchema = z.object({ siteId: z.uuid(), reason: reasonSchema });
export type SiteScopeRequest = z.infer<typeof siteScopeRequestSchema>;

export const warehouseScopeRequestSchema = z.object({
  warehouseCode: z.string().regex(/^[A-Z0-9_-]{1,40}$/),
  reason: reasonSchema,
});
export type WarehouseScopeRequest = z.infer<typeof warehouseScopeRequestSchema>;

export const statusChangeRequestSchema = z.object({ reason: reasonSchema });
export type StatusChangeRequest = z.infer<typeof statusChangeRequestSchema>;
