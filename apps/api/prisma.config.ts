import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { defineConfig } from 'prisma/config';

// Load the repository-level .env for local development (no-op when absent, e.g. in CI).
const envFile = resolve(import.meta.dirname, '../../.env');
if (existsSync(envFile)) process.loadEnvFile(envFile);

export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: {
    path: 'prisma/migrations',
  },
  // Optional so `prisma generate` works without a database (e.g. CI); migrate commands require it.
  ...(process.env.DATABASE_URL && { datasource: { url: process.env.DATABASE_URL } }),
});
