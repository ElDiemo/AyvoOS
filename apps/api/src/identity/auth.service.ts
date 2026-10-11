import { Inject, Injectable, Logger } from '@nestjs/common';
import { ENV, type Env } from '../config/env.js';
import { PrismaService } from '../database/prisma.service.js';
import { AuditService } from './audit.service.js';
import { pkceChallenge, randomToken, sha256Hex } from './crypto.js';
import {
  IDENTITY_PROVIDER,
  IdentityVerificationError,
  type IdentityProvider,
} from './identity-provider.js';
import { safeNextPath } from './safe-path.js';
import { SessionsService } from './sessions.service.js';

const LOGIN_STATE_TTL_MS = 10 * 60_000;

export type LoginOutcome =
  | { kind: 'ok'; token: string; maxAgeSeconds: number; nextPath: string }
  | { kind: 'denied'; reason: 'ACCOUNT_INACTIVE' | 'NO_ACCESS' | 'INVALID_LOGIN' };

/**
 * Sign-in through the external provider (ADR 0022): a one-time state bound to the browser,
 * PKCE, server-side code exchange and verification by the provider adapter. Only pre-provisioned
 * AYVO users get in: an unknown identity is linked only to an ACTIVE, not yet linked user with the
 * same, provider-VERIFIED e-mail; nobody is created automatically.
 */
@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly sessions: SessionsService,
    private readonly audit: AuditService,
    @Inject(IDENTITY_PROVIDER) private readonly provider: IdentityProvider,
    @Inject(ENV) private readonly env: Env,
  ) {}

  get callbackUrl(): string {
    return `${this.env.APP_PUBLIC_ORIGIN}/api/auth/callback`;
  }

  async startLogin(nextPath: unknown, loginHint?: string) {
    const state = randomToken();
    const binding = randomToken();
    const codeVerifier = randomToken();
    // Housekeeping: old, unused attempts are worthless (they expire after 10 minutes).
    await this.prisma.authLoginState.deleteMany({
      where: { expiresAt: { lt: new Date(Date.now() - 86_400_000) } },
    });
    await this.prisma.authLoginState.create({
      data: {
        stateSha256: sha256Hex(state),
        bindingSha256: sha256Hex(binding),
        codeVerifier,
        nextPath: safeNextPath(nextPath),
        expiresAt: new Date(Date.now() + LOGIN_STATE_TTL_MS),
      },
    });
    const hint = typeof loginHint === 'string' && loginHint.length <= 254 ? loginHint : undefined;
    return {
      binding,
      bindingMaxAgeSeconds: LOGIN_STATE_TTL_MS / 1000,
      redirectUrl: this.provider.authorizationUrl({
        state,
        codeChallenge: pkceChallenge(codeVerifier),
        redirectUri: this.callbackUrl,
        loginHint: hint,
      }),
    };
  }

  async completeLogin(input: {
    code: unknown;
    state: unknown;
    binding: string | null;
  }): Promise<LoginOutcome> {
    if (typeof input.code !== 'string' || typeof input.state !== 'string' || !input.binding) {
      return { kind: 'denied', reason: 'INVALID_LOGIN' };
    }
    // One-time state: consumed atomically; a replayed or foreign callback finds nothing.
    const consumed = await this.prisma.authLoginState.updateMany({
      where: {
        stateSha256: sha256Hex(input.state),
        bindingSha256: sha256Hex(input.binding),
        usedAt: null,
        expiresAt: { gt: new Date() },
      },
      data: { usedAt: new Date() },
    });
    if (consumed.count !== 1) return { kind: 'denied', reason: 'INVALID_LOGIN' };
    const attempt = await this.prisma.authLoginState.findUniqueOrThrow({
      where: { stateSha256: sha256Hex(input.state) },
    });

    let identity;
    try {
      identity = await this.provider.exchangeCode({
        code: input.code,
        codeVerifier: attempt.codeVerifier,
        redirectUri: this.callbackUrl,
      });
    } catch (error) {
      const reason =
        error instanceof IdentityVerificationError ? error.message : 'unexpected error';
      this.logger.warn(`Sign-in failed: ${reason}`);
      await this.audit.record({ type: 'LOGIN_DENIED', payload: { reason: 'VERIFICATION_FAILED' } });
      return { kind: 'denied', reason: 'INVALID_LOGIN' };
    }

    return this.prisma.$transaction(async (tx) => {
      let link = await tx.userIdentity.findFirst({
        where: { provider: identity.provider, subject: identity.subject, unlinkedAt: null },
        include: { user: true },
      });
      if (!link && identity.emailVerified) {
        const user = await tx.user.findUnique({ where: { email: identity.email } });
        const alreadyLinked =
          user &&
          (await tx.userIdentity.count({
            where: { userId: user.id, provider: identity.provider, unlinkedAt: null },
          })) > 0;
        if (user && user.status === 'ACTIVE' && !alreadyLinked) {
          const created = await tx.userIdentity.create({
            data: {
              userId: user.id,
              provider: identity.provider,
              subject: identity.subject,
              emailAtLink: identity.email,
            },
          });
          link = { ...created, user };
          await this.audit.record(
            {
              type: 'IDENTITY_LINKED',
              actorUserId: user.id,
              targetUserId: user.id,
              payload: { provider: identity.provider },
            },
            tx,
          );
        }
      }
      if (!link) {
        await this.audit.record(
          {
            type: 'LOGIN_DENIED',
            payload: { reason: 'NO_ACCESS', provider: identity.provider, email: identity.email },
          },
          tx,
        );
        return { kind: 'denied', reason: 'NO_ACCESS' } as const;
      }
      if (link.user.status !== 'ACTIVE') {
        await this.audit.record(
          {
            type: 'LOGIN_DENIED',
            targetUserId: link.userId,
            payload: { reason: 'ACCOUNT_INACTIVE' },
          },
          tx,
        );
        return { kind: 'denied', reason: 'ACCOUNT_INACTIVE' } as const;
      }
      const session = await this.sessions.create(tx, {
        userId: link.userId,
        identityId: link.id,
        providerSessionId: identity.providerSessionId,
      });
      await tx.user.update({ where: { id: link.userId }, data: { lastLoginAt: new Date() } });
      await this.audit.record(
        {
          type: 'LOGIN_SUCCEEDED',
          actorUserId: link.userId,
          targetUserId: link.userId,
          payload: { provider: identity.provider, sessionId: session.sessionId },
        },
        tx,
      );
      return {
        kind: 'ok',
        token: session.token,
        maxAgeSeconds: session.maxAgeSeconds,
        nextPath: attempt.nextPath,
      } as const;
    });
  }

  async logout(input: { sessionId: string; userId: string }): Promise<string> {
    const session = await this.prisma.userSession.findUnique({ where: { id: input.sessionId } });
    await this.sessions.revoke(input.sessionId, 'LOGOUT');
    await this.audit.record({
      type: 'LOGOUT',
      actorUserId: input.userId,
      targetUserId: input.userId,
      payload: { sessionId: input.sessionId },
    });
    return (
      this.provider.logoutUrl({
        providerSessionId: session?.providerSessionId ?? null,
        returnTo: `${this.env.APP_PUBLIC_ORIGIN}/login?signed_out=1`,
      }) ?? '/login?signed_out=1'
    );
  }
}
