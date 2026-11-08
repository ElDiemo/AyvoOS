import { createHash, timingSafeEqual } from 'node:crypto';
import {
  createParamDecorator,
  Inject,
  Injectable,
  type CanActivate,
  type ExecutionContext,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { API_BASE_PATH, type FinancePrincipal } from '@ayvo/types';
import type { IncomingMessage } from 'node:http';
import { domainError } from '../common/domain-error.js';
import { ACCESS_METADATA, type AccessRule } from '../identity/access.decorators.js';
import { readCookie, SESSION_COOKIE } from '../identity/cookies.js';
import { CoreClient } from './core-client.js';
import { FINANCE_ENV, type FinanceEnv } from './finance-env.js';

/** `Authorization: Bearer <token>` whose SHA-256 is the configured one (constant time). */
function portalTokenValid(req: IncomingMessage, expected: string | undefined): boolean {
  const header = req.headers.authorization;
  if (!expected || typeof header !== 'string' || !header.startsWith('Bearer ')) return false;
  const given = createHash('sha256').update(header.slice('Bearer '.length)).digest();
  return timingSafeEqual(given, Buffer.from(expected, 'hex'));
}

/** Who a Finance request acts for: the core's answer for this request + the session to forward. */
export interface FinanceCaller {
  principal: FinancePrincipal;
  sessionToken: string;
}
type FinanceRequest = IncomingMessage & { financeCaller?: FinanceCaller };

const header = (req: IncomingMessage, name: string) => {
  const v = req.headers[name];
  return typeof v === 'string' ? v : null;
};

/**
 * The Finance unit's global guard (ADR 0039 §4) — deny by default, like the core's. Every route
 * declares @Public() (health only) or @RequirePermission(...). For a protected route the user is
 * resolved by the core on THIS request from the session cookie (current roles, permissions,
 * revocation, the core's CSRF rule on the method/origin); Finance never decodes the cookie and
 * never trusts a user id from the request. Core unavailable → 503, never access.
 */
@Injectable()
export class FinanceAccessGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly core: CoreClient,
    @Inject(FINANCE_ENV) private readonly env: FinanceEnv,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    if (context.getType() !== 'http') return false;
    const req = context.switchToHttp().getRequest<FinanceRequest>();
    const rule = this.reflector.getAllAndOverride<AccessRule | undefined>(ACCESS_METADATA, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (
      !rule ||
      (rule.kind !== 'public' && rule.kind !== 'permission' && rule.kind !== 'portal-service')
    )
      throw domainError(403, 'FORBIDDEN', 'You do not have permission for this action');
    if (rule.kind === 'public') return true;
    if (rule.kind === 'portal-service') {
      // Hotel portal invoices (ADR 0045 §6): only portal-web's token, only under its prefix. The
      // route introspects the forwarded portal session at the core itself; no staff principal.
      if (!(req.url ?? '').startsWith(`${API_BASE_PATH}/internal/v1/portal/`))
        throw domainError(403, 'FORBIDDEN', 'You do not have permission for this action');
      if (!portalTokenValid(req, this.env.PORTAL_FINANCE_TOKEN_SHA256))
        throw domainError(401, 'SERVICE_UNAUTHENTICATED', 'Unknown service');
      return true;
    }

    const sessionToken = readCookie(req, SESSION_COOKIE);
    if (!sessionToken) throw domainError(401, 'UNAUTHENTICATED', 'Sign-in is required');
    const principal = await this.core.principal(sessionToken, {
      method: req.method ?? 'GET',
      origin: header(req, 'origin'),
      secFetchSite: header(req, 'sec-fetch-site'),
    });
    if (!rule.permissions.every((p) => principal.permissions.includes(p)))
      throw domainError(403, 'FORBIDDEN', 'You do not have permission for this action');
    req.financeCaller = { principal, sessionToken };
    return true;
  }
}

/** The caller of a protected Finance route (set by FinanceAccessGuard). */
export const Caller = createParamDecorator((_: unknown, ctx: ExecutionContext): FinanceCaller => {
  const caller = ctx.switchToHttp().getRequest<FinanceRequest>().financeCaller;
  if (!caller) throw new Error('Caller used on a route without FinanceAccessGuard');
  return caller;
});
