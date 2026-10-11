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
  // Legacy URLs of the Bottles reorganization: real HTTP redirects (no page render, no client
  // JavaScript needed). Next.js passes the query string through (e.g. ?page=2). 307, not 308:
  // these aliases may still change while Milestone 1 is DEV-only.
  async redirects() {
    return [
      { source: '/batches', destination: '/bottles/history', permanent: false },
      // The warehouse section opens on its main operator workflow.
      { source: '/warehouse', destination: '/warehouse/labels', permanent: false },
    ];
  },
  experimental: {
    // Local /api proxy (src/proxy.ts) buffers request bodies; allow artwork uploads up to the
    // API's own limit (LABEL_ARTWORK_MAX_BYTES, default 10 MiB) plus multipart overhead.
    proxyClientMaxBodySize: '12mb',
  },
};

export default nextConfig;
