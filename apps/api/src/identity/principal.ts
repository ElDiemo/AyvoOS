import type { PermissionCode, RoleCode } from '@ayvo/types';
import type { IncomingMessage } from 'node:http';

/** The authenticated user of one request, loaded from AYVO's database (never from headers). */
export interface Principal {
  userId: string;
  email: string;
  displayName: string;
  sessionId: string;
  roles: RoleCode[];
  permissions: Set<PermissionCode>;
  /** Inventory location ids the user may act on. */
  warehouseIds: Set<string>;
  scopes: {
    id: string;
    type: string;
    locationCode: string | null;
    scopeRef: string | null;
    grantedAt: Date;
  }[];
  idleExpiresAt: Date;
  absoluteExpiresAt: Date;
}

export type RequestWithPrincipal = IncomingMessage & { ayvoPrincipal?: Principal };
