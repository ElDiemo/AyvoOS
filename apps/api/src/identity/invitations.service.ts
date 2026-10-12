import type { UserInvitationView } from '@ayvo/types';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { AuditService } from '../audit/audit.service.js';
import { domainError } from '../common/domain-error.js';
import { PrismaService } from '../database/prisma.service.js';
import { Prisma, type UserInvitation } from '../generated/prisma/client.js';
import {
  IDENTITY_PROVIDER,
  IdentityProviderError,
  type ExternalIdentity,
  type IdentityProvider,
  type ProviderInvitation,
} from './identity-provider.js';

/** Days an invitation stays valid at the provider (WorkOS allows 1–30; default 7). */
export const INVITATION_EXPIRES_IN_DAYS = 7;

type Kind = 'SEND' | 'RESEND' | 'REVOKE';
type Outcome = 'SENT' | 'RESENT' | 'REVOKED' | 'FAILED' | 'SKIPPED_ACCEPTED' | 'SKIPPED_CLOSED';

const inProgress = () =>
  domainError(409, 'INVITATION_IN_PROGRESS', 'The same action is running; retry shortly');
/** How long one attempt may talk to the provider before another retry may take over. */
const LEASE_MS = 30_000;
const providerFailed = () =>
  domainError(502, 'INVITATION_PROVIDER_FAILED', 'The identity provider refused the invitation');
const providerUnavailable = () =>
  domainError(
    503,
    'INVITATION_PROVIDER_UNAVAILABLE',
    'The identity provider did not answer; retry the same action (it is safe to repeat)',
  );

/** Unsuccessful outcomes become deterministic errors (also for every retry of the request). */
function throwForOutcome(outcome: Outcome): void {
  if (outcome === 'FAILED') throw providerFailed();
  if (outcome === 'SKIPPED_ACCEPTED') {
    throw domainError(409, 'INVITATION_ACCEPTED', 'The invitation was already accepted');
  }
  if (outcome === 'SKIPPED_CLOSED') {
    throw domainError(409, 'INVITATION_CLOSED', 'The invitation is no longer open');
  }
}

/** The state an administrator sees: a pending invitation past its expiry reads as EXPIRED. */
export function invitationView(invitation: UserInvitation | null): UserInvitationView | null {
  if (!invitation) return null;
  const expired =
    invitation.state === 'PENDING' &&
    invitation.expiresAt !== null &&
    invitation.expiresAt.getTime() <= Date.now();
  return {
    state: expired ? 'EXPIRED' : invitation.state,
    expiresAt: invitation.expiresAt?.toISOString() ?? null,
    sentAt: invitation.sentAt?.toISOString() ?? null,
    acceptedAt: invitation.acceptedAt?.toISOString() ?? null,
    revokedAt: invitation.revokedAt?.toISOString() ?? null,
    failureCode: invitation.failureCode,
  };
}

/**
 * Invitations of prepared AYVO users through the identity provider (doc 021 §7b). ADMIN only
 * (`identity:users_manage`), reason required, audited. Every action is idempotent per client
 * request id; a provider call never runs inside a database transaction. A provider failure never
 * grants access: only an invitation the provider reports as ACCEPTED by exactly the signing-in
 * identity lets that identity be linked (see `authorizeLink`).
 */
@Injectable()
export class InvitationsService {
  private readonly logger = new Logger(InvitationsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    @Inject(IDENTITY_PROVIDER) private readonly provider: IdentityProvider,
  ) {}

  latest(userId: string) {
    return this.prisma.userInvitation.findFirst({
      where: { userId },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    });
  }

  /** Sends a new invitation (the user must be active, not linked and have no open invitation). */
  async send(
    actorId: string | null,
    userId: string,
    requestId: string,
    reason: string,
  ): Promise<void> {
    if (await this.resume(actorId, userId, requestId, 'SEND', reason)) return;
    const invitationId = await this.start(actorId, userId, requestId, 'SEND', reason, (latest) => {
      if (latest && (latest.state === 'SENDING' || latest.state === 'PENDING')) {
        throw domainError(
          409,
          'INVITATION_OPEN',
          'An invitation is already open; resend or revoke it',
        );
      }
      return 'new';
    });
    await this.deliver(actorId, invitationId, requestId, reason, 'SEND');
  }

