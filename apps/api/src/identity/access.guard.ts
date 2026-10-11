import {
  createParamDecorator,
  Inject,
  Injectable,
  Logger,
  type CanActivate,
  type ExecutionContext,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ENV, type Env } from '../config/env.js';
import { domainError } from '../common/domain-error.js';
import { InventoryService } from '../inventory/inventory.service.js';
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

/**
 * Global access guard (ADR 0022) — deny by default. Every route must declare @Public(),
 * @Authenticated() or @RequirePermission(...); a route without a declaration is refused (and
 * logged). State-changing requests from another origin are refused (CSRF defence in depth on top
 * of SameSite cookies). Permissions and scopes are evaluated from the database on each request.
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

    const resolution = await this.resolver.resolve(req);
    if (resolution.kind === 'anonymous') throw unauthenticated();
    if (resolution.kind === 'expired') throw sessionExpired();
    if (resolution.kind === 'inactive') throw accountInactive();
    const principal = resolution.principal;
    req.ayvoPrincipal = principal;
    if (rule.kind === 'authenticated') return true;

    if (!rule.permissions.every((p) => principal.permissions.has(p))) throw forbidden();
    const scoped = await this.access.warehouseScopedPermissions();
    if (rule.permissions.some((p) => scoped.has(p))) {
      // Today every warehouse operation acts on the main location (doc 018); later the request
      // names its warehouse and is checked against the same scope set.
      const main = await this.inventory.mainLocation();
      if (!principal.warehouseIds.has(main.id)) throw forbidden();
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
