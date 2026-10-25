import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { defineConfig } from 'prisma/config';

// Finance (ADR 0039): its own schema and migration history. Migrations run as the schema owner
// (FINANCE_MIGRATE_DATABASE_URL, ...?schema=finance) — never as the core's superuser.
const envFile = resolve(import.meta.dirname, '../../.env');
if (existsSync(envFile)) process.loadEnvFile(envFile);

export default defineConfig({
  schema: 'prisma-finance/schema.prisma',
  migrations: {
    path: 'prisma-finance/migrations',
  },
  ...(process.env.FINANCE_MIGRATE_DATABASE_URL && {
    datasource: { url: process.env.FINANCE_MIGRATE_DATABASE_URL },
  }),
});
