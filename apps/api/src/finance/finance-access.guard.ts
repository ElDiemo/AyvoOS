import {
  createParamDecorator,
  Injectable,
  type CanActivate,
  type ExecutionContext,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { FinancePrincipal } from '@ayvo/types';
import type { IncomingMessage } from 'node:http';
import { domainError } from '../common/domain-error.js';
import { ACCESS_METADATA, type AccessRule } from '../identity/access.decorators.js';
import { readCookie, SESSION_COOKIE } from '../identity/cookies.js';
import { CoreClient } from './core-client.js';

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
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    if (context.getType() !== 'http') return false;
    const req = context.switchToHttp().getRequest<FinanceRequest>();
    const rule = this.reflector.getAllAndOverride<AccessRule | undefined>(ACCESS_METADATA, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (!rule || (rule.kind !== 'public' && rule.kind !== 'permission'))
      throw domainError(403, 'FORBIDDEN', 'You do not have permission for this action');
    if (rule.kind === 'public') return true;

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
