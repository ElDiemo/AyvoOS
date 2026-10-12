import type { AccessibleSite, PermissionCode, RoleCode } from '@ayvo/types';
import type { IncomingMessage } from 'node:http';
import type { WarehouseContext } from '../inventory/warehouse-context.js';

/** One site the principal may access, with the warehouse ids it may act on there. */
export interface SiteAccess extends AccessibleSite {
  warehouseIds: Set<string>;
}

/** The authenticated user of one request, loaded from AYVO's database (never from headers). */
export interface Principal {
  userId: string;
  email: string;
  displayName: string;
  sessionId: string;
  /** Active roles only (an inactive custom role grants nothing). */
  roles: { code: RoleCode; name: string }[];
  permissions: Set<PermissionCode>;
  /** `sites:all_access` — every site and warehouse, evaluated explicitly (doc 022). */
  globalSiteAccess: boolean;
  /** Every site the user may access, with its permitted warehouses. */
  sites: SiteAccess[];
  /** The session's validated active site (null: none chosen while several are possible). */
  activeSite: SiteAccess | null;
  scopes: {
    id: string;
    type: string;
    siteId: string | null;
    siteCode: string | null;
    locationCode: string | null;
    scopeRef: string | null;
    grantedAt: Date;
  }[];
  idleExpiresAt: Date;
  absoluteExpiresAt: Date;
}

export type RequestWithPrincipal = IncomingMessage & {
  ayvoPrincipal?: Principal;
  /** Set by the guard on warehouse-scoped routes: where the request acts. */
  ayvoWarehouse?: WarehouseContext;
};
