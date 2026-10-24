/** Native activation of the ALREADY bootstrapped administrator. Never creates/grants a user. */
import { randomUUID } from 'node:crypto';
import { loadEnv } from '../config/env.js';
import { PrismaService } from '../database/prisma.service.js';
import { AuditService } from '../audit/audit.service.js';
import { NativeSecretBox } from './native-credentials.js';
import { NativeTokensService } from './native-tokens.service.js';
import { LocalInvitationsProvider } from './local-invitations.provider.js';
import { InvitationsService } from './invitations.service.js';

const index = process.argv.indexOf('--email');
const email = index >= 0 ? process.argv[index + 1]?.trim().toLowerCase() : undefined;
const env = loadEnv();
if (!email || env.AUTH_PROVIDER !== 'local')
  throw new Error(
    'Usage: native-invite-bootstrap --email <existing bootstrap administrator>; local authentication only',
  );
const prisma = new PrismaService(env);
const mail = new NativeTokensService(prisma, env, new NativeSecretBox(env.AUTH_ENCRYPTION_KEY));
try {
  const bootstrap = await prisma.identityBootstrap.findFirst({
    where: { email },
    include: { user: { include: { nativeCredential: true } } },
  });
  if (!bootstrap || bootstrap.user.status !== 'ACTIVE' || bootstrap.user.nativeCredential)
    throw new Error('Refused: no active, unactivated bootstrap administrator with this email');
  const admin = await prisma.userRole.count({
    where: { userId: bootstrap.userId, roleCode: 'ADMIN', revokedAt: null },
  });
  if (admin !== 1) throw new Error('Refused: bootstrap administrator has no active ADMIN grant');
  const invitations = new InvitationsService(
    prisma,
    new AuditService(prisma),
    new LocalInvitationsProvider(prisma, mail),
  );
  const latest = await invitations.latest(bootstrap.userId);
  if (!latest || latest.state !== 'PENDING' || !latest.expiresAt || latest.expiresAt <= new Date())
    await invitations.send(
      null,
      bootstrap.userId,
      randomUUID(),
      'Native activation of existing bootstrap administrator',
    );
  await mail.deliverPending();
  // Queued is not delivered: report what the outbox actually recorded, never the link itself.
  const invitation = await invitations.latest(bootstrap.userId);
  const token = invitation?.providerInvitationId
    ? await prisma.nativeAuthToken.findUnique({ where: { id: invitation.providerInvitationId } })
    : null;
  if (token?.sentAt) {
    console.log(
      `Activation email accepted by the mail server at ${token.sentAt.toISOString()}. No password, MFA secret or link is printed; the user, ADMIN grant and business data are unchanged.`,
    );
  } else {
    console.error(
      `Activation email NOT delivered yet (attempts: ${token?.deliveryAttempts ?? 0}). It stays queued and the running API retries it; check the SMTP configuration. Nothing else was changed.`,
    );
    process.exitCode = 1;
  }
} finally {
  mail.onModuleDestroy();
  await prisma.$disconnect();
}
