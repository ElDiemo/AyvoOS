import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * The DEV portal-web image names its source commit (#186): PROD's `deploy-prod.sh --portal` loads
 * only an image whose `org.opencontainers.image.revision` is a full commit on origin/main. Checked
 * in the REAL rendered DEV Compose (`docker compose config`, fictional values): with
 * PORTAL_IMAGE_REVISION the label is exactly that commit; without it the label is `none`, which
 * PROD refuses.
 */
const root = resolve(import.meta.dirname, '../../..');
const run = (args: string[]) => spawnSync('docker', args, { cwd: root, encoding: 'utf8' });
const hasDocker = run(['compose', 'version']).status === 0;
const REVISION = '0123456789abcdef0123456789abcdef01234567';

const portalLabels = (extra: string[]): Record<string, string> | undefined => {
  const dir = mkdtempSync(join(tmpdir(), 'ayvo-dev-portal-rev-'));
  const env = join(dir, 'synthetic.env');
  writeFileSync(
    env,
    [
      'APP_ENV=development',
      'DEV_DOMAIN=dev.example.test',
      'ACME_EMAIL=ops@example.test',
      'DEV_TAILNET_IPV4=100.64.0.1',
      'POSTGRES_USER=fixture',
      `POSTGRES_PASSWORD=${randomBytes(24).toString('hex')}`,
      `CORE_DB_PASSWORD=${randomBytes(24).toString('hex')}`,
      'POSTGRES_DB=fixture_db',
      `AUTH_ENCRYPTION_KEY=${randomBytes(32).toString('hex')}`,
      'AUTH_MAIL_DRIVER=smtp',
      'AUTH_MAIL_FROM=noreply@example.test',
      ...extra,
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
    'portal',
    'config',
    '--format',
    'json',
  ]);
  expect(res.status, res.stderr).toBe(0);
  const rendered = JSON.parse(res.stdout) as {
    services: Record<string, { build?: { labels?: Record<string, string> } }>;
  };
  return rendered.services['portal-web']?.build?.labels;
};

describe.skipIf(!hasDocker)('the DEV portal-web image carries its source revision', () => {
  it('PORTAL_IMAGE_REVISION becomes the image label', () => {
    expect(portalLabels([`PORTAL_IMAGE_REVISION=${REVISION}`])).toEqual({
      'org.opencontainers.image.revision': REVISION,
    });
  });

  it('without it the label is "none" — an image PROD refuses', () => {
    expect(portalLabels([])).toEqual({ 'org.opencontainers.image.revision': 'none' });
    const prod = readFileSync(join(root, 'scripts/deploy-prod.sh'), 'utf8');
    const loader = prod.split('load_portal_image() {')[1]!.split('\n}\n')[0]!;
    expect(loader).toContain(
      '[[ $revision =~ ^[0-9a-f]{40}$ ]] || die "the image carries no source revision label"',
    );
  });
});
