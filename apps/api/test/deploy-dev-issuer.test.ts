import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/**
 * `scripts/deploy-dev.sh --check` verifies WORKOS_JWT_ISSUER against the client's WorkOS discovery
 * document (doc 021 §9). The real WorkOS endpoint is never contacted: `curl` and `docker` are
 * replaced by stubs on PATH; the curl stub only answers the fixed, trusted discovery URL. All
 * values below are fictional fixtures.
 */
const script = resolve(import.meta.dirname, '../../../scripts/deploy-dev.sh');
const CLIENT_ID = 'client_FIXTURE0000000000000000';
const API_KEY = 'sk_test_FIXTURE_not_a_real_key_000';
const ISSUER = `https://api.workos.com/user_management/${CLIENT_ID}`;
const DISCOVERY_URL = `${ISSUER}/.well-known/openid-configuration`;

let dir: string;

function write(path: string, content: string, mode = 0o700) {
  writeFileSync(path, content);
  chmodSync(path, mode);
}

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'ayvo-deploy-check-'));
  const bin = join(dir, 'bin');
  spawnSync('mkdir', [bin]);
  // curl stub: reads the curl config from stdin, refuses any URL except the trusted one and
  // answers according to FIXTURE (ok | foreign | invalid | missing | query | network).
  write(
    join(bin, 'curl'),
    `#!/usr/bin/env bash
config="$(cat)"
[[ $config == 'url = "${DISCOVERY_URL}"' ]] || { echo "unexpected url" >&2; exit 90; }
case "$FIXTURE" in
  ok) printf '{"issuer":"%s","jwks_uri":"x"}' "${ISSUER}" ;;
  foreign) printf '{"issuer":"https://api.workos.com/"}' ;;
  invalid) printf '<html>not json' ;;
  missing) printf '{"jwks_uri":"x"}' ;;
  query) printf '{"issuer":"%s?x=1"}' "${ISSUER}" ;;
  network) echo "curl: (6) Could not resolve host" >&2; exit 6 ;;
esac
`,
  );
  write(join(bin, 'docker'), '#!/usr/bin/env bash\nexit 0\n');
});

afterAll(() => rmSync(dir, { recursive: true, force: true }));

function check(fixture: string, issuer = ISSUER) {
  const env = join(dir, `dev-preview-${fixture}.env`);
  write(
    env,
    [
      'APP_ENV=development',
      'DEV_DOMAIN=dev.example-preview.test',
      'ACME_EMAIL=ops@ayvo.test',
      'DEV_BASIC_AUTH_USER=preview',
      `DEV_BASIC_AUTH_HASH='$2a$14$${'a'.repeat(53)}'`,
      'POSTGRES_USER=ayvo',
      `POSTGRES_PASSWORD=${'p'.repeat(32)}`,
      'POSTGRES_DB=ayvo',
      `WORKOS_API_KEY=${API_KEY}`,
      `WORKOS_CLIENT_ID=${CLIENT_ID}`,
      `WORKOS_JWT_ISSUER=${issuer}`,
      '',
    ].join('\n'),
    0o600,
  );
  const result = spawnSync('bash', [script, '--check'], {
    env: {
      ...process.env,
      PATH: `${join(dir, 'bin')}:${process.env.PATH}`,
      AYVO_DEV_ENV_FILE: env,
      FIXTURE: fixture,
    },
    encoding: 'utf8',
  });
  const output = `${result.stdout}${result.stderr}`;
  // Nothing identifying is ever printed, whatever the outcome.
  for (const secret of [CLIENT_ID, API_KEY, ISSUER, 'https://api.workos.com/"'])
    expect(output).not.toContain(secret);
  return { status: result.status, output };
}

describe('deploy-dev.sh --check: WorkOS issuer against the discovery document', () => {
  it('passes when WORKOS_JWT_ISSUER equals the discovery issuer exactly', () => {
    const { status, output } = check('ok');
    expect(output).toContain("WORKOS_JWT_ISSUER matches the client's WorkOS discovery document");
    expect(output).toContain('Check passed');
    expect(status).toBe(0);
  });

  it('fails on a generic WorkOS issuer that differs from the discovery document', () => {
    const { status, output } = check('ok', 'https://api.workos.com/');
    expect(status).not.toBe(0);
    expect(output).toContain('WORKOS_JWT_ISSUER does not exactly match');
  });

  it('fails when the discovery document declares a different issuer', () => {
    const { status, output } = check('foreign');
    expect(status).not.toBe(0);
    expect(output).toContain('WORKOS_JWT_ISSUER does not exactly match');
  });

  it.each(['invalid', 'missing'])('fails on a discovery document that is %s', (fixture) => {
    const { status, output } = check(fixture);
    expect(status).not.toBe(0);
    expect(output).toContain('not valid JSON or has no issuer');
  });

  it('fails when the discovery issuer has a query string', () => {
    const { status, output } = check('query');
    expect(status).not.toBe(0);
    expect(output).toContain('not an https URL without query or fragment');
  });

  it('fails closed when the discovery document cannot be fetched', () => {
    const { status, output } = check('network');
    expect(status).not.toBe(0);
    expect(output).toContain('could not be fetched');
    expect(output).not.toContain('Could not resolve host');
  });
});
