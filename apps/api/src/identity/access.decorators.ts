import type { PermissionCode } from '@ayvo/types';
import { SetMetadata } from '@nestjs/common';

export const ACCESS_METADATA = 'ayvo:access';

export type AccessRule =
  | { kind: 'public' }
  | { kind: 'authenticated' }
  | { kind: 'permission'; permissions: readonly PermissionCode[] }
  /**
   * A print agent (ADR 0028) — a machine, never a user. Declared only through
   * `@PrintAgentAccess()` (printing module), which also attaches the guard that checks the agent's
   * token; the global guard allows this rule only under `/api/agent/`.
   */
  | { kind: 'agent' }
  /**
   * Another AYVO runtime unit calling the core's internal contract (ADR 0039) — on behalf of a
   * user. Declared only through `@ServiceAccess()`; the global guard allows it only under
   * `/api/internal/`, verifies the service token of that audience, and resolves the user from the
   * forwarded session token exactly like a browser request (current roles, scopes, revocation).
   */
  | { kind: 'service'; audience: 'finance' }
  /**
   * portal-web calling the core's hotel portal contract (ADR 0045 §3, §6) — a machine with its
   * own token, acting for an anonymous browser or a PORTAL session it forwards. Declared only
   * through `@PortalServiceAccess()`; the global guard allows it only under
   * `/api/internal/v1/portal/` and only with the portal token. No staff principal is ever
   * resolved; the contract checks the forwarded portal session itself, as PORTAL.
   */
  | { kind: 'portal-service' }
  /**
   * Finance introspecting a hotel portal session (ADR 0045 §5): Finance's token only, only under
   * `/api/internal/v1/finance/`; no staff principal. The route checks the forwarded PORTAL session
   * itself. Declared only through `@FinancePortalAccess()`.
   */
  | { kind: 'finance-portal' };

/** Anonymous access (bottle passport, health, login). Use sparingly. */
export const Public = () => SetMetadata(ACCESS_METADATA, { kind: 'public' } satisfies AccessRule);

/** Any signed-in, active user (own profile, logout). */
export const Authenticated = () =>
  SetMetadata(ACCESS_METADATA, { kind: 'authenticated' } satisfies AccessRule);

/**
 * The signed-in user must hold ALL listed permissions (and the warehouse scope where the
 * permission is warehouse-scoped). Every protected route declares this explicitly.
 */
export const RequirePermission = (...permissions: [PermissionCode, ...PermissionCode[]]) =>
  SetMetadata(ACCESS_METADATA, { kind: 'permission', permissions } satisfies AccessRule);

/** The core's internal contract for one runtime unit (ADR 0039): service token + user session. */
export const ServiceAccess = (audience: 'finance') =>
  SetMetadata(ACCESS_METADATA, { kind: 'service', audience } satisfies AccessRule);

/** The hotel portal contract (ADR 0045): portal-web's token only; the portal session is checked by the route. */
export const PortalServiceAccess = () =>
  SetMetadata(ACCESS_METADATA, { kind: 'portal-service' } satisfies AccessRule);

/** Finance asking what a hotel portal session may see (ADR 0045 §5): Finance's token only. */
export const FinancePortalAccess = () =>
  SetMetadata(ACCESS_METADATA, { kind: 'finance-portal' } satisfies AccessRule);
