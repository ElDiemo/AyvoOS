import { createHash } from 'node:crypto';
import { readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { PORTAL_PACKAGE_MAX_MS, PORTAL_PACKAGE_MAX_ZIP_BYTES } from '@ayvo/types';
import { afterAll, describe, expect, it } from 'vitest';
import { hasCompose, prodSecrets, renderProd, repoRoot } from './support/prod-compose.js';

/**
 * The hotel portal on PROD (doc 064 option A1, ADR 0045 amendment), from the REAL Compose files
 * rendered with fictional values — nothing is started. The unit is private (compose.portal.yml);
 * the public site is a separate overlay (compose.portal-edge.yml, PORTAL_PUBLIC=on). The public
 * edge's global options stay exactly as they are for QR, ID and marketing.
 */
const read = (f: string) => readFileSync(join(repoRoot, f), 'utf8');
const code = (text: string) =>
  text
    .split('\n')
    .filter((l) => !/^\s*#/.test(l))
    .join('\n');
const sha = (v: string) => createHash('sha256').update(v).digest('hex');
const CORE = 'p'.repeat(43);
const FIN = 'q'.repeat(43);
const secrets = prodSecrets(
  `PORTAL_DOMAIN=portal.example.test\nPORTAL_CORE_TOKEN=${CORE}\nPORTAL_FINANCE_TOKEN=${FIN}\n` +
    `PORTAL_SERVICE_TOKEN_SHA256=${sha(CORE)}\nPORTAL_FINANCE_TOKEN_SHA256=${sha(FIN)}\n`,
);
afterAll(() => rmSync(secrets, { recursive: true, force: true }));
const env = { PORTAL_DOMAIN: 'portal.example.test', PORTAL_RELEASE: 'abcdef012345-0123456789ab' };

type Svc = {
  networks?: Record<string, unknown>;
  ports?: unknown[];
  environment?: Record<string, string>;
  volumes?: { target: string }[];
  [k: string]: unknown;
};
const render = (edge: boolean) => {
  const r = renderProd(secrets, {
    overrides: ['compose.portal.yml', ...(edge ? ['compose.portal-edge.yml'] : [])],
    profiles: ['portal', 'finance'],
    env,
  });
  expect(r.status, r.stderr).toBe(0);
  return r.config as unknown as {
    services: Record<string, Svc>;
    networks: Record<string, { internal?: boolean }>;
  };
};
const members = (cfg: ReturnType<typeof render>, network: string) =>
  Object.entries(cfg.services)
    .filter(([, s]) => s.networks && network in s.networks)
    .map(([n]) => n)
    .sort();

describe.skipIf(!hasCompose)('hotel portal on PROD: the rendered topology', () => {
  it('private unit: portal-web is unprivileged, bounded, unpublished, on two internal networks only', () => {
    const cfg = render(false);
    const p = cfg.services['portal-web']!;
    expect(p.image).toBe('ayvo-prod/portal-web:abcdef012345-0123456789ab');
    expect(p.read_only).toBe(true);
    expect(p.cap_drop).toEqual(['ALL']);
    expect(p.security_opt).toEqual(['no-new-privileges:true']);
    expect(String(p.mem_limit)).toMatch(/^(256m|268435456)$/);
    expect(Number(p.cpus)).toBe(0.5);
    expect(p.pids_limit).toBe(128);
    expect(p.ports ?? []).toEqual([]);
    expect(Object.keys(p.networks!).sort()).toEqual(['portal-contracts', 'portal-edge']);
    expect(cfg.networks['portal-contracts']!.internal).toBe(true);
    expect(cfg.networks['portal-edge']!.internal).toBe(true);
    expect(members(cfg, 'portal-contracts')).toEqual(['api', 'finance', 'portal-web']);
    // Private: no edge joins the portal network, no site is mounted.
    expect(members(cfg, 'portal-edge')).toEqual(['portal-web']);
    expect(
      (cfg.services['qr-edge']!.volumes ?? []).some((v) => v.target.endsWith('portal.caddy')),
    ).toBe(false);
  });

  it('the tokens: each receiver gets only its SHA-256; portal-web gets both tokens, nobody else', () => {
    const cfg = render(false);
    const api = cfg.services.api!.environment!;
    const fin = cfg.services.finance!.environment!;
    const p = cfg.services['portal-web']!.environment!;
    expect(api.PORTAL_SERVICE_TOKEN_SHA256).toBe(sha(CORE));
    expect(api.PORTAL_PUBLIC_ORIGIN).toBe('https://portal.example.test');
    expect(fin.PORTAL_FINANCE_TOKEN_SHA256).toBe(sha(FIN));
    expect([p.PORTAL_CORE_TOKEN, p.PORTAL_FINANCE_TOKEN]).toEqual([CORE, FIN]);
    for (const [name, s] of Object.entries(cfg.services))
      if (name !== 'portal-web')
        expect(JSON.stringify(s.environment ?? {}), name).not.toMatch(new RegExp(`${CORE}|${FIN}`));
    expect(p).toMatchObject({
      APP_ENV: 'production',
      PORTAL_PUBLIC_ORIGIN: 'https://portal.example.test',
      CORE_INTERNAL_URL: 'http://api:4000',
      FINANCE_INTERNAL_URL: 'http://finance:4010',
      PORTAL_TRUST_PROXY: '1',
    });
  });

  it('A1: the invoice package fits under the public edge’s unchanged 30 s write limit', () => {
    const cfg = render(false);
    const fin = cfg.services.finance!.environment!;
    const deadline = Number(cfg.services['portal-web']!.environment!.PORTAL_PACKAGE_DEADLINE_MS);
    const write = Number(/write (\d+)s/.exec(code(read('deploy/prod/Caddyfile.qr')))![1]) * 1000;
    expect(write).toBe(30_000);
    expect(Number(fin.FINANCE_PORTAL_PACKAGE_MAX_BYTES)).toBeLessThanOrEqual(20 * 1024 * 1024);
    expect(Number(fin.FINANCE_PORTAL_PACKAGE_MAX_BYTES)).toBeLessThanOrEqual(
      PORTAL_PACKAGE_MAX_ZIP_BYTES,
    );
    expect(Number(fin.FINANCE_PORTAL_PACKAGE_TIMEOUT_MS)).toBeLessThan(deadline);
    expect(deadline).toBeLessThan(write);
    expect(Number(fin.FINANCE_PORTAL_PACKAGE_TIMEOUT_MS)).toBeLessThanOrEqual(
      PORTAL_PACKAGE_MAX_MS,
    );
  });

  it('public site (PORTAL_PUBLIC=on): qr-edge gets one more site file and the portal network only', () => {
    const cfg = render(true);
    const qr = cfg.services['qr-edge']!;
    expect(members(cfg, 'portal-edge')).toEqual(['portal-web', 'qr-edge']);
    expect(qr.volumes!.some((v) => v.target === '/etc/caddy/sites/portal.caddy')).toBe(true);
    expect(qr.environment!.PORTAL_DOMAIN).toBe('portal.example.test');
    // The edge never joins the contracts or the backend: no route to api, Finance or a database.
    expect(Object.keys(qr.networks!)).not.toContain('portal-contracts');
    expect(Object.keys(qr.networks!)).not.toContain('backend');
    expect(
      cfg.services.caddy!.volumes!.some((v) => v.target === '/etc/caddy/acme.d/portal.caddy'),
    ).toBe(true);
    for (const name of ['postgres', 'redis', 'web', 'caddy'])
      for (const net of ['portal-contracts', 'portal-edge'])
        expect(members(cfg, net), `${name} on ${net}`).not.toContain(name);
  });
});

describe('hotel portal on PROD: the edge files', () => {
  const site = code(read('deploy/prod/sites/portal.caddy'));
  const qr = read('deploy/prod/Caddyfile.qr');

  it('the public edge’s global options are exactly the existing ones (QR/ID/marketing unchanged)', () => {
    const servers = qr.split('servers {')[1]!.split('\n\t}\n')[0]!;
    expect(code(servers).replace(/\s+/g, ' ').trim()).toBe(
      'strict_sni_host on timeouts { read_header 10s read_body 10s write 30s idle 60s } max_header_size 16KB protocols h1 h2',
    );
    expect(qr).toContain('import /etc/caddy/sites/*.caddy');
  });

  it('the portal site: no /api, only portal-web, small bodies with read deadlines, no write override', () => {
    expect(site).toMatch(/@blocked path \/api \/api\/\*\n\thandle @blocked \{\n\t\tabort/);
    const upstreams = [...site.matchAll(/reverse_proxy(?: @\w+)? (\S+)/g)].map((m) => m[1]);
    expect(new Set(upstreams)).toEqual(new Set(['portal-web:3200']));
    expect(site).not.toMatch(/web:3000|api:4000|finance:4010|marketing:8080/);
    expect(site).toContain('max_size 4KiB');
    expect(site).toContain('max_size 8KiB');
    expect(site.match(/read_timeout 5s 819/g)).toHaveLength(2);
    expect(site).not.toMatch(/write_timeout|servers|write \d/);
    expect(site).toMatch(/method\('POST'\) && path\('\/auth', '\/auth\/\*'\)/);
    expect(site).toContain('respond 405');
  });

  it('the internal Caddy forwards only the portal’s ACME challenges to qr-edge, else → https', () => {
    const acme = code(read('deploy/prod/acme.d/portal.caddy'));
    expect(acme).toContain('http://{$PORTAL_DOMAIN} {');
    expect(acme).toMatch(/path_regexp \^\/\\\.well-known\/acme-challenge\/\[A-Za-z0-9_-\]\+\$/);
    expect(acme).toContain('reverse_proxy qr-edge:80');
    expect(acme).toContain('redir https://{host}{uri} 301');
  });

  it('the deploy script: the OS deployment never starts portal-web; --portal needs the DEV-accepted image', () => {
    const script = read('scripts/deploy-prod.sh');
    const start = script.split('start_services() {')[1]!.split('\n}\n')[0]!;
    expect(start).not.toContain('portal');
    expect(script).toMatch(/--portal needs --expect-image sha256:<id>/);
    expect(script).toMatch(/compose --profile portal up -d --no-build --no-deps portal-web/);
    expect(script).toMatch(
      /PORTAL_PUBLIC == on && -f \$dir\/deploy\/prod\/compose\.portal-edge\.yml/,
    );
  });
});