  /**
   * Sends the open invitation's e-mail again; an expired, failed or revoked one is replaced by a
   * new invitation; an invitation still being sent is reconciled with the provider.
   */
  async resend(actorId: string, userId: string, requestId: string, reason: string): Promise<void> {
    if (await this.resume(actorId, userId, requestId, 'RESEND', reason)) return;
    let mode: 'new' | 'existing' = 'new';
    const invitationId = await this.start(
      actorId,
      userId,
      requestId,
      'RESEND',
      reason,
      (latest) => {
        if (latest?.state === 'ACCEPTED') {
          throw domainError(409, 'INVITATION_ACCEPTED', 'The invitation was already accepted');
        }
        mode =
          latest && (latest.state === 'SENDING' || latest.state === 'PENDING') ? 'existing' : 'new';
        return mode === 'existing' ? latest! : 'new';
      },
    );
    await this.deliver(actorId, invitationId, requestId, reason, 'RESEND');
  }

  /** Cancels the open invitation at the provider and in AYVO (idempotent). */
  async revoke(actorId: string, userId: string, requestId: string, reason: string): Promise<void> {
    if (await this.resume(actorId, userId, requestId, 'REVOKE', reason)) return;
    const invitationId = await this.start(
      actorId,
      userId,
      requestId,
      'REVOKE',
      reason,
      (latest) => {
        if (!latest || latest.state === 'FAILED' || latest.state === 'EXPIRED') {
          throw domainError(409, 'NO_OPEN_INVITATION', 'There is no open invitation to revoke');
        }
        if (latest.state === 'ACCEPTED') {
          throw domainError(
            409,
            'INVITATION_ACCEPTED',
            'The invitation was accepted; deactivate the account instead',
          );
        }
        return latest;
      },
      { allowLinked: true },
    );
    await this.cancel(actorId, invitationId, requestId, reason);
  }

  // --- sign-in -----------------------------------------------------------------------------

  /**
   * Whether this verified identity may be linked to the prepared user: the bootstrap
   * administrator (created manually at the provider) may; anyone else only through an AYVO
   * invitation that the provider reports as accepted by exactly this identity. Returns the
   * invitation to mark accepted, or a denial reason. Network calls happen here, outside the
   * linking transaction, which re-checks the AYVO invitation under lock.
   */
  async authorizeLink(
    userId: string,
    identity: ExternalIdentity,
  ): Promise<{ ok: true; invitationId: string | null } | { ok: false; reason: string }> {
    const bootstrap = await this.prisma.identityBootstrap.findFirst({ where: { userId } });
    if (bootstrap) return { ok: true, invitationId: null };
    const invitation = await this.prisma.userInvitation.findFirst({
      where: { userId, state: 'PENDING', provider: identity.provider },
    });
    if (!invitation?.providerInvitationId) return { ok: false, reason: 'NOT_INVITED' };
    let remote: ProviderInvitation;
    try {
      remote = await this.provider.getInvitation(invitation.providerInvitationId);
    } catch (error) {
      this.logger.warn(`Invitation check failed: ${(error as Error).message}`);
      return { ok: false, reason: 'PROVIDER_ERROR' };
    }
    if (remote.state === 'expired') {
      await this.prisma.userInvitation
        .updateMany({ where: { id: invitation.id, state: 'PENDING' }, data: { state: 'EXPIRED' } })
        .catch(() => undefined);
      return { ok: false, reason: 'INVITATION_EXPIRED' };
    }
    if (
      remote.state !== 'accepted' ||
      remote.acceptedUserId !== identity.subject ||
      remote.email !== identity.email ||
      invitation.email !== identity.email
    ) {
      return { ok: false, reason: 'INVITATION_MISMATCH' };
    }
    return { ok: true, invitationId: invitation.id };
  }

  /** Marks the invitation accepted inside the linking transaction (still PENDING, under lock). */
  async markAccepted(
    tx: Prisma.TransactionClient,
    invitationId: string,
    identity: ExternalIdentity,
  ): Promise<boolean> {
    const rows = await tx.$queryRaw<{ state: string; email: string }[]>`
      SELECT "state"::text AS "state", "email" FROM "user_invitations"
      WHERE "id" = ${invitationId}::uuid FOR UPDATE`;
    if (rows[0]?.state !== 'PENDING' || rows[0].email !== identity.email) return false;
    const invitation = await tx.userInvitation.update({
      where: { id: invitationId },
      data: { state: 'ACCEPTED', acceptedAt: new Date(), acceptedSubject: identity.subject },
    });
    await this.audit.record(
      {
        type: 'INVITATION_ACCEPTED',
        actorUserId: invitation.userId,
        targetUserId: invitation.userId,
        payload: { provider: identity.provider },
      },
      tx,
    );
    return true;
  }

