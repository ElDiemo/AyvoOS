import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { financeSetupStatements } from '../src/finance/db-setup.js';

/**
 * The Finance unit in the REAL DEV topology (ADR 0039; review FIN67-R1/R2): deploy/dev/compose.yml
 * is rendered by `docker compose config` (all profiles, fictional env values) and checked as
 * rendered — every pre-existing volume keeps its physical name and its mount, Finance has its own
 * volume, PostgreSQL shares a network with Finance and its migration runner, Finance shares none
 * with Redis. Then, on throwaway networks and containers built from that render (never the live
 * project), the exact Finance setup statements run and the owner and runtime roles connect over
 * those networks. Containers run in CI only, or with AYVO_DOCKER_TESTS=1.
 */
const root = resolve(import.meta.dirname, '../../..');
const run = (cmd: string, args: string[]) => spawnSync(cmd, args, { cwd: root, encoding: 'utf8' });
const hasDocker = run('docker', ['compose', 'version']).status === 0;
const WANT_CONTAINERS = hasDocker && !!(process.env.CI || process.env.AYVO_DOCKER_TESTS);

/** The volumes of the DEV stack before Finance (physical names = the data on the server). */
const EXISTING_VOLUMES = {
  'postgres-data': 'ayvo-dev-preview-postgres-data',
  'redis-data': 'ayvo-dev-preview-redis-data',
  'caddy-data': 'ayvo-dev-preview-caddy-data',
  'caddy-config': 'ayvo-dev-preview-caddy-config',
  'acme-webroot': 'ayvo-dev-preview-acme-webroot',
  'files-data': 'ayvo-dev-preview-files-data',
};
/** Their mounts before Finance (service → logical volume → target). */
const EXISTING_MOUNTS: Record<string, Record<string, string>> = {
  api: { 'files-data': '/var/lib/ayvo/files' },
  postgres: { 'postgres-data': '/var/lib/postgresql' },
  redis: { 'redis-data': '/data' },
  caddy: {
    'caddy-data': '/data',
    'caddy-config': '/config',
    'acme-webroot': '/srv/acme',
  },
  web: {},
  dns: {},
  migrate: {},
};

interface Rendered {
  services: Record<
    string,
    {
      networks?: Record<string, unknown>;
      volumes?: { type: string; source: string; target: string }[];
    }
  >;
  networks: Record<string, { name: string; internal?: boolean }>;
  volumes: Record<string, { name: string }>;
}

function render(): Rendered {
  const dir = mkdtempSync(join(tmpdir(), 'ayvo-fin-compose-'));
  const env = join(dir, 'synthetic.env');
  const hex = (n: number) => randomBytes(n).toString('hex');
  writeFileSync(
    env,
    [
      'APP_ENV=development',
      'DEV_DOMAIN=dev.example.test',
      'ACME_EMAIL=ops@example.test',
      'DEV_TAILNET_IPV4=100.64.0.1',
      'POSTGRES_USER=fixture',
      `POSTGRES_PASSWORD=${hex(24)}`,
      'POSTGRES_DB=fixture_db',
      `AUTH_ENCRYPTION_KEY=${hex(32)}`,
      'AUTH_MAIL_DRIVER=smtp',
      'AUTH_MAIL_FROM=noreply@example.test',
      `FINANCE_DB_PASSWORD=${hex(24)}`,
      `FINANCE_DB_OWNER_PASSWORD=${hex(24)}`,
      'FINANCE_IMAGE_TAG=fixture',
      '',
    ].join('\n'),
  );
  const res = run('docker', [
    'compose',
    '-f',
    'deploy/dev/compose.yml',
    '--env-file',
    env,
    '--profile',
    'tools',
    '--profile',
    'finance',
    '--profile',
    'finance-tools',
    'config',
    '--format',
    'json',
  ]);
  expect(res.status, res.stderr).toBe(0);
  return JSON.parse(res.stdout) as Rendered;
}

const networksOf = (r: Rendered, service: string) =>
  Object.keys(r.services[service]?.networks ?? {}).sort();
const mountsOf = (r: Rendered, service: string) =>
  Object.fromEntries(
    (r.services[service]?.volumes ?? [])
      .filter((v) => v.type === 'volume')
      .map((v) => [v.source, v.target]),
  );

