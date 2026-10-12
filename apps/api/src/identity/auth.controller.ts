import { activeSiteRequestSchema, type ActiveSiteRequest, type CurrentUser } from '@ayvo/types';
import {
  Body,
  Controller,
  Get,
  HttpCode,
  Inject,
  NotFoundException,
  Post,
  Query,
  Req,
  Res,
} from '@nestjs/common';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { AuditService } from '../audit/audit.service.js';
import { domainError } from '../common/domain-error.js';
import { ZodValidationPipe } from '../common/zod-validation.pipe.js';
import { ENV, type Env } from '../config/env.js';
import { Authenticated, Public } from './access.decorators.js';
import { CurrentPrincipal } from './access.guard.js';
import { AuthRateLimitService, type RateDecision } from './auth-rate-limit.service.js';
import { AuthService } from './auth.service.js';
import {
  clearCookie,
  LOGIN_BINDING_COOKIE,
  readCookie,
  serializeCookie,
  SESSION_COOKIE,
} from './cookies.js';
import { IDENTITY_PROVIDER, type IdentityProvider } from './identity-provider.js';
import { toAccessibleSite } from './access.service.js';
import type { Principal } from './principal.js';
import { SessionsService } from './sessions.service.js';
import { TestIdentityProvider } from './test.provider.js';

function redirect(res: ServerResponse, location: string, cookies: string[] = []): void {
  res.statusCode = 302;
  res.setHeader('Location', location);
  res.setHeader('Cache-Control', 'no-store');
  if (cookies.length > 0) res.setHeader('Set-Cookie', cookies);
  res.end();
}

/**
 * 429 for a rate-limited sign-in route: a short Czech page for a browser navigation, a stable JSON
 * error otherwise. Nothing about the limit's configuration or the client is revealed.
 */
function tooManyRequests(req: IncomingMessage, res: ServerResponse, decision: RateDecision): void {
  res.statusCode = 429;
  res.setHeader('Retry-After', String(decision.retryAfterSeconds));
  res.setHeader('Cache-Control', 'no-store');
  if ((req.headers.accept ?? '').includes('text/html')) {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'");
    res.end(
      '<!doctype html><html lang="cs"><meta charset="utf-8">' +
        '<meta name="viewport" content="width=device-width, initial-scale=1">' +
        '<title>Příliš mnoho pokusů – AYVO OS</title>' +
        '<body style="font-family:system-ui,sans-serif;max-width:32rem;margin:4rem auto;padding:0 1rem">' +
        '<h1>Příliš mnoho pokusů o přihlášení</h1>' +
        '<p>Z tohoto připojení přišlo v krátké době příliš mnoho pokusů. Zkuste to prosím za chvíli znovu.</p>' +
        '<p><a href="/login">Zpět na přihlášení</a></p></body></html>',
    );
    return;
  }
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.end(
    JSON.stringify({
      statusCode: 429,
      code: 'RATE_LIMITED',
      message: 'Too many sign-in attempts. Try again later.',
    }),
  );
}

/**
 * Sign-in, sign-out and the current user (ADR 0022). The browser reaches these routes
 * same-origin under /api/auth; the identity provider redirects back to /api/auth/callback.
 */
@Controller('auth')
export class AuthController {
  constructor(
    private readonly auth: AuthService,
    private readonly limits: AuthRateLimitService,
    private readonly sessions: SessionsService,
    private readonly audit: AuditService,
    @Inject(IDENTITY_PROVIDER) private readonly provider: IdentityProvider,
    @Inject(ENV) private readonly env: Env,
  ) {}

  @Get('login')
  @Public()
  async login(
    @Query('next') next: unknown,
    @Query('login_hint') loginHint: unknown,
    @Req() req: IncomingMessage,
    @Res() res: ServerResponse,
  ): Promise<void> {
    const decision = await this.limits.hit('login', this.limits.clientIp(req));
    if (!decision.allowed) return tooManyRequests(req, res, decision);
    const attempt = await this.auth.startLogin(
      next,
      typeof loginHint === 'string' ? loginHint : undefined,
    );
    redirect(res, attempt.redirectUrl, [
      serializeCookie(LOGIN_BINDING_COOKIE, attempt.binding, attempt.bindingMaxAgeSeconds),
    ]);
  }

  @Get('callback')
  @Public()
  async callback(
    @Query('code') code: unknown,
    @Query('state') state: unknown,
    @Req() req: IncomingMessage,
    @Res() res: ServerResponse,
  ): Promise<void> {
    // Every callback counts; failed ones count separately and block sooner. The limit is checked
    // before the one-time state is touched, so it never weakens the state/PKCE validation.
    const ip = this.limits.clientIp(req);
    const failures = await this.limits.check('callback_failure', ip);
    if (!failures.allowed) return tooManyRequests(req, res, failures);
    const decision = await this.limits.hit('callback', ip);
    if (!decision.allowed) return tooManyRequests(req, res, decision);
    const outcome = await this.auth.completeLogin({
      code,
      state,
      binding: readCookie(req, LOGIN_BINDING_COOKIE),
    });
    const clearBinding = clearCookie(LOGIN_BINDING_COOKIE);
    if (outcome.kind === 'ok') {
      redirect(res, outcome.nextPath, [
        clearBinding,
        serializeCookie(SESSION_COOKIE, outcome.token, outcome.maxAgeSeconds),
      ]);
      return;
    }
    await this.limits.hit('callback_failure', ip);
    const target =
      outcome.reason === 'ACCOUNT_INACTIVE'
        ? '/account-inactive'
        : outcome.reason === 'NO_ACCESS'
          ? '/account-inactive?reason=no-access'
          : '/login?error=invalid';
    redirect(res, target, [clearBinding]);
  }

