import { Inject, Injectable, type OnModuleInit } from '@nestjs/common';
import { AuditService } from '../audit/audit.service.js';
import { PrismaService } from '../database/prisma.service.js';
import type { AccountAudience, Prisma } from '../generated/prisma/client.js';
import {
  NativePasswords,
  NativeSecretBox,
  nativeTokenHash,
  newRecoveryCodes,
  newTotpSecret,
  recoveryCodeHash,
  totpEnrollmentUri,
  verifiedTotpStep,
} from './native-credentials.js';
import {
  NATIVE_PASSWORDS,
  NATIVE_SECRET_BOX,
  NativeTokensService,
} from './native-tokens.service.js';
import { randomToken } from './crypto.js';
import { SessionsService } from './sessions.service.js';
import { safeNextPath } from './safe-path.js';

const CHALLENGE_MS = 5 * 60_000;
const SETUP_MS = 15 * 60_000;

export type NativeLoginResult =
  | { kind: 'denied' }
  | { kind: 'reset' }
  | {
      kind: 'ok';
      token: string;
      maxAgeSeconds: number;
      nextPath: string;
      recoveryCodes?: string[];
    };

/**
 * All authentication state is PostgreSQL-owned. Never creates a user or changes their access.
 * Every step serves one audience (ADR 0045 §2): the internal native routes call it as STAFF, the
 * hotel portal's contract as PORTAL. An account, token or challenge of the other audience is
 * treated exactly like an unknown one — nothing consumed, created or sent.
 */
