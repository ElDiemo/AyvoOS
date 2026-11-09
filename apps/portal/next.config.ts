import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import type { NextConfig } from 'next';

// Local development reads the repository-level .env; deployed environments inject real env vars.
const envFile = resolve(import.meta.dirname, '../../.env');
if (existsSync(envFile)) process.loadEnvFile(envFile);

/**
 * portal-web (ADR 0045 §1): the only thing a hotel user's browser talks to. Its server side holds
 * the portal cookies and calls the core and Finance contracts; it owns no data. Strict headers:
 * never framed, no referrer, no sniffing; nothing cached that a session sees.
 */
const nextConfig: NextConfig = {
  reactStrictMode: true,
  output: 'standalone',
  outputFileTracingRoot: resolve(import.meta.dirname, '../..'),
  typescript: { tsconfigPath: 'tsconfig.build.json' },
  poweredByHeader: false,
  async headers() {
    const common = [
      { key: 'X-Frame-Options', value: 'DENY' },
      { key: 'Referrer-Policy', value: 'no-referrer' },
      { key: 'X-Content-Type-Options', value: 'nosniff' },
      { key: 'X-Robots-Tag', value: 'noindex, nofollow' },
    ];
    // Pages get a per-request nonce policy from src/proxy.ts. The route handlers it skips (JSON
    // sign-in steps, the profile save and the PDF) run no script at all.
    const noScripts = {
      key: 'Content-Security-Policy',
      value: "default-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
    };
    return [
      { source: '/:path*', headers: common },
      { source: '/auth/:path*', headers: [noScripts] },
      { source: '/invoices/:id/pdf', headers: [noScripts] },
      { source: '/contracts/:id/pdf', headers: [noScripts] },
      { source: '/invoices/package', headers: [noScripts] },
      { source: '/hotels/:id/profile', headers: [noScripts] },
    ];
  },
};

export default nextConfig;
