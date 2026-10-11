/**
 * One-time bootstrap of the first AYVO administrator (ADR 0022, doc 021).
 *
 *   node dist/identity/bootstrap-admin.js --email owner@example.com --name "Owner Name"
 *
 * Creates an ACTIVE user with the ADMIN role and records ADMIN_BOOTSTRAPPED in the audit. The
 * person then signs in through the identity provider with exactly this (verified) e-mail, which
 * links the identity. The database allows ONE bootstrap ever (identity_bootstrap has a single
 * row); afterwards this command refuses, and there is no endpoint or setting that does the same.
 */
import { PrismaPg } from '@prisma/adapter-pg';
import { createUserRequestSchema } from '@ayvo/types';
import { loadEnv } from '../config/env.js';
import { PrismaClient } from '../generated/prisma/client.js';
import { bootstrapFirstAdmin } from './bootstrap.js';

function arg(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

async function main(): Promise<number> {
  const parsed = createUserRequestSchema
    .pick({ email: true, displayName: true })
    .safeParse({ email: arg('email'), displayName: arg('name') });
  if (!parsed.success) {
    console.error('Usage: bootstrap-admin --email <verified e-mail> --name "<display name>"');
    return 2;
  }
  const env = loadEnv();
  const prisma = new PrismaClient({
    adapter: new PrismaPg({ connectionString: env.DATABASE_URL }),
  });
  try {
    const result = await bootstrapFirstAdmin(prisma, parsed.data);
    if (!result.ok) {
      const why = {
        ALREADY_BOOTSTRAPPED:
          'the first administrator was already bootstrapped (one-time operation)',
        ADMIN_EXISTS: 'an administrator already exists; use the user administration instead',
        USER_EXISTS: 'a user with this e-mail already exists',
      }[result.reason];
      console.error(`Refused: ${why}.`);
      return 1;
    }
    console.log(
      `First administrator created for ${result.email}. Sign in with this verified e-mail to link the identity. This command will refuse from now on.`,
    );
    return 0;
  } finally {
    await prisma.$disconnect();
  }
}

process.exitCode = await main();
