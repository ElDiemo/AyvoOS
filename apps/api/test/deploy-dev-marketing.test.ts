import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';

/**
 * The marketing site's DEV preview (ADR 0040) in the REAL rendered DEV topology
 * (`docker compose config`, all profiles, fictional values): Caddy publishes exactly the ports it
 * did before plus :8443 on the tailnet address only; the marketing container is only on its own
 * internal network, shared with Caddy alone; every pre-existing volume keeps its physical name
 * and mount; scripts/deploy-dev.sh accepts exactly that one more port.
 */
const root = resolve(import.meta.dirname, '../../..');
const run = (args: string[]) => spawnSync('docker', args, { cwd: root, encoding: 'utf8' });
const hasDocker = run(['compose', 'version']).status === 0;
const TAILNET = '100.64.0.1';

interface Rendered {
  services: Record<
    string,
    {
      networks?: Record<string, unknown>;
      ports?: { host_ip?: string; published?: string; target: number; protocol?: string }[];
      volumes?: { type: string; source: string; target: string }[];
      read_only?: boolean;
      cap_drop?: string[];
      environment?: Record<string, string>;
    }
  >;
  networks: Record<string, { internal?: boolean }>;
  volumes: Record<string, { name: string }>;
}

describe.skipIf(!hasDocker)('the marketing DEV preview in the rendered DEV Compose', () => {
  let r: Rendered;
  beforeAll(() => {
    const dir = mkdtempSync(join(tmpdir(), 'ayvo-dev-mkt-'));
    const env = join(dir, 'synthetic.env');
    writeFileSync(
      env,
      [
        'APP_ENV=development',
        'DEV_DOMAIN=dev.example.test',
        'ACME_EMAIL=ops@example.test',
        `DEV_TAILNET_IPV4=${TAILNET}`,
        'POSTGRES_USER=fixture',
        `POSTGRES_PASSWORD=${randomBytes(24).toString('hex')}`,
        `CORE_DB_PASSWORD=${randomBytes(24).toString('hex')}`,
        'POSTGRES_DB=fixture_db',
        `AUTH_ENCRYPTION_KEY=${randomBytes(32).toString('hex')}`,
        'AUTH_MAIL_DRIVER=smtp',
        'AUTH_MAIL_FROM=noreply@example.test',
        'MARKETING_IMAGE_TAG=fixture',
        '',
      ].join('\n'),
    );
    const res = run([
      'compose',
      '-f',
      'deploy/dev/compose.yml',
      '--env-file',
      env,
      '--profile',
      'tools',
      '--profile',
      'marketing',
      'config',
      '--format',
      'json',
    ]);
    expect(res.status, res.stderr).toBe(0);
    r = JSON.parse(res.stdout) as Rendered;
  });

  it('Caddy publishes 443 (tcp/udp), :80 and only now :8443 — the new port on the tailnet address only', () => {
    const ports = r.services.caddy!.ports!.map(
      (p) => `${p.host_ip ?? ''}:${p.published}->${p.target}/${p.protocol ?? 'tcp'}`,
    );
    expect(ports.sort()).toEqual(
      [
        `${TAILNET}:443->443/tcp`,
        `${TAILNET}:443->443/udp`,
        `${TAILNET}:8443->8443/tcp`,
        '0.0.0.0:80->80/tcp',
      ].sort(),
    );
  });

  it('the marketing container: its own internal network shared only with Caddy; read-only, no capabilities, not indexed', () => {
    const m = r.services.marketing!;
    expect(Object.keys(m.networks!)).toEqual(['marketing']);
    expect(r.networks.marketing?.internal).toBe(true);
    const members = Object.entries(r.services)
      .filter(([, s]) => Object.keys(s.networks ?? {}).includes('marketing'))
      .map(([n]) => n)
      .sort();
    expect(members).toEqual(['caddy', 'marketing']);
    expect(m.read_only).toBe(true);
    expect(m.cap_drop).toEqual(['ALL']);
    expect(m.ports ?? []).toEqual([]);
    expect(m.volumes ?? []).toEqual([]);
    expect(m.environment?.AYVO_MARKETING_ROBOTS).toBe('noindex, nofollow');
  });

  it('every pre-existing volume keeps its physical name', () => {
    expect(Object.fromEntries(Object.entries(r.volumes).map(([k, v]) => [k, v.name]))).toEqual({
      'postgres-data': 'ayvo-dev-preview-postgres-data',
      'redis-data': 'ayvo-dev-preview-redis-data',
      'caddy-data': 'ayvo-dev-preview-caddy-data',
      'caddy-config': 'ayvo-dev-preview-caddy-config',
      'acme-webroot': 'ayvo-dev-preview-acme-webroot',
      'files-data': 'ayvo-dev-preview-files-data',
    });
  });

  it('scripts/deploy-dev.sh accepts exactly that one more published port', () => {
    const script = readFileSync(join(root, 'scripts/deploy-dev.sh'), 'utf8');
    const allowed = script.split('local -A allowed=(')[1]!.split(')')[0]!;
    expect([...allowed.matchAll(/\["([^"]+)"\]=1/g)].map((m) => m[1]).sort()).toEqual(
      [
        'caddy $TAILNET_IPV4:443->443/tcp',
        'caddy $TAILNET_IPV4:443->443/udp',
        'caddy $TAILNET_IPV4:8443->8443/tcp',
        'caddy 0.0.0.0:80->80/tcp',
        'dns $TAILNET_IPV4:53->1053/tcp',
        'dns $TAILNET_IPV4:53->1053/udp',
      ].sort(),
    );
  });
});