  // --- internals ---------------------------------------------------------------------------

  /**
   * A retried request id: finished → nothing to do; interrupted → continue where it stopped.
   * The same id for another user or action is a conflict.
   */
  private async resume(
    actorId: string | null,
    userId: string,
    requestId: string,
    kind: Kind,
    reason: string,
  ): Promise<boolean> {
    const prior = await this.prisma.userInvitationRequest.findUnique({
      where: { requestId },
      include: { invitation: true },
    });
    if (!prior) return false;
    if (prior.kind !== kind || prior.invitation.userId !== userId) {
      throw domainError(409, 'IDEMPOTENCY_CONFLICT', 'This request id was used for another action');
    }
    if (prior.status === 'DONE') {
      // The same answer as the first time.
      throwForOutcome(prior.outcome as Outcome);
      return true;
    }
    if (kind === 'REVOKE') await this.cancel(actorId, prior.invitationId, requestId, reason);
    else await this.deliver(actorId, prior.invitationId, requestId, reason, kind);
    return true;
  }

  /**
   * Records the request (and a new invitation when `decide` says so) in one transaction under
   * the user's row lock; the partial unique indexes stop concurrent duplicate invitations.
   */
  private async start(
    actorId: string | null,
    userId: string,
    requestId: string,
    kind: Kind,
    reason: string,
    decide: (latest: UserInvitation | null) => 'new' | UserInvitation,
    options: { allowLinked?: boolean } = {},
  ): Promise<string> {
    try {
      return await this.prisma.$transaction(async (tx) => {
        const rows = await tx.$queryRaw<{ id: string; email: string; status: string }[]>`
          SELECT "id", "email", "status"::text AS "status" FROM "users"
          WHERE "id" = ${userId}::uuid FOR UPDATE`;
        const user = rows[0];
        if (!user) throw domainError(404, 'USER_NOT_FOUND', 'No such user');
        if (user.status !== 'ACTIVE') {
          throw domainError(409, 'USER_INACTIVE', 'A deactivated user cannot be invited');
        }
        const linked = await tx.userIdentity.count({ where: { userId, unlinkedAt: null } });
        if (linked > 0 && !options.allowLinked) {
          throw domainError(409, 'ALREADY_LINKED', 'The user already signs in');
        }
        // A pending invitation past its expiry is closed first, so it does not block a new one.
        await tx.userInvitation.updateMany({
          where: { userId, state: 'PENDING', expiresAt: { lte: new Date() } },
          data: { state: 'EXPIRED' },
        });
        const latest = await tx.userInvitation.findFirst({
          where: { userId },
          orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        });
        const decision = decide(latest);
        const invitation =
          decision === 'new'
            ? await tx.userInvitation.create({
                data: {
                  userId,
                  email: user.email,
                  provider: this.provider.name,
                  requestId,
                  createdBy: actorId,
                },
              })
            : decision;
        await tx.userInvitationRequest.create({
          data: { requestId, invitationId: invitation.id, kind, actorId, reason },
        });
        return invitation.id;
      });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        // A concurrent duplicate: the same request id is already running, or another
        // invitation is open for this e-mail/user.
        if (await this.prisma.userInvitationRequest.findUnique({ where: { requestId } })) {
          throw inProgress();
        }
        throw domainError(409, 'INVITATION_OPEN', 'An invitation is already open');
      }
      throw error;
    }
  }

  /**
   * Sends (or resends) at the provider. A SENDING invitation is first reconciled with the
   * provider's pending invitations of the same e-mail, so a lost response never creates a second
   * one. After the provider call the invitation is re-read under lock: an invitation accepted in
   * the meantime is reported and audited as such, never as resent.
   */
  private async deliver(
    actorId: string | null,
    invitationId: string,
    requestId: string,
    reason: string,
    kind: 'SEND' | 'RESEND',
  ): Promise<void> {
    await this.claim(requestId);
    const invitation = await this.prisma.userInvitation.findUniqueOrThrow({
      where: { id: invitationId },
    });
    let remote: ProviderInvitation | null = null;
    let refused = false;
    const resending = invitation.state === 'PENDING';
    try {
      if (invitation.state === 'SENDING') {
        const existing = (await this.provider.findPendingInvitations(invitation.email)).find(
          // The provider reports the e-mail of each invitation: adopt only an exact match.
          (i) => i.email === invitation.email,
        );
        remote =
          existing ??
          (await this.provider.sendInvitation({
            email: invitation.email,
            expiresInDays: INVITATION_EXPIRES_IN_DAYS,
          }));
      } else if (resending && invitation.providerInvitationId) {
        remote = await this.provider.resendInvitation(invitation.providerInvitationId);
      }
    } catch (error) {
      if (error instanceof IdentityProviderError && error.ambiguous) {
        // The provider may have acted: keep SENDING and the request open; a retry with the same
        // request id reconciles. Recorded truthfully as interrupted, not as failed or sent.
        this.logOperational('invitation_delivery_interrupted', invitation.userId, kind, error);
        await this.audit.record({
          type: 'INVITATION_INTERRUPTED',
          actorUserId: actorId,
          targetUserId: invitation.userId,
          reason,
          payload: { kind },
        });
        await this.release(requestId);
        throw providerUnavailable();
      }
      this.logOperational('invitation_delivery_refused', invitation.userId, kind, error);
      refused = true;
    }

    const outcome = await this.prisma.$transaction(async (tx) => {
      const current = await this.lockInvitation(tx, invitationId);
      const linked = await tx.userIdentity.count({
        where: { userId: invitation.userId, unlinkedAt: null },
      });
      if (current.state === 'ACCEPTED' || linked > 0) {
        return this.finish(
          tx,
          requestId,
          'SKIPPED_ACCEPTED',
          actorId,
          invitation.userId,
          reason,
          kind,
        );
      }
      if (refused) {
        if (current.state === 'SENDING') {
          await tx.userInvitation.update({
            where: { id: invitationId },
            data: { state: 'FAILED', failureCode: 'PROVIDER_REFUSED' },
          });
        }
        return this.finish(tx, requestId, 'FAILED', actorId, invitation.userId, reason, kind);
      }
      if (current.state === 'SENDING' && remote) {
        await tx.userInvitation.update({
          where: { id: invitationId },
          data: {
            state: 'PENDING',
            providerInvitationId: remote.id,
            expiresAt: remote.expiresAt,
            sentAt: new Date(),
          },
        });
        return this.finish(tx, requestId, 'SENT', actorId, invitation.userId, reason, kind, {
          provider: invitation.provider,
          expiresAt: remote.expiresAt.toISOString(),
        });
      }
      if (current.state === 'PENDING' && resending && remote) {
        await tx.userInvitation.update({
          where: { id: invitationId },
          data: { expiresAt: remote.expiresAt },
        });
        return this.finish(tx, requestId, 'RESENT', actorId, invitation.userId, reason, kind, {
          provider: invitation.provider,
          expiresAt: remote.expiresAt.toISOString(),
        });
      }
      // Revoked, expired or failed meanwhile: nothing was (re)sent for this invitation.
      return this.finish(tx, requestId, 'SKIPPED_CLOSED', actorId, invitation.userId, reason, kind);
    });
    throwForOutcome(outcome);
  }

  /**
   * Revokes at the provider (when it knows the invitation), then in AYVO — unless the invitation
   * was accepted in the meantime: that is reported and audited as such, never as revoked.
   */
  private async cancel(
    actorId: string | null,
    invitationId: string,
    requestId: string,
    reason: string,
  ): Promise<void> {
    await this.claim(requestId);
    const invitation = await this.prisma.userInvitation.findUniqueOrThrow({
      where: { id: invitationId },
    });
    if (invitation.state === 'SENDING' || invitation.state === 'PENDING') {
      try {
        const providerIds = invitation.providerInvitationId
          ? [invitation.providerInvitationId]
          : (await this.provider.findPendingInvitations(invitation.email))
              .filter((i) => i.email === invitation.email)
              .map((i) => i.id);
        for (const id of providerIds) {
          try {
            await this.provider.revokeInvitation(id);
          } catch (error) {
            if (error instanceof IdentityProviderError && error.ambiguous) throw error;
            // Refused: no longer pending there (accepted, expired or revoked) — the state is
            // re-read below; AYVO's own revocation is what blocks linking.
          }
        }
      } catch (error) {
        this.logOperational(
          'invitation_revocation_interrupted',
          invitation.userId,
          'REVOKE',
          error,
        );
        await this.audit.record({
          type: 'INVITATION_INTERRUPTED',
          actorUserId: actorId,
          targetUserId: invitation.userId,
          reason,
          payload: { kind: 'REVOKE' },
        });
        await this.release(requestId);
        throw providerUnavailable();
      }
    }
    const outcome = await this.prisma.$transaction(async (tx) => {
      const current = await this.lockInvitation(tx, invitationId);
      const linked = await tx.userIdentity.count({
        where: { userId: invitation.userId, unlinkedAt: null },
      });
      if (current.state === 'ACCEPTED' || linked > 0) {
        return this.finish(
          tx,
          requestId,
          'SKIPPED_ACCEPTED',
          actorId,
          invitation.userId,
          reason,
          'REVOKE',
        );
      }
      if (current.state === 'SENDING' || current.state === 'PENDING') {
        await tx.userInvitation.update({
          where: { id: invitationId },
          data: { state: 'REVOKED', revokedAt: new Date(), revokedBy: actorId },
        });
        return this.finish(tx, requestId, 'REVOKED', actorId, invitation.userId, reason, 'REVOKE');
      }
      if (current.state === 'REVOKED') {
        // Already revoked (e.g. a second revocation): nothing new happened; no new audit event.
        await this.completeIn(tx, requestId, 'REVOKED');
        return 'REVOKED' as const;
      }
      return this.finish(
        tx,
        requestId,
        'SKIPPED_CLOSED',
        actorId,
        invitation.userId,
        reason,
        'REVOKE',
      );
    });
    throwForOutcome(outcome);
  }

  private async lockInvitation(tx: Prisma.TransactionClient, id: string) {
    const rows = await tx.$queryRaw<{ state: UserInvitation['state'] }[]>`
      SELECT "state"::text AS "state" FROM "user_invitations" WHERE "id" = ${id}::uuid FOR UPDATE`;
    return rows[0]!;
  }

  /** Completes the request with its real outcome and audits exactly that outcome. */
  private async finish(
    tx: Prisma.TransactionClient,
    requestId: string,
    outcome: Outcome,
    actorId: string | null,
    userId: string,
    reason: string,
    kind: Kind,
    payload: Prisma.InputJsonObject = {},
  ): Promise<Outcome> {
    await this.completeIn(tx, requestId, outcome);
    const type =
      outcome === 'SENT'
        ? 'INVITATION_SENT'
        : outcome === 'RESENT'
          ? 'INVITATION_RESENT'
          : outcome === 'REVOKED'
            ? 'INVITATION_REVOKED'
            : outcome === 'FAILED'
              ? 'INVITATION_FAILED'
              : 'INVITATION_ACTION_SKIPPED';
    await this.audit.record(
      {
        type,
        actorUserId: actorId,
        targetUserId: userId,
        reason,
        payload: { kind, ...(type === 'INVITATION_ACTION_SKIPPED' ? { outcome } : {}), ...payload },
      },
      tx,
    );
    return outcome;
  }

  /** A structured operational log line: no e-mail, API key, token or invitation link. */
  private logOperational(event: string, userId: string, kind: Kind, error: unknown): void {
    this.logger.warn(
      JSON.stringify({
        event,
        userId,
        kind,
        error: error instanceof Error ? error.name : 'unknown',
        message: error instanceof IdentityProviderError ? error.message : 'unexpected error',
      }),
    );
  }

  /** One attempt at a time per request: concurrent retries never call the provider twice. */
  private async claim(requestId: string): Promise<void> {
    const claimed = await this.prisma.$executeRaw`
      UPDATE "user_invitation_requests"
      SET "lease_until" = now() + ${LEASE_MS} * interval '1 millisecond'
      WHERE "request_id" = ${requestId}::uuid AND "status" = 'STARTED'
        AND ("lease_until" IS NULL OR "lease_until" < now())`;
    if (claimed !== 1) throw inProgress();
  }

  private release(requestId: string) {
    return this.prisma.userInvitationRequest.updateMany({
      where: { requestId, status: 'STARTED' },
      data: { leaseUntil: null },
    });
  }

  private completeIn(db: Prisma.TransactionClient, requestId: string, outcome: Outcome) {
    return db.userInvitationRequest.updateMany({
      where: { requestId, status: 'STARTED' },
      data: { status: 'DONE', completedAt: new Date(), leaseUntil: null, outcome },
    });
  }
}
