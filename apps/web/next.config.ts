import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import type { NextConfig } from 'next';

// Local development reads the repository-level .env; deployed environments inject real env vars.
const envFile = resolve(import.meta.dirname, '../../.env');
if (existsSync(envFile)) process.loadEnvFile(envFile);

const nextConfig: NextConfig = {
  reactStrictMode: true,
  // Self-contained server bundle for the Docker image (apps/web/Dockerfile). Tracing starts at the
  // monorepo root so workspace packages and pnpm's symlinked node_modules are included.
  output: 'standalone',
  outputFileTracingRoot: resolve(import.meta.dirname, '../..'),
  // @ayvo/ui ships TypeScript source; Next compiles it.
  transpilePackages: ['@ayvo/ui'],
};

export default nextConfig;
