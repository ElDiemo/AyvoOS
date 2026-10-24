/**
 * Native activation of the ALREADY bootstrapped administrator (doc 038 §4). Never creates or
 * grants a user, never prints a link. Usage:
 *   native-invite-bootstrap --email <bootstrap e-mail> [--resend]
 * Exit 0: accepted by the mail server now, or an earlier link is still usable (nothing sent).
 * Exit 1: refused, or queued and not accepted yet (the running API retries).
 * Exit 2: the open link was already used to start the setup, or its delivery is exhausted —
 *         run again with --resend for a new link (the old link and setup stop working).
 */
import { randomUUID } from 'node:crypto';
import { loadEnv } from '../config/env.js';
import { PrismaService } from '../database/prisma.service.js';
import { AuditService } from '../audit/audit.service.js';
import { NativeSecretBox } from './native-credentials.js';
import { NativeTokensService } from './native-tokens.service.js';
import { LocalInvitationsProvider } from './local-invitations.provider.js';
import { InvitationsService } from './invitations.service.js';
import { activateBootstrap, BootstrapActivationRefused } from './native-bootstrap-activation.js';

const index = process.argv.indexOf('--email');
const email = index >= 0 ? process.argv[index + 1]?.trim().toLowerCase() : undefined;
const resend = process.argv.includes('--resend');
const env = loadEnv();
if (!email || env.AUTH_PROVIDER !== 'local')
  throw new Error(
    'Usage: native-invite-bootstrap --email <existing bootstrap administrator> [--resend]; local authentication only',
  );
const prisma = new PrismaService(env);
const mail = new NativeTokensService(prisma, env, new NativeSecretBox(env.AUTH_ENCRYPTION_KEY));
const unchanged =
  'No password, MFA secret or link is printed; the user, ADMIN grant and business data are unchanged.';
try {
  const invitations = new InvitationsService(
    prisma,
    new AuditService(prisma),
    new LocalInvitationsProvider(prisma, mail),
  );
  const outcome = await activateBootstrap({ prisma, invitations, mail }, email, {
    resend,
    requestId: randomUUID(),
  });
  switch (outcome.kind) {
    case 'accepted':
      console.log(
        `${resend ? 'A new activation link' : 'The activation email'} was accepted by the mail server at ${outcome.sentAt.toISOString()} (link valid until ${outcome.expiresAt.toISOString()}); any earlier link no longer works. Delivery to the mailbox is confirmed by the recipient. ${unchanged}`,
      );
      break;
    case 'sent-earlier':
      console.log(
        `Nothing sent: an activation email was accepted by the mail server earlier, at ${outcome.sentAt.toISOString()}, and its link is unused and valid until ${outcome.expiresAt.toISOString()}. If it did not arrive, run again with --resend. ${unchanged}`,
      );
      break;
    case 'queued':
      console.error(
        `Activation email NOT accepted by the mail server yet (attempts: ${outcome.attempts}). It stays queued and the running API retries it; check the mail configuration. ${unchanged}`,
      );
      process.exitCode = 1;
      break;
    case 'needs-resend':
      console.error(
        outcome.why === 'setup-started'
          ? `Nothing sent: the activation link was already opened and its setup was not completed (or is still in progress in that browser). Run again with --resend for a new link; the old link and setup then stop working. ${unchanged}`
          : `Nothing delivered: all delivery attempts of the activation email failed. Fix the mail configuration, then run again with --resend. ${unchanged}`,
      );
      process.exitCode = 2;
      break;
  }
} catch (error) {
  if (!(error instanceof BootstrapActivationRefused)) throw error;
  console.error(error.message);
  process.exitCode = 1;
} finally {
  mail.onModuleDestroy();
  await prisma.$disconnect();
}
