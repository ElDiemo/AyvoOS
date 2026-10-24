import type { PrismaService } from '../database/prisma.service.js';
import type { InvitationsService } from './invitations.service.js';
import type { NativeTokensService } from './native-tokens.service.js';

/** Delivery attempts after which the outbox stops (native-tokens.service.ts). */
const MAX_DELIVERY_ATTEMPTS = 5;

export type BootstrapActivationOutcome =
  /** Accepted by the mail server during this run. Not proof of delivery to the mailbox. */
  | { kind: 'accepted'; sentAt: Date; expiresAt: Date }
  /** An earlier link was accepted and is still usable; nothing new was sent. */
  | { kind: 'sent-earlier'; sentAt: Date; expiresAt: Date }
  /** Queued, not accepted yet; the running API retries. */
  | { kind: 'queued'; attempts: number }
  /** The open link can no longer be used or delivered: only an explicit --resend helps. */
  | { kind: 'needs-resend'; why: 'setup-started' | 'delivery-exhausted' };

export class BootstrapActivationRefused extends Error {}

/**
 * Native activation e-mail for the ALREADY bootstrapped administrator (doc 038 §4) — nobody
 * else. Never creates a user, grants a role, resets MFA or prints a link. A repeat without
 * `resend` changes nothing and reports the state truthfully; `resend` issues a new link through
 * the ordinary invitation resend, which rotates the token and invalidates the old link and any
 * setup stage started with it.
 */
export async function activateBootstrap(
  deps: { prisma: PrismaService; invitations: InvitationsService; mail: NativeTokensService },
  email: string,
  options: { resend: boolean; requestId: string },
): Promise<BootstrapActivationOutcome> {
  const { prisma, invitations, mail } = deps;
  const bootstrap = await prisma.identityBootstrap.findFirst({
    where: { email },
    include: { user: { include: { nativeCredential: true } } },
  });
  if (!bootstrap || bootstrap.user.status !== 'ACTIVE' || bootstrap.user.nativeCredential)
    throw new BootstrapActivationRefused(
      'Refused: no active, unactivated bootstrap administrator with this email',
    );
  const admin = await prisma.userRole.count({
    where: { userId: bootstrap.userId, roleCode: 'ADMIN', revokedAt: null },
  });
  if (admin !== 1)
    throw new BootstrapActivationRefused(
      'Refused: bootstrap administrator has no active ADMIN grant',
    );

  const current = await openLink(prisma, invitations, bootstrap.userId);
  const reason = 'Native activation of existing bootstrap administrator';
  if (!current) {
    // No usable link: a new invitation, or (an open one with a dead link) its resend.
    const latest = await invitations.latest(bootstrap.userId);
    const open = latest?.state === 'SENDING' || latest?.state === 'PENDING';
    await (open
      ? invitations.resend(null, bootstrap.userId, options.requestId, reason)
      : invitations.send(null, bootstrap.userId, options.requestId, reason));
  } else if (options.resend) {
    await invitations.resend(null, bootstrap.userId, options.requestId, reason);
  } else if (current.claimedAt) {
    return { kind: 'needs-resend', why: 'setup-started' };
  } else if (current.sentAt) {
    return { kind: 'sent-earlier', sentAt: current.sentAt, expiresAt: current.expiresAt };
  } else if (current.deliveryAttempts >= MAX_DELIVERY_ATTEMPTS) {
    return { kind: 'needs-resend', why: 'delivery-exhausted' };
  }
  const startedAt = new Date();
  await mail.deliverPending();
  const link = await openLink(prisma, invitations, bootstrap.userId);
  if (link?.sentAt && link.sentAt >= startedAt)
    return { kind: 'accepted', sentAt: link.sentAt, expiresAt: link.expiresAt };
  if (link && link.deliveryAttempts >= MAX_DELIVERY_ATTEMPTS)
    return { kind: 'needs-resend', why: 'delivery-exhausted' };
  return { kind: 'queued', attempts: link?.deliveryAttempts ?? 0 };
}

/** The open (pending, unexpired, unused, unrevoked) activation link of the user, if any. */
async function openLink(prisma: PrismaService, invitations: InvitationsService, userId: string) {
  const invitation = await invitations.latest(userId);
  const now = new Date();
  if (
    !invitation ||
    invitation.state !== 'PENDING' ||
    !invitation.expiresAt ||
    invitation.expiresAt <= now ||
    !invitation.providerInvitationId
  )
    return null;
  const token = await prisma.nativeAuthToken.findUnique({
    where: { id: invitation.providerInvitationId },
  });
  if (!token || token.usedAt || token.revokedAt || token.expiresAt <= now) return null;
  return token;
}