describe.skipIf(!hasDocker)('the Finance unit in the rendered DEV Compose (FIN67-R1/R2)', () => {
  let r: Rendered;
  beforeAll(() => {
    r = render();
  });

  it('every pre-existing volume keeps its physical name; Finance has its own', () => {
    for (const [logical, name] of Object.entries(EXISTING_VOLUMES))
      expect([logical, r.volumes[logical]?.name]).toEqual([logical, name]);
    expect(r.volumes['finance-files']?.name).toBe('ayvo-dev-preview-finance-files');
    const names = Object.values(r.volumes).map((v) => v.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it('every pre-existing mount is unchanged; Finance mounts only its own volume', () => {
    for (const [service, mounts] of Object.entries(EXISTING_MOUNTS))
      expect([service, mountsOf(r, service)]).toEqual([service, mounts]);
    expect(mountsOf(r, 'finance')).toEqual({ 'finance-files': '/var/lib/ayvo/files' });
    expect(mountsOf(r, 'finance-migrate')).toEqual({});
  });

  it('PostgreSQL shares finance-db with Finance and its migrations; Redis and the API do not', () => {
    expect(networksOf(r, 'postgres')).toEqual(['backend', 'finance-db']);
    expect(networksOf(r, 'finance')).toEqual(['edge', 'finance-db']);
    expect(networksOf(r, 'finance-migrate')).toEqual(['finance-db']);
    expect(networksOf(r, 'redis')).toEqual(['backend']);
    expect(networksOf(r, 'migrate')).toEqual(['backend']);
    expect(networksOf(r, 'api')).toEqual(['backend', 'edge']);
    expect(r.networks['finance-db']?.internal).toBe(true);
    expect(r.networks.backend?.internal).toBe(true);
  });
});

describe.skipIf(!WANT_CONTAINERS)('Finance reaches PostgreSQL over the rendered networks', () => {
  const id = randomBytes(4).toString('hex');
  const pgImage = 'postgres:18-alpine';
  const redisImage = 'redis:8-alpine';
  const db = 'fixture_db';
  const superPassword = randomBytes(24).toString('hex');
  const roles = {
    ownerRole: 'ayvo_finance_owner',
    ownerPassword: randomBytes(24).toString('hex'),
    runtimeRole: 'ayvo_finance',
    runtimePassword: randomBytes(24).toString('hex'),
    runtimeConnections: 5,
  };
  const net = (logical: string) => `ayvo-fin-${logical}-${id}`;
  const box = (service: string) => `ayvo-fin-${service}-${id}`;
  const created: { containers: string[]; networks: string[] } = { containers: [], networks: [] };
  const docker = (args: string[]) => {
    const res = run('docker', args);
    expect(res.status, `docker ${args.join(' ')}: ${res.stderr}`).toBe(0);
    return res.stdout.trim();
  };
  /** A container on exactly the rendered networks of `service`, reachable by its service name. */
  const start = (service: string, image: string, nets: string[], args: string[]) => {
    docker([
      'run',
      '-d',
      '--name',
      box(service),
      '--network',
      net(nets[0]!),
      '--network-alias',
      service,
      ...args.slice(0, args.indexOf('--')),
      image,
      ...args.slice(args.indexOf('--') + 1),
    ]);
    created.containers.push(box(service));
    for (const n of nets.slice(1))
      docker(['network', 'connect', '--alias', service, net(n), box(service)]);
  };
  const psqlAs = (service: string, user: string, password: string, sql: string) =>
    run('docker', [
      'exec',
      box(service),
      'psql',
      `postgresql://${user}:${password}@postgres:5432/${db}`,
      '-tAc',
      sql,
    ]);

  beforeAll(() => {
    const r = render();
    for (const logical of new Set(
      ['postgres', 'redis', 'finance', 'finance-migrate'].flatMap((s) => networksOf(r, s)),
    )) {
      docker([
        'network',
        'create',
        ...(r.networks[logical]?.internal ? ['--internal'] : []),
        net(logical),
      ]);
      created.networks.push(net(logical));
    }
    start('postgres', pgImage, networksOf(r, 'postgres'), [
      '-e',
      'POSTGRES_USER=fixture',
      '-e',
      `POSTGRES_PASSWORD=${superPassword}`,
      '-e',
      `POSTGRES_DB=${db}`,
      '--',
    ]);
    start('redis', redisImage, networksOf(r, 'redis'), ['--']);
    // Probes with a psql client in the places of Finance and its migration runner.
    start('finance', pgImage, networksOf(r, 'finance'), ['--entrypoint', 'sleep', '--', '600']);
    start('finance-migrate', pgImage, networksOf(r, 'finance-migrate'), [
      '--entrypoint',
      'sleep',
      '--',
      '600',
    ]);
    for (let i = 0; i < 60; i++) {
      if (
        run('docker', ['exec', box('postgres'), 'pg_isready', '-U', 'fixture', '-d', db]).status ===
        0
      )
        break;
      spawnSync('sleep', ['1']);
    }
    // A core table owned by the superuser (as on the server), then the exact Finance setup.
    docker([
      'exec',
      box('postgres'),
      'psql',
      '-U',
      'fixture',
      '-d',
      db,
      '-c',
      'CREATE TABLE users (id int)',
    ]);
    for (const sql of financeSetupStatements(roles, db))
      docker([
        'exec',
        box('postgres'),
        'psql',
        '-v',
        'ON_ERROR_STOP=1',
        '-U',
        'fixture',
        '-d',
        db,
        '-c',
        sql,
      ]);
  }, 180_000);

  afterAll(() => {
    for (const c of created.containers) run('docker', ['rm', '-f', c]);
    for (const n of created.networks) run('docker', ['network', 'rm', n]);
  });

  it('the migration runner connects as the schema owner; Finance as its runtime role', () => {
    const owner = psqlAs(
      'finance-migrate',
      roles.ownerRole,
      roles.ownerPassword,
      'SELECT current_user',
    );
    expect([owner.status, owner.stdout.trim()], owner.stderr).toEqual([0, roles.ownerRole]);
    const runtime = psqlAs(
      'finance',
      roles.runtimeRole,
      roles.runtimePassword,
      'SELECT current_user',
    );
    expect([runtime.status, runtime.stdout.trim()], runtime.stderr).toEqual([0, roles.runtimeRole]);
  });

  it('over those networks neither role reads a core table', () => {
    const res = psqlAs(
      'finance',
      roles.runtimeRole,
      roles.runtimePassword,
      'SELECT * FROM public.users',
    );
    expect(res.status).not.toBe(0);
    expect(res.stderr).toMatch(/permission denied/);
  });

  it('Finance cannot reach Redis (no shared network), the core containers can', () => {
    expect(run('docker', ['exec', box('finance'), 'getent', 'hosts', 'redis']).status).not.toBe(0);
    expect(run('docker', ['exec', box('postgres'), 'getent', 'hosts', 'redis']).status).toBe(0);
  });
});
