import { isPermissionCode, type AccessibleSite, type PermissionCode } from '@ayvo/types';
import { Injectable } from '@nestjs/common';
import { PrismaService } from '../database/prisma.service.js';
import { SitesService, type SiteWithWarehouses } from '../sites/sites.service.js';
import type { Principal, SiteAccess } from './principal.js';

export interface PermissionScope {
  /** Needs the session's active site; its data is filtered by that site. */
  site: boolean;
  /** Also needs access to the active site's warehouse. */
  warehouse: boolean;
  capability: 'WAREHOUSE' | 'PRODUCTION' | 'RETURNS' | null;
}

export type AccessSnapshot = Pick<
  Principal,
  'roles' | 'permissions' | 'globalSiteAccess' | 'sites' | 'activeSite' | 'scopes'
>;

/** The scope rows that decide where a user may act. */
interface ScopeRow {
  type: string;
  siteId: string | null;
  locationId: string | null;
}

/**
 * Where a user may act (doc 022): every site with global access, otherwise the sites of open
 * SITE scopes. Within a site, all its warehouses — unless WAREHOUSE scopes of that site narrow it
 * to those. A warehouse scope without its site scope grants nothing.
 */
export function evaluateSites(
  sites: readonly SiteWithWarehouses[],
  global: boolean,
  scopes: readonly ScopeRow[],
): SiteAccess[] {
  const siteIds = new Set(scopes.flatMap((s) => (s.type === 'SITE' && s.siteId ? [s.siteId] : [])));
  const narrowed = new Set(
    scopes.flatMap((s) => (s.type === 'WAREHOUSE' && s.locationId ? [s.locationId] : [])),
  );
  return sites
    .filter((site) => global || siteIds.has(site.id))
    .map((site) => {
      const own = global ? [] : site.locations.filter((l) => narrowed.has(l.id));
      const all = own.length === 0;
      const warehouses = all ? site.locations : own;
      return {
        id: site.id,
        code: site.code,
        name: site.name,
        countryCode: site.countryCode,
        timeZone: site.timeZone,
        active: site.active,
        capabilities: site.capabilities,
        warehouses: warehouses.map((l) => ({ code: l.code, name: l.name })),
        allWarehouses: all,
        warehouseIds: new Set(warehouses.map((l) => l.id)),
      };
    });
}

/** The client view of a site access (no internal ids). */
export function toAccessibleSite(site: SiteAccess): AccessibleSite {
  return {
    id: site.id,
    code: site.code,
    name: site.name,
    countryCode: site.countryCode,
    timeZone: site.timeZone,
    active: site.active,
    capabilities: site.capabilities,
    warehouses: site.warehouses,
    allWarehouses: site.allWarehouses,
  };
}

/**
 * Current roles, permissions and site access of a user, read from the database on every
 * request — a role, scope or site change applies to the very next request.
 */
@Injectable()
export class AccessService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly sites: SitesService,
  ) {}

  async snapshot(userId: string, sessionSiteId: string | null = null): Promise<AccessSnapshot> {
    const [grants, scopes, allSites] = await Promise.all([
      this.prisma.userRole.findMany({
        where: { userId, revokedAt: null, role: { active: true } },
        select: {
          role: {
            select: {
              code: true,
              name: true,
              permissions: { select: { permissionCode: true } },
            },
          },
        },
        orderBy: { roleCode: 'asc' },
      }),
      this.prisma.userScope.findMany({
        where: { userId, revokedAt: null },
        select: {
          id: true,
          type: true,
          siteId: true,
          locationId: true,
          scopeRef: true,
          grantedAt: true,
          site: { select: { code: true } },
          location: { select: { code: true, siteId: true, site: { select: { code: true } } } },
        },
        orderBy: { grantedAt: 'asc' },
      }),
      this.sites.all(),
    ]);
    // Only codes this version knows: a newer database's codes grant nothing here (rollback).
    const permissions = new Set(
      grants.flatMap((g) =>
        g.role.permissions.map((p) => p.permissionCode).filter(isPermissionCode),
      ),
    );
    const globalSiteAccess = permissions.has('sites:all_access');
    const sites = evaluateSites(allSites, globalSiteAccess, scopes);
    // The session's choice if still allowed; otherwise the only active site, or the only site
    // at all (an inactive one stays readable); with several the user chooses.
    const activeSites = sites.filter((s) => s.active);
    const activeSite =
      sites.find((s) => s.id === sessionSiteId) ??
      (activeSites.length === 1 ? activeSites[0]! : sites.length === 1 ? sites[0]! : null);
    return {
      roles: grants.map((g) => ({ code: g.role.code, name: g.role.name })),
      permissions,
      globalSiteAccess,
      sites,
      activeSite,
      scopes: scopes.map((s) => ({
        id: s.id,
        type: s.type,
        siteId: s.siteId ?? s.location?.siteId ?? null,
        siteCode: s.site?.code ?? s.location?.site.code ?? null,
        locationCode: s.location?.code ?? null,
        scopeRef: s.scopeRef,
        grantedAt: s.grantedAt,
      })),
    };
  }

  /**
   * Where each permission applies (cached: the catalogue changes only by migration): bound to the
   * active site, additionally to its warehouse, and the site capability it needs.
   */
  private scoped: Promise<Map<PermissionCode, PermissionScope>> | null = null;
  permissionScopes(): Promise<Map<PermissionCode, PermissionScope>> {
    this.scoped ??= this.prisma.permission
      .findMany({
        select: { code: true, siteScoped: true, warehouseScoped: true, siteCapability: true },
      })
      .then(
        (rows) =>
          new Map(
            rows.map((r) => [
              r.code as PermissionCode,
              {
                site: r.siteScoped || r.warehouseScoped,
                warehouse: r.warehouseScoped,
                capability: r.siteCapability,
              },
            ]),
          ),
      )
      .catch((error: unknown) => {
        this.scoped = null; // retry on the next request instead of caching a failure
        throw error;
      });
    return this.scoped;
  }
}