@Injectable()
export class NativeAuthService implements OnModuleInit {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly sessions: SessionsService,
    private readonly tokens: NativeTokensService,
    @Inject(NATIVE_PASSWORDS) private readonly passwords: NativePasswords,
    @Inject(NATIVE_SECRET_BOX) private readonly box: NativeSecretBox,
  ) {}

  async onModuleInit(): Promise<void> {
    await this.passwords.ready();
  }

  async beginLogin(
    email: string,
    password: string,
    next: unknown,
    audience: AccountAudience = 'STAFF',
  ): Promise<{ token: string } | null> {
    const snapshot = await this.prisma.user.findUnique({
      where: { email },
      include: { nativeCredential: true },
    });
    const matched = await this.passwords.verify(
      password,
      snapshot?.nativeCredential?.passwordHash ?? null,
    );
    if (
      !matched ||
      snapshot?.status !== 'ACTIVE' ||
      !snapshot.nativeCredential ||
      snapshot.audience !== audience
    ) {
      await this.audit.record({
        type: 'LOGIN_DENIED',
        payload: { reason: 'INVALID_NATIVE_LOGIN' },
      });
      return null;
    }
    return this.prisma.$transaction(async (tx) => {
      await this.lockUser(tx, snapshot.id);
      const user = await tx.user.findUniqueOrThrow({
        where: { id: snapshot.id },
        include: { nativeCredential: true },
      });
      if (
        user.status !== 'ACTIVE' ||
        user.nativeCredential?.revision !== snapshot.nativeCredential!.revision
      )
        return null;
      const token = randomToken();
      await tx.nativeAuthChallenge.create({
        data: {
          userId: user.id,
          audience: user.audience,
          kind: 'LOGIN',
          tokenSha256: nativeTokenHash('CHALLENGE', token)!,
          credentialRevision: user.nativeCredential.revision,
          nextPath: safeNextPath(next),
          expiresAt: new Date(Date.now() + CHALLENGE_MS),
        },
      });
      return { token };
    });
  }

  /** Generic public response is supplied by the controller; an email never removes MFA. */
  async requestPasswordReset(email: string, audience: AccountAudience = 'STAFF'): Promise<void> {
    const user = await this.prisma.user.findUnique({
      where: { email },
      include: { nativeCredential: true },
    });
    // Another audience's account: no token, no mail (the controller's answer is the same).
    if (!user || user.audience !== audience || user.status !== 'ACTIVE' || !user.nativeCredential)
      return;
    await this.prisma.$transaction(async (tx) => {
      await this.lockUser(tx, user.id);
      const current = await tx.user.findUniqueOrThrow({
        where: { id: user.id },
        include: { nativeCredential: true },
      });
      if (current.status !== 'ACTIVE' || !current.nativeCredential) return;
      // Avoid email flooding and invalidating a still-useful link on every repeated request.
      const pending = await tx.nativeAuthToken.findFirst({
        where: {
          userId: user.id,
          purpose: 'RESET_PASSWORD',
          credentialRevision: current.nativeCredential.revision,
          usedAt: null,
          revokedAt: null,
          claimedAt: null,
          expiresAt: { gt: new Date() },
        },
      });
      if (pending) return;
      await this.tokens.issue(tx, {
        userId: user.id,
        purpose: 'RESET_PASSWORD',
        credentialRevision: current.nativeCredential.revision,
        ttlMs: SETUP_MS,
      });
      await this.audit.record({ type: 'PASSWORD_RESET_REQUESTED', targetUserId: user.id }, tx);
    });
  }

  async beginAction(
    purpose: 'ENROLL' | 'RESET_PASSWORD',
    rawToken: string,
    password: string,
    audience: AccountAudience = 'STAFF',
  ): Promise<{ token: string; enrollmentUri?: string } | null> {
    const digest = nativeTokenHash(purpose, rawToken);
    if (!digest) return null;
    const snapshot = await this.prisma.nativeAuthToken.findUnique({
      where: { tokenSha256: digest },
    });
    if (
      !snapshot ||
      snapshot.audience !== audience ||
      snapshot.purpose !== purpose ||
      snapshot.usedAt ||
      snapshot.revokedAt ||
      snapshot.claimedAt ||
      snapshot.expiresAt <= new Date()
    )
      return null;
    const encoded = await this.passwords.hash(password);
    return this.prisma.$transaction(async (tx) => {
      await this.lockUser(tx, snapshot.userId);
      const user = await tx.user.findUniqueOrThrow({
        where: { id: snapshot.userId },
        include: { nativeCredential: true },
      });
      const action = await tx.nativeAuthToken.findUniqueOrThrow({ where: { id: snapshot.id } });
      if (
        user.status !== 'ACTIVE' ||
        action.tokenSha256 !== digest ||
        action.purpose !== purpose ||
        action.usedAt ||
        action.revokedAt ||
        action.claimedAt ||
        action.expiresAt <= new Date() ||
        (user.nativeCredential?.revision ?? 0) !== action.credentialRevision
      )
        return null;
      if (purpose === 'ENROLL') {
        if (user.nativeCredential) return null;
        const invited = await tx.userInvitation.findFirst({
          where: {
            userId: user.id,
            provider: 'LOCAL',
            providerInvitationId: action.id,
            state: 'PENDING',
            expiresAt: { gt: new Date() },
          },
        });
        const bootstrap = await tx.identityBootstrap.findFirst({ where: { userId: user.id } });
        if (!invited && !bootstrap) return null;
      } else if (!user.nativeCredential) return null;
      await tx.nativeAuthToken.update({
        where: { id: action.id },
        data: { claimedAt: new Date() },
      });
      const secret = purpose === 'ENROLL' ? newTotpSecret() : null;
      const token = randomToken();
      await tx.nativeAuthChallenge.create({
        data: {
          userId: user.id,
          audience: action.audience,
          kind: purpose,
          tokenSha256: nativeTokenHash('CHALLENGE', token)!,
          credentialRevision: action.credentialRevision,
          actionId: action.id,
          actionRevision: action.revision,
          passwordHash: encoded,
          totpCiphertext: secret ? this.box.seal(user.id, 'TOTP', secret) : null,
          expiresAt: new Date(Math.min(Date.now() + SETUP_MS, action.expiresAt.getTime())),
        },
      });
      await this.audit.record(
        {
          type: purpose === 'ENROLL' ? 'NATIVE_ACTIVATION_STARTED' : 'PASSWORD_RESET_STARTED',
          targetUserId: user.id,
        },
        tx,
      );
      return { token, ...(secret ? { enrollmentUri: totpEnrollmentUri(secret, user.email) } : {}) };
    });
  }

  /** Used only for per-account rate limiting; never sends an identifier to the browser. */
  async challengeAccount(
    rawToken: string | null,
    audience: AccountAudience = 'STAFF',
  ): Promise<string | null> {
    const hash = rawToken && nativeTokenHash('CHALLENGE', rawToken);
    const challenge = hash
      ? await this.prisma.nativeAuthChallenge.findUnique({
          where: { tokenSha256: hash },
          select: { userId: true, audience: true },
        })
      : null;
    // No shared bucket for unknown challenges: they cannot reach an account, the IP limit applies.
    return challenge?.audience === audience ? challenge.userId : null;
  }

  async complete(
    rawToken: string | null,
    code: string,
    audience: AccountAudience = 'STAFF',
  ): Promise<NativeLoginResult> {
    const digest = rawToken && nativeTokenHash('CHALLENGE', rawToken);
    const snapshot = digest
      ? await this.prisma.nativeAuthChallenge.findUnique({ where: { tokenSha256: digest } })
      : null;
    // A challenge of the other audience is not even counted as an attempt.
    if (!snapshot || snapshot.audience !== audience) return { kind: 'denied' };
    return this.prisma.$transaction(async (tx): Promise<NativeLoginResult> => {
      // Lock order is always user -> credential/challenge/token. Also used by deactivation and
      // invitation management: no session can slip past a committed revocation.
      await this.lockUser(tx, snapshot.userId);
      const challenge = await tx.nativeAuthChallenge.findUniqueOrThrow({
        where: { id: snapshot.id },
      });
      const user = await tx.user.findUniqueOrThrow({
        where: { id: snapshot.userId },
        include: { nativeCredential: true },
      });
      const credential = user.nativeCredential;
      const now = new Date();
      if (
        user.status !== 'ACTIVE' ||
        challenge.usedAt ||
        challenge.expiresAt <= now ||
        challenge.attempts >= 5 ||
        (credential?.revision ?? 0) !== challenge.credentialRevision
      )
        return { kind: 'denied' };
      const action = challenge.actionId
        ? await tx.nativeAuthToken.findUniqueOrThrow({ where: { id: challenge.actionId } })
        : null;
      if (
        action &&
        (action.usedAt ||
          action.revokedAt ||
          action.expiresAt <= now ||
          action.revision !== challenge.actionRevision)
      )
        return { kind: 'denied' };
      if (challenge.kind === 'ENROLL') {
        const bootstrap = await tx.identityBootstrap.findFirst({ where: { userId: user.id } });
        const invitation = await tx.userInvitation.findFirst({
          where: {
            userId: user.id,
            provider: 'LOCAL',
            providerInvitationId: action!.id,
            state: 'PENDING',
            expiresAt: { gt: now },
          },
        });
        if (credential || (!bootstrap && !invitation)) return { kind: 'denied' };
      }
      // Invalid attempts COMMIT their count; do not throw inside this transaction and roll back.
      await tx.nativeAuthChallenge.update({
        where: { id: challenge.id },
        data: { attempts: { increment: 1 } },
      });
      const enrolling = challenge.kind === 'ENROLL' || challenge.kind === 'REPLACE_MFA';
      const ciphertext = enrolling ? challenge.totpCiphertext : credential?.totpCiphertext;
      if (!ciphertext) return { kind: 'denied' };
      const secret = this.box.open(user.id, 'TOTP', ciphertext);
      const step = verifiedTotpStep(
        secret,
        code,
        now.getTime(),
        enrolling ? null : credential!.lastTotpStep,
      );
      let usedRecovery = false;
      if (step === null && !enrolling && credential) {
        const hash = recoveryCodeHash(user.id, code);
        if (hash) {
          const consumed = await tx.nativeRecoveryCode.updateMany({
            where: {
              userId: user.id,
              mfaRevision: credential.mfaRevision,
              codeSha256: hash,
              usedAt: null,
            },
            data: { usedAt: now },
          });
          usedRecovery = consumed.count === 1;
        }
      }
      if (step === null && !usedRecovery) {
        await this.audit.record(
          {
            type: 'LOGIN_DENIED',
            targetUserId: user.id,
            payload: { reason: 'INVALID_SECOND_FACTOR' },
          },
          tx,
        );
        return { kind: 'denied' };
      }
      if (usedRecovery)
        await this.audit.record(
          { type: 'RECOVERY_CODE_USED', actorUserId: user.id, targetUserId: user.id },
          tx,
        );
      let recoveryCodes: string[] | undefined;
      if (enrolling) {
        const mfaRevision = (credential?.mfaRevision ?? 0) + 1;
        if (credential) {
          await tx.nativeCredential.update({
            where: { userId: user.id },
            data: {
              totpCiphertext: ciphertext,
              revision: { increment: 1 },
              mfaRevision,
              lastTotpStep: step!,
              updatedAt: now,
            },
          });
        } else {
          await tx.nativeCredential.create({
            data: {
              userId: user.id,
              passwordHash: challenge.passwordHash!,
              totpCiphertext: ciphertext,
              lastTotpStep: step!,
            },
          });
        }
        recoveryCodes = newRecoveryCodes();
        await tx.nativeRecoveryCode.createMany({
          data: recoveryCodes.map((value) => ({
            userId: user.id,
            mfaRevision,
            codeSha256: recoveryCodeHash(user.id, value)!,
          })),
        });
        await this.sessions.revokeAllForUser(user.id, 'NATIVE_CREDENTIAL_ACTIVATED', tx);
        // Historical external links remain as data for an application rollback. No deployed
        // local-auth route accepts an external callback; all old sessions were revoked above.
        if (challenge.kind === 'ENROLL') {
          const invitation = await tx.userInvitation.findFirst({
            where: {
              userId: user.id,
              provider: 'LOCAL',
              providerInvitationId: action!.id,
              state: 'PENDING',
            },
          });
          if (invitation) {
            await tx.userInvitation.update({
              where: { id: invitation.id },
              data: { state: 'ACCEPTED', acceptedAt: now, acceptedSubject: user.id },
            });
            await this.audit.record(
              {
                type: 'INVITATION_ACCEPTED',
                actorUserId: user.id,
                targetUserId: user.id,
                payload: { provider: 'LOCAL' },
              },
              tx,
            );
          }
        }
        await this.audit.record(
          {
            type: challenge.kind === 'ENROLL' ? 'NATIVE_ACTIVATION_COMPLETED' : 'MFA_REPLACED',
            actorUserId: user.id,
            targetUserId: user.id,
          },
          tx,
        );
      } else if (challenge.kind === 'RESET_PASSWORD') {
        await tx.nativeCredential.update({
          where: { userId: user.id },
          data: {
            passwordHash: challenge.passwordHash!,
            revision: { increment: 1 },
            updatedAt: now,
            ...(step !== null ? { lastTotpStep: step } : {}),
          },
        });
        await this.sessions.revokeAllForUser(user.id, 'PASSWORD_RESET', tx);
        await this.audit.record(
          { type: 'PASSWORD_RESET_COMPLETED', actorUserId: user.id, targetUserId: user.id },
          tx,
        );
      } else if (step !== null) {
        await tx.nativeCredential.update({
          where: { userId: user.id },
          data: { lastTotpStep: step },
        });
      }
      await tx.nativeAuthChallenge.update({
        where: { id: challenge.id },
        data: { usedAt: now, passwordHash: null, totpCiphertext: null },
      });
      if (action)
        await tx.nativeAuthToken.update({
          where: { id: action.id },
          data: { usedAt: now, deliveryCiphertext: null },
        });
      if (challenge.kind === 'RESET_PASSWORD') return { kind: 'reset' };
      let identity = await tx.userIdentity.findFirst({
        where: { userId: user.id, provider: 'LOCAL', unlinkedAt: null },
      });
      if (!identity) {
        identity = await tx.userIdentity.create({
          data: { userId: user.id, provider: 'LOCAL', subject: user.id, emailAtLink: user.email },
        });
        await this.audit.record(
          {
            type: 'IDENTITY_LINKED',
            actorUserId: user.id,
            targetUserId: user.id,
            payload: { provider: 'LOCAL' },
          },
          tx,
        );
      }
      const session = await this.sessions.create(tx, {
        userId: user.id,
        identityId: identity.id,
        providerSessionId: null,
        audience: challenge.audience,
      });
      await tx.user.update({ where: { id: user.id }, data: { lastLoginAt: now } });
      await this.audit.record(
        {
          type: 'LOGIN_SUCCEEDED',
          actorUserId: user.id,
          targetUserId: user.id,
          payload: { provider: 'LOCAL', sessionId: session.sessionId },
        },
        tx,
      );
      return {
        kind: 'ok',
        token: session.token,
        maxAgeSeconds: session.maxAgeSeconds,
        nextPath: challenge.nextPath,
        ...(recoveryCodes ? { recoveryCodes } : {}),
      };
    });
  }

  /**
   * A signed-in account changes its password: the current password and a current code (or an
   * unused recovery code), then the new password. In one transaction, under the user's lock: the
   * credential gets the new hash and a new revision (pending challenges of the old one stop
   * counting), every session of the account ends, one new session is issued, PASSWORD_CHANGED is
   * audited. Wrong input changes nothing (an unused recovery code is consumed only on success).
   * Used by the hotel portal (Zabezpečení účtu); `audience` must be the account's own.
   */
  async changePassword(
    userId: string,
    currentPassword: string,
    newPassword: string,
    currentCode: string,
    audience: AccountAudience,
  ): Promise<{ token: string; maxAgeSeconds: number } | null> {
    const snapshot = await this.prisma.nativeCredential.findUnique({ where: { userId } });
    // Both Argon2 steps always run, so a right password with a wrong code takes as long as a wrong
    // password (no timing signal that the password was right).
    const matched = await this.passwords.verify(currentPassword, snapshot?.passwordHash ?? null);
    const encoded = await this.passwords.hash(newPassword);
    if (!snapshot || !matched) return null;
    return this.prisma.$transaction(async (tx) => {
      await this.lockUser(tx, userId);
      const user = await tx.user.findUniqueOrThrow({
        where: { id: userId },
        include: { nativeCredential: true },
      });
      const credential = user.nativeCredential;
      if (
        user.status !== 'ACTIVE' ||
        user.audience !== audience ||
        !credential ||
        credential.revision !== snapshot.revision
      )
        return null;
      // Looked up before any write: a refusal here must change nothing.
      const identity = await tx.userIdentity.findFirst({
        where: { userId, provider: 'LOCAL', unlinkedAt: null },
      });
      if (!identity) return null;
      const step = verifiedTotpStep(
        this.box.open(userId, 'TOTP', credential.totpCiphertext),
        currentCode,
        Date.now(),
        credential.lastTotpStep,
      );
      if (step === null) {
        const hash = recoveryCodeHash(userId, currentCode);
        if (
          !hash ||
          (
            await tx.nativeRecoveryCode.updateMany({
              where: {
                userId,
                mfaRevision: credential.mfaRevision,
                codeSha256: hash,
                usedAt: null,
              },
              data: { usedAt: new Date() },
            })
          ).count !== 1
        )
          return null;
        await this.audit.record(
          { type: 'RECOVERY_CODE_USED', actorUserId: userId, targetUserId: userId },
          tx,
        );
      }
      await tx.nativeCredential.update({
        where: { userId },
        data: {
          passwordHash: encoded,
          revision: { increment: 1 },
          updatedAt: new Date(),
          ...(step !== null ? { lastTotpStep: step } : {}),
        },
      });
      await this.sessions.revokeAllForUser(userId, 'PASSWORD_CHANGED', tx);
      const session = await this.sessions.create(tx, {
        userId,
        identityId: identity.id,
        providerSessionId: null,
        audience: user.audience,
      });
      await this.audit.record(
        {
          type: 'PASSWORD_CHANGED',
          actorUserId: userId,
          targetUserId: userId,
          payload: { sessionId: session.sessionId },
        },
        tx,
      );
      return { token: session.token, maxAgeSeconds: session.maxAgeSeconds };
    });
  }

  async beginMfaReplacement(
    userId: string,
    password: string,
    currentCode: string,
  ): Promise<{ token: string; enrollmentUri: string } | null> {
    const snapshot = await this.prisma.nativeCredential.findUnique({ where: { userId } });
    if (!snapshot || !(await this.passwords.verify(password, snapshot.passwordHash))) return null;
    return this.prisma.$transaction(async (tx) => {
      await this.lockUser(tx, userId);
      const user = await tx.user.findUniqueOrThrow({
        where: { id: userId },
        include: { nativeCredential: true },
      });
      const credential = user.nativeCredential;
      if (user.status !== 'ACTIVE' || !credential || credential.revision !== snapshot.revision)
        return null;
      const step = verifiedTotpStep(
        this.box.open(userId, 'TOTP', credential.totpCiphertext),
        currentCode,
        Date.now(),
        credential.lastTotpStep,
      );
      if (step === null) {
        const hash = recoveryCodeHash(userId, currentCode);
        if (
          !hash ||
          (
            await tx.nativeRecoveryCode.updateMany({
              where: {
                userId,
                mfaRevision: credential.mfaRevision,
                codeSha256: hash,
                usedAt: null,
              },
              data: { usedAt: new Date() },
            })
          ).count !== 1
        )
          return null;
        await this.audit.record(
          { type: 'RECOVERY_CODE_USED', actorUserId: userId, targetUserId: userId },
          tx,
        );
      } else await tx.nativeCredential.update({ where: { userId }, data: { lastTotpStep: step } });
      const secret = newTotpSecret();
      const token = randomToken();
      await tx.nativeAuthChallenge.create({
        data: {
          userId,
          audience: user.audience,
          kind: 'REPLACE_MFA',
          tokenSha256: nativeTokenHash('CHALLENGE', token)!,
          credentialRevision: credential.revision,
          totpCiphertext: this.box.seal(userId, 'TOTP', secret),
          expiresAt: new Date(Date.now() + SETUP_MS),
        },
      });
      return { token, enrollmentUri: totpEnrollmentUri(secret, user.email) };
    });
  }

  private async lockUser(tx: Prisma.TransactionClient, id: string): Promise<void> {
    await tx.$queryRaw`SELECT id FROM users WHERE id = ${id}::uuid FOR UPDATE`;
  }
}
