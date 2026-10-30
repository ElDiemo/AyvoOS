import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadFinanceEnv } from '../src/finance/finance-env.js';

/**
 * Finance's invoice mail in the deployment (doc 043 §5), from the repository only: the same overlay
 * on DEV and PROD, no port, network or other service added, the host guards untouched, and the same
 * settings check in both deployment scripts. Nothing is started and no connection is made.
 */
const root = resolve(import.meta.dirname, '../../..');
const read = (path: string) => readFileSync(join(root, path), 'utf8');
const hasDocker = spawnSync('docker', ['compose', 'version']).status === 0;

interface Rendered {
  services: Record<
    string,
    { environment?: Record<string, string>; ports?: unknown[]; networks?: Record<string, unknown> }
  >;
}
const OVERLAY = (e: string) => `deploy/${e}/compose.invoice-mail.yml`;

function overlayOnly(e: 'dev' | 'prod'): Rendered {
  const dir = mkdtempSync(join(tmpdir(), 'ayvo-mail-compose-'));
  try {
    const env = join(dir, 'synthetic.env');
    writeFileSync(
      env,
      [
        'DEV_DOMAIN=dev.example.test',
        'PROD_DOMAIN=os.example.test',
        'FINANCE_INVOICE_MAIL=google-relay',
        'FINANCE_MAIL_TEST_RECIPIENTS=schvaleny@example.test',
        '',
      ].join('\n'),
    );
    const res = spawnSync(
      'docker',
      [
        'compose',
        '-f',
        OVERLAY(e),
        '--env-file',
        env,
        'config',
        '--no-consistency',
        '--format',
        'json',
      ],
      { cwd: root, encoding: 'utf8' },
    );
    expect(res.status, res.stderr).toBe(0);
    return JSON.parse(res.stdout) as Rendered;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const problem = (driver: string, recipients: string, production: string) =>
  spawnSync(
    'bash',
    [
      '-c',
      'source scripts/lib/invoice-mail.sh; invoice_mail_settings_problem "$@"',
      'x',
      driver,
      recipients,
      production,
    ],
    { cwd: root, encoding: 'utf8' },
  );

describe('Finance invoice mail in the deployment', () => {
  it('the overlays differ only in the host name; they name only Finance and add no port or network', () => {
    const strip = (s: string) =>
      s
        .split('\n')
        .filter((l) => !l.startsWith('#'))
        .join('\n')
        .replace(/\$\{(DEV|PROD)_DOMAIN:[^}]*\}/, 'DOMAIN');
    expect(strip(read(OVERLAY('dev')))).toBe(strip(read(OVERLAY('prod'))));
    for (const e of ['dev', 'prod'] as const) {
      const text = read(OVERLAY(e));
      expect(text).not.toMatch(/^\s+(ports|networks|volumes):/m);
      expect(text).not.toMatch(/^networks:/m);
    }
  });

  it.skipIf(!hasDocker)('rendered: the same three settings on Finance alone', () => {
    for (const [e, ehlo] of [
      ['dev', 'dev.example.test'],
      ['prod', 'os.example.test'],
    ] as const) {
      const r = overlayOnly(e);
      expect(Object.keys(r.services)).toEqual(['finance']);
      expect(r.services.finance!.environment).toEqual({
        FINANCE_INVOICE_MAIL: 'google-relay',
        FINANCE_MAIL_EHLO_NAME: ehlo,
        FINANCE_MAIL_TEST_RECIPIENTS: 'schvaleny@example.test',
      });
      expect(r.services.finance!.ports ?? []).toEqual([]);
    }
  });

  it('Finance has the same networks on DEV and PROD, the host guards filter only incoming traffic', () => {
    for (const e of ['dev', 'prod']) {
      const compose = read(`deploy/${e}/compose.yml`);
      const finance = compose.slice(compose.indexOf('\n  finance:\n'));
      expect(finance.slice(finance.indexOf('networks:'), finance.indexOf('healthcheck:'))).toMatch(
        /- edge\s+- finance-db/,
      );
      const guard = read(`deploy/${e}/host/ayvo-${e}-docker-guard`);
      expect(guard).toContain('-i "$ext"');
      expect(guard).not.toContain('587');
    }
  });

  it('one settings check: simulation never in production, the relay only with allowed recipients', () => {
    expect(problem('simulation', '', 'false').status).toBe(0);
    expect(problem('google-relay', 'a@example.test,b@example.test', 'true').status).toBe(0);
    for (const [driver, recipients, production] of [
      ['simulation', '', 'true'],
      ['google-relay', '', 'false'],
      ['google-relay', '', 'true'],
      ['google-relay', 'neni-adresa', 'false'],
      ['memory', '', 'false'],
      ['', '', 'false'],
    ] as const)
      expect(problem(driver, recipients, production).status, driver).toBe(1);
    for (const script of ['scripts/deploy-finance-dev.sh', 'scripts/deploy-prod.sh']) {
      const s = read(script);
      expect(s).toContain('source "$REPO_ROOT/scripts/lib/invoice-mail.sh"');
      expect(s).toContain('compose.invoice-mail.yml');
    }
  });

  it('the application refuses the simulation in production', () => {
    const base = {
      FINANCE_DATABASE_URL: 'postgresql://u:p@localhost/x',
      CORE_INTERNAL_URL: 'http://core:4000',
      FINANCE_SERVICE_TOKEN: 'x'.repeat(43),
      FINANCE_INVOICE_MAIL: 'simulation',
    };
    expect(() => loadFinanceEnv({ ...base, APP_ENV: 'development' })).not.toThrow();
    expect(() =>
      loadFinanceEnv({ ...base, APP_ENV: 'production', FILE_STORAGE_DRIVER: 's3' }),
    ).toThrow(/FINANCE_INVOICE_MAIL/);
  });
});