  @Post('logout')
  @Authenticated()
  @HttpCode(200)
  async logout(
    @CurrentPrincipal() principal: Principal,
    @Res({ passthrough: true }) res: ServerResponse,
  ): Promise<{ redirectUrl: string }> {
    const redirectUrl = await this.auth.logout({
      sessionId: principal.sessionId,
      userId: principal.userId,
    });
    res.setHeader('Set-Cookie', [clearCookie(SESSION_COOKIE)]);
    res.setHeader('Cache-Control', 'no-store');
    return { redirectUrl };
  }

  @Get('me')
  @Authenticated()
  me(
    @CurrentPrincipal() principal: Principal,
    @Res({ passthrough: true }) res: ServerResponse,
  ): CurrentUser {
    res.setHeader('Cache-Control', 'no-store');
    return {
      user: { id: principal.userId, email: principal.email, displayName: principal.displayName },
      roles: principal.roles,
      permissions: [...principal.permissions].sort(),
      sites: principal.sites.map(toAccessibleSite),
      activeSiteId: principal.activeSite?.id ?? null,
      globalSiteAccess: principal.globalSiteAccess,
      scopes: principal.scopes.map((s) => ({
        id: s.id,
        type: s.type as CurrentUser['scopes'][number]['type'],
        siteId: s.siteId,
        siteCode: s.siteCode,
        locationCode: s.locationCode,
        scopeRef: s.scopeRef,
        grantedAt: s.grantedAt.toISOString(),
      })),
      session: {
        idleExpiresAt: principal.idleExpiresAt.toISOString(),
        absoluteExpiresAt: principal.absoluteExpiresAt.toISOString(),
      },
    };
  }

  /**
   * Chooses the site this session works at. The id is untrusted input: it is accepted only if
   * the server's evaluation of the user's scopes (or global access) includes the site.
   */
  @Post('active-site')
  @Authenticated()
  @HttpCode(200)
  async activeSite(
    @CurrentPrincipal() principal: Principal,
    @Body(new ZodValidationPipe(activeSiteRequestSchema)) body: ActiveSiteRequest,
    @Res({ passthrough: true }) res: ServerResponse,
  ): Promise<{ activeSiteId: string }> {
    const site = principal.sites.find((s) => s.id === body.siteId);
    if (!site) {
      await this.audit.record({
        type: 'ACTIVE_SITE_SELECTED',
        actorUserId: principal.userId,
        targetUserId: principal.userId,
        reason: 'Refused: no access to this site',
        payload: { requestedSiteId: body.siteId, refused: true },
      });
      throw domainError(403, 'SITE_FORBIDDEN', 'You have no access to this site');
    }
    await this.sessions.setActiveSite(principal.sessionId, site.id);
    res.setHeader('Cache-Control', 'no-store');
    return { activeSiteId: site.id };
  }

  /**
   * The fake provider's sign-in page — automated tests only. Answers 404 unless the process runs
   * with the test provider (which the environment schema allows only with APP_ENV=test).
   */
  @Get('test-provider/authorize')
  @Public()
  testAuthorize(
    @Query('state') state: unknown,
    @Query('redirect_uri') redirectUri: unknown,
    @Query('login_hint') loginHint: unknown,
    @Res() res: ServerResponse,
  ): void {
    if (this.env.APP_ENV !== 'test' || !(this.provider instanceof TestIdentityProvider)) {
      throw new NotFoundException();
    }
    if (redirectUri !== this.auth.callbackUrl || typeof state !== 'string') {
      throw new NotFoundException();
    }
    if (typeof loginHint !== 'string' || loginHint === '') {
      // The fake provider's "sign-in page": an e-mail field that comes back here as login_hint.
      const esc = (v: string) => v.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
      res.statusCode = 200;
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.setHeader('Cache-Control', 'no-store');
      res.end(
        `<!doctype html><html lang="en"><title>Test identity provider</title>` +
          `<form method="get"><input type="hidden" name="state" value="${esc(state)}">` +
          `<input type="hidden" name="redirect_uri" value="${esc(redirectUri)}">` +
          `<label>E-mail <input name="login_hint" type="email" required></label>` +
          `<button type="submit">Continue</button></form></html>`,
      );
      return;
    }
    const target = new URL(redirectUri);
    target.searchParams.set('code', this.provider.issueCode(loginHint));
    target.searchParams.set('state', state);
    redirect(res, target.toString());
  }
}
