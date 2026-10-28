import { spawnSync } from 'node:child_process';
import { chmodSync, cpSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

/**
 * Renders the REAL production Compose files (deploy/prod) with fictional values, as
 * scripts/deploy-prod.sh would run them — nothing is started. Used where a test must read the
 * rendered topology rather than the YAML text.
 */
export const repoRoot = resolve(import.meta.dirname, '../../../..');
export const hasCompose =
  spawnSync('docker', ['compose', 'version'], { encoding: 'utf8' }).status === 0;

export interface RenderedService {
  environment?: Record<string, string>;
  volumes?: {
    type: string;
    source: string;
    target: string;
    read_only?: boolean;
    bind?: Record<string, unknown>;
  }[];
  [key: string]: unknown;
}
export interface Rendered {
  services: Record<string, RenderedService>;
}

/** A private secrets directory with the files the production project reads (fictional values). */
export function prodSecrets(prodEnvExtra = ''): string {
  const secrets = mkdtempSync(join(tmpdir(), 'ayvo-prod-secrets-'));
  writeFileSync(
    join(secrets, 'prod.env'),
    'POSTGRES_USER=ayvo\nPOSTGRES_PASSWORD=fictional\nCORE_DB_PASSWORD=cccccccccccccccccccccccccccccccc\nPOSTGRES_DB=ayvo_prod\nACME_EMAIL=ops@example.test\n' +
      `PUBLIC_QR_BASE_URL=https://qr.example.test\nFINANCE_DB_PASSWORD=${'r'.repeat(32)}\nFINANCE_DB_OWNER_PASSWORD=${'o'.repeat(32)}\n` +
      `FINANCE_SERVICE_TOKEN=${'f'.repeat(43)}\nFINANCE_SERVICE_TOKEN_SHA256=${'a'.repeat(64)}\n${prodEnvExtra}`,
  );
  writeFileSync(
    join(secrets, 'prod-auth.env'),
    'AUTH_ENCRYPTION_KEY=x\nAUTH_MAIL_DRIVER=google-relay\nAUTH_MAIL_FROM=s@example.test\n',
  );
  writeFileSync(
    join(secrets, 'prod-s3.env'),
    'AWS_ACCESS_KEY_ID=AKIAAPP\nAWS_SECRET_ACCESS_KEY=a\n',
  );
  writeFileSync(
    join(secrets, 'prod-finance-s3.env'),
    'AWS_ACCESS_KEY_ID=AKIAFIN\nAWS_SECRET_ACCESS_KEY=f\n',
  );
  return secrets;
}

/** Copies the bank connection files into <secrets>/rb-premium as the owner stores them (§10a). */
export function storeRbPremiumFiles(
  secrets: string,
  from: { clientId: string; p12: string; passphrase: string },
): string {
  const dir = join(secrets, 'rb-premium');
  mkdirSync(dir);
  for (const [name, src] of [
    ['client-id', from.clientId],
    ['certificate.p12', from.p12],
    ['p12-passphrase', from.passphrase],
  ] as const) {
    cpSync(src, join(dir, name));
    chmodSync(join(dir, name), 0o400);
  }
  chmodSync(dir, 0o500);
  return dir;
}

/** `docker compose config` of deploy/prod/compose.yml plus the given overrides, with profiles. */
export function renderProd(
  secrets: string,
  opts: { overrides?: string[]; profiles?: string[] } = {},
): { status: number | null; stderr: string; config: Rendered | null } {
  const prodDir = join(repoRoot, 'deploy/prod');
  const files = ['compose.yml', ...(opts.overrides ?? [])].flatMap((f) => ['-f', join(prodDir, f)]);
  const res = spawnSync(
    'docker',
    [
      'compose',
      '-p',
      'ayvo-prod-test',
      ...files,
      '--env-file',
      join(secrets, 'prod.env'),
      ...(opts.profiles ?? []).flatMap((p) => ['--profile', p]),
      'config',
      '--format',
      'json',
    ],
    {
      encoding: 'utf8',
      env: {
        ...process.env,
        PROD_DOMAIN: 'os.example.test',
        PROD_TAILNET_IPV4: '100.100.100.100',
        PROD_PUBLIC_IPV4: '198.51.100.7',
        QR_DOMAIN: 'qr.example.test',
        AYVO_RELEASE: 'abcdef012345',
        FINANCE_IMAGE: `sha256:${'1'.repeat(64)}`,
        FINANCE_MIGRATE_IMAGE: `sha256:${'2'.repeat(64)}`,
        AYVO_RELEASE_DIR: repoRoot,
        AYVO_PROD_SECRETS_DIR: secrets,
      },
    },
  );
  return {
    status: res.status,
    stderr: res.stderr,
    config: res.status === 0 ? (JSON.parse(res.stdout) as Rendered) : null,
  };
}
