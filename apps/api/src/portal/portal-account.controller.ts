import {
  PORTAL_SESSION_HEADER,
  portalLogoutRequestSchema,
  portalReplaceMfaRequestSchema,
  type PortalChallengeStep,
  type PortalClient,
  type PortalLogoutRequest,
  type PortalReplaceMfaRequest,
} from '@ayvo/types';
import { Body, Controller, Headers, HttpCode, Inject, Post } from '@nestjs/common';
import QRCode from 'qrcode';
import { AuditService } from '../audit/audit.service.js';
import { domainError } from '../common/domain-error.js';
import { ZodValidationPipe } from '../common/zod-validation.pipe.js';
import { ENV, type Env } from '../config/env.js';
import { PortalServiceAccess } from '../identity/access.decorators.js';
import {
  accountInactive,
  sameOriginRequest,
  sessionExpired,
  unauthenticated,
} from '../identity/access.guard.js';
import { AuthRateLimitService } from '../identity/auth-rate-limit.service.js';
import { sha256Hex } from '../identity/crypto.js';
import { NativeAuthService } from '../identity/native-auth.service.js';
import { PasswordWorkLimitError } from '../identity/native-credentials.js';
import { SessionsService } from '../identity/sessions.service.js';
import { PORTAL_AUDIT, PORTAL_NATIVE_AUTH, PORTAL_SESSIONS } from './portal-tokens.js';
import { PortalPrismaService } from './portal-prisma.service.js';
import { PortalRequestLimit } from './portal-request-limit.js';

/** The replacement's setup step lives as long as the internal OS's (`SETUP_MS`, 15 minutes). */
const SETUP_STEP_SECONDS = 900;

/**
 * "Zabezpečení účtu" of the hotel portal (ADR 0045 §3): the signed-in portal account replaces its
 * authenticator app — the internal OS's `replace-mfa`, unchanged, for the PORTAL audience. Like the
 * sign-in routes it holds a portal request slot, checks the forwarded browser request (the portal's
 * origin, the IP limit, then the account's limit; Redis, fail closed) and uses the module's
 * portal-pool services. The challenge it returns is finished by the ordinary `auth/mfa` step with a
 * code of the new app; that step revokes every session of the account, issues a new one and new
 * recovery codes (one transaction, audited MFA_REPLACED).
 *
 * Kept apart from `PortalContractController` on purpose (open PRs change that file); its small
 * browser checks repeat the contract controller's and can be shared once those PRs are merged.
 */
@Controller('internal/v1/portal/account')
export class PortalAccountController {
  constructor(
    @Inject(PORTAL_NATIVE_AUTH) private readonly auth: NativeAuthService,
    @Inject(PORTAL_SESSIONS) private readonly sessions: SessionsService,
    private readonly limits: AuthRateLimitService,
    private readonly slots: PortalRequestLimit,
    private readonly db: PortalPrismaService,
    @Inject(PORTAL_AUDIT) private readonly audit: AuditService,
    @Inject(ENV) private readonly env: Env,
  ) {}

  /**
   * "Odhlásit ze všech zařízení" (a lost phone, a shared computer): every session of the signed-in
   * portal account ends, this one included, in one transaction with its audit event (LOGOUT with
   * `allSessions`). A session that is already gone answers 401 like any other route.
   */
  @PortalServiceAccess()
  @Post('logout-all')
  @HttpCode(204)
  logoutAll(
    @Body(new ZodValidationPipe(portalLogoutRequestSchema)) body: PortalLogoutRequest,
    @Headers(PORTAL_SESSION_HEADER) token: string | undefined,
  ): Promise<void> {
    return this.slots.run(async () => {
      this.sameOrigin(body.client);
      const userId = (await this.activeSession(token)).user.id;
      await this.db.$transaction(async (tx) => {
        const ended = await this.sessions.revokeAllForUser(userId, 'LOGOUT_ALL', tx);
        await this.audit.record(
          {
            type: 'LOGOUT',
            actorUserId: userId,
            targetUserId: userId,
            payload: { allSessions: true, ended: ended.count },
          },
          tx,
        );
      });
    });
  }

  @PortalServiceAccess()
  @Post('replace-mfa')
  @HttpCode(200)
  replaceMfa(
    @Body(new ZodValidationPipe(portalReplaceMfaRequestSchema)) body: PortalReplaceMfaRequest,
    @Headers(PORTAL_SESSION_HEADER) token: string | undefined,
  ): Promise<PortalChallengeStep> {
    return this.slots.run(async () => {
      this.sameOrigin(body.client);
      this.decide(await this.limits.hit('login', `portal-ip:${body.client.ip}`));
      const userId = (await this.activeSession(token)).user.id;
      this.decide(await this.limits.hit('callback_failure', `portal-account:${sha256Hex(userId)}`));
      const result = await this.expensive(() =>
        this.auth.beginMfaReplacement(userId, body.password, body.code.trim()),
      );
      if (!result)
        throw domainError(
          401,
          'INVALID_CREDENTIALS',
          'Heslo nebo kód nesouhlasí. Zkontrolujte je a zkuste to znovu.',
        );
      return {
        step: 'ENROLL_MFA',
        challenge: result.token,
        maxAgeSeconds: SETUP_STEP_SECONDS,
        qrDataUrl: await QRCode.toDataURL(result.enrollmentUri, {
          errorCorrectionLevel: 'M',
          width: 256,
        }),
        setupKey: new URL(result.enrollmentUri).searchParams.get('secret') ?? undefined,
      };
    });
  }

  private async activeSession(token: string | undefined) {
    const session = await this.sessions.lookup(token ?? null, 'PORTAL');
    if (session.kind === 'expired') throw sessionExpired();
    if (session.kind === 'inactive') throw accountInactive();
    if (session.kind !== 'active') throw unauthenticated();
    return session;
  }

  private decide(decision: { allowed: boolean; unavailable?: boolean }): void {
    if (!decision.allowed)
      throw domainError(
        decision.unavailable ? 503 : 429,
        decision.unavailable ? 'AUTH_UNAVAILABLE' : 'RATE_LIMITED',
        'Přihlášení je dočasně omezené. Zkuste to za chvíli.',
      );
  }

  private sameOrigin(client: PortalClient): void {
    const portal = this.env.PORTAL_PUBLIC_ORIGIN;
    if (!portal)
      throw domainError(503, 'PORTAL_NOT_CONFIGURED', 'The hotel portal is not configured');
    if (client.origin !== portal || !sameOriginRequest(client.secFetchSite, client.origin, portal))
      throw domainError(403, 'CSRF_REJECTED', 'Cross-site request refused');
  }

  private async expensive<T>(operation: () => Promise<T>): Promise<T> {
    try {
      return await operation();
    } catch (error) {
      if (error instanceof PasswordWorkLimitError)
        throw domainError(503, 'AUTH_UNAVAILABLE', 'Přihlášení je vytížené. Zkuste to za chvíli.');
      throw error;
    }
  }
}
