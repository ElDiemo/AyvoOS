import {
  createParamDecorator,
  Inject,
  Injectable,
  Logger,
  type CanActivate,
  type ExecutionContext,
} from '@nestjs/common';
import { API_BASE_PATH } from '@ayvo/types';
import { Reflector } from '@nestjs/core';
import { ENV, type Env } from '../config/env.js';
import { domainError } from '../common/domain-error.js';
import { InventoryService } from '../inventory/inventory.service.js';
import type { SiteContext, WarehouseContext } from '../inventory/warehouse-context.js';
import { ACCESS_METADATA, type AccessRule } from './access.decorators.js';
import { AccessService } from './access.service.js';
import type { Principal, RequestWithPrincipal } from './principal.js';
import { PrincipalResolver } from './principal-resolver.js';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

export const unauthenticated = () => domainError(401, 'UNAUTHENTICATED', 'Sign-in is required');
export const sessionExpired = () =>
  domainError(401, 'SESSION_EXPIRED', 'The session has expired; sign in again');
export const accountInactive = () =>
  domainError(403, 'ACCOUNT_INACTIVE', 'This account is not active');
export const forbidden = () =>
  domainError(403, 'FORBIDDEN', 'You do not have permission for this action');
const siteRequired = () =>
  domainError(403, 'SITE_REQUIRED', 'Choose the site you are working at first');
const siteInactive = () =>
  domainError(409, 'SITE_INACTIVE', 'The site is inactive: its history can be read, not changed');
const siteWithoutWarehouse = () =>
  domainError(409, 'SITE_WITHOUT_WAREHOUSE', 'The active site has no warehouse');
const siteWithoutProduction = () =>
  domainError(409, 'SITE_WITHOUT_PRODUCTION', 'The active site does not produce');

/**
 * Global access guard (ADR 0022) — deny by default. Every route must declare @Public(),
 * @Authenticated() or @RequirePermission(...); a route without a declaration is refused (and
 * logged). State-changing requests from another origin are refused (CSRF defence in depth on top
 * of SameSite cookies). Permissions and scopes are evaluated from the database on each request.
 *
 * Site- and warehouse-scoped permissions (doc 022) need the session's active site — validated
 * against the user's site scopes (or the explicit global access of `sites:all_access`) — with the
 * capability the permission needs; warehouse-scoped ones also access to that site's warehouse; an
 * inactive site is read-only. A site or warehouse named anywhere in the
 * request (URL, query, body, cookie, header) is never trusted: the guard resolves the warehouse
 * itself and hands it to the handler (`@OperationalWarehouse()`).
 */
@Injectable()
export class AccessGuard implements CanActivate {
  private readonly logger = new Logger(AccessGuard.name);

  constructor(
    private readonly reflector: Reflector,
    private readonly resolver: PrincipalResolver,
    private readonly access: AccessService,
    private readonly inventory: InventoryService,
    @Inject(ENV) private readonly env: Env,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    if (context.getType() !== 'http') return false;
    const req = context.switchToHttp().getRequest<RequestWithPrincipal>();
    const rule = this.reflector.getAllAndOverride<AccessRule | undefined>(ACCESS_METADATA, [
      context.getHandler(),
      context.getClass(),
    ]);

    if (!SAFE_METHODS.has(req.method ?? 'GET') && !this.sameOrigin(req)) {
      throw domainError(403, 'CSRF_REJECTED', 'Cross-site request refused');
    }
    if (!rule) {
      this.logger.error(
        `Route ${context.getClass().name}.${context.getHandler().name} declares no access rule — refused`,
      );
      throw forbidden();
    }
    if (rule.kind === 'public') return true;
    if (rule.kind === 'agent') {
      // Machine routes live only under /api/agent/; their own guard checks the agent's token.
      if (!(req.url ?? '').startsWith(`${API_BASE_PATH}/agent/`)) throw forbidden();
      return true;
    }

    const resolution = await this.resolver.resolve(req);
    if (resolution.kind === 'anonymous') throw unauthenticated();
    if (resolution.kind === 'expired') throw sessionExpired();
    if (resolution.kind === 'inactive') throw accountInactive();
    const principal = resolution.principal;
    req.ayvoPrincipal = principal;
    if (rule.kind === 'authenticated') return true;

    if (!rule.permissions.every((p) => principal.permissions.has(p))) throw forbidden();
    const scopes = await this.access.permissionScopes();
    const required = rule.permissions.map((p) => scopes.get(p));
    if (required.some((x) => x?.site)) {
      const site = principal.activeSite;
      if (!site) throw siteRequired();
      for (const capability of new Set(required.flatMap((x) => x?.capability ?? []))) {
        if (!site.capabilities.includes(capability)) {
          throw capability === 'WAREHOUSE' ? siteWithoutWarehouse() : siteWithoutProduction();
        }
      }
      if (!SAFE_METHODS.has(req.method ?? 'GET') && !site.active) throw siteInactive();
      req.ayvoSite = { siteId: site.id, siteCode: site.code };
      if (required.some((x) => x?.warehouse)) {
        // v0.1: a site's warehouse operations act on its default warehouse (doc 022 §2).
        const warehouse = await this.inventory.siteDefaultLocation(site.id);
        if (!warehouse) throw siteWithoutWarehouse();
        if (!site.warehouseIds.has(warehouse.id)) throw forbidden();
        req.ayvoWarehouse = {
          siteId: site.id,
          siteCode: site.code,
          locationId: warehouse.id,
          locationCode: warehouse.code,
        };
      }
    }
    return true;
  }

  /** Browsers send Origin / Sec-Fetch-Site on state-changing requests; other clients send none. */
  private sameOrigin(req: RequestWithPrincipal): boolean {
    const site = req.headers['sec-fetch-site'];
    if (typeof site === 'string' && site !== 'same-origin' && site !== 'none') return false;
    const origin = req.headers.origin;
    if (typeof origin === 'string' && origin !== this.env.APP_PUBLIC_ORIGIN) return false;
    return true;
  }
}

/** The principal of the current request (only on @Authenticated / @RequirePermission routes). */
export const CurrentPrincipal = createParamDecorator(
  (_data: unknown, context: ExecutionContext): Principal => {
    const principal = context.switchToHttp().getRequest<RequestWithPrincipal>().ayvoPrincipal;
    if (!principal) throw unauthenticated();
    return principal;
  },
);

/** The warehouse the guard authorized for this request (warehouse-scoped routes only). */
export const OperationalWarehouse = createParamDecorator(
  (_data: unknown, context: ExecutionContext): WarehouseContext => {
    const warehouse = context.switchToHttp().getRequest<RequestWithPrincipal>().ayvoWarehouse;
    // A route using this without a warehouse-scoped permission is a programming error: refuse.
    if (!warehouse) throw forbidden();
    return warehouse;
  },
);

/** The site the guard authorized for this request (site- or warehouse-scoped routes only). */
export const OperationalSite = createParamDecorator(
  (_data: unknown, context: ExecutionContext): SiteContext => {
    const site = context.switchToHttp().getRequest<RequestWithPrincipal>().ayvoSite;
    if (!site) throw forbidden();
    return site;
  },
);
