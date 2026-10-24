import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/**
 * `scripts/deploy-dev.sh --check` validates the native authentication settings (one explicit mail
 * mode, a random key; doc 038) and fails closed without the tailnet or the host guard (ADR 0026).
 * Nothing is contacted: `curl`, `docker`, `tailscale`, `ip`, `systemctl` and `sysctl` are stubs on
 * PATH and curl refuses every call (no identity-provider discovery any more). All values are
 * fictional fixtures.
 */
const script = resolve(import.meta.dirname, '../../../scripts/deploy-dev.sh');
const KEY = '5f0c9a3e7b2d48e1a6c4f9073d8b2e51c7a09f6e3b4d2c8a1f7e605b9d3c4a28';
const SMTP_PASSWORD = 'fictional-smtp-password-FIXTURE';
const RELAY = ['AUTH_MAIL_DRIVER=google-relay', 'AUTH_MAIL_FROM=system@ayvo.test'];

let dir: string;

function write(path: string, content: string, mode = 0o700) {
  writeFileSync(path, content);
  chmodSync(path, mode);
}

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'ayvo-deploy-check-'));
  const bin = join(dir, 'bin');
  spawnSync('mkdir', [bin]);
  // The check itself contacts nothing; any curl call is a failure of this test.
  write(join(bin, 'curl'), '#!/usr/bin/env bash\necho "unexpected curl" >&2; exit 90\n');
  write(join(bin, 'docker'), '#!/usr/bin/env bash\nexit 0\n');
  // Tailnet and host guard stubs: TS_IP (the Tailscale IPv4, empty = not logged in),
  // NOSNAT (Tailscale's NoSNAT pref), GUARD (active | inactive), NONLOCAL (the sysctl value).
  write(
    join(bin, 'tailscale'),
    `#!/usr/bin/env bash
if [[ $1 == debug && $2 == prefs ]]; then printf '{"NoSNAT":%s,"AdvertiseRoutes":null}\\n' "$NOSNAT"; exit 0; fi
[[ -n $TS_IP ]] && echo "$TS_IP"
`,
  );
  write(
    join(bin, 'ip'),
    '#!/usr/bin/env bash\n[[ -n $TS_IP ]] && echo "5: tailscale0    inet $TS_IP/32 scope global tailscale0"\n',
  );
  write(join(bin, 'systemctl'), '#!/usr/bin/env bash\n[[ $GUARD == active ]]\n');
  write(join(bin, 'sysctl'), '#!/usr/bin/env bash\necho "$NONLOCAL"\n');
});

afterAll(() => rmSync(dir, { recursive: true, force: true }));

function check(
  auth: string[] = RELAY,
  host: { TS_IP?: string; NOSNAT?: string; GUARD?: string; NONLOCAL?: string; extra?: string } = {},
) {
  const env = join(dir, `dev-preview-${Math.random().toString(36).slice(2)}.env`);
  write(
    env,
    [
      'APP_ENV=development',
      'DEV_DOMAIN=dev.example-preview.test',
      'ACME_EMAIL=ops@ayvo.test',
      'POSTGRES_USER=ayvo',
      `POSTGRES_PASSWORD=${'p'.repeat(32)}`,
      'POSTGRES_DB=ayvo',
      `AUTH_ENCRYPTION_KEY=${KEY}`,
      ...auth,
      ...(host.extra ? [host.extra] : []),
      '',
    ].join('\n'),
    0o600,
  );
  const result = spawnSync('bash', [script, '--check'], {
    env: {
      ...process.env,
      PATH: `${join(dir, 'bin')}:${process.env.PATH}`,
      AYVO_DEV_ENV_FILE: env,
      TS_IP: host.TS_IP ?? '100.100.100.1',
      NOSNAT: host.NOSNAT ?? 'true',
      GUARD: host.GUARD ?? 'active',
      NONLOCAL: host.NONLOCAL ?? '1',
    },
    encoding: 'utf8',
  });
  const output = `${result.stdout}${result.stderr}`;
  // No secret value is ever printed, whatever the outcome.
  for (const secret of [KEY, SMTP_PASSWORD, '1'.repeat(64)]) expect(output).not.toContain(secret);
  expect(output).not.toContain('unexpected curl');
  return { status: result.status, output };
}

describe('deploy-dev.sh --check: native authentication settings and the tailnet', () => {
  it('passes with the explicit Google IPv4 relay and no SMTP credentials, without contacting anything', () => {
    const { status, output } = check();
    expect(output).toContain('native authentication configuration present');
    expect(output).toContain('Check passed');
    expect(status).toBe(0);
  });

  it('passes with authenticated SMTP when host, user and password are all set', () => {
    const { status } = check([
      'AUTH_MAIL_DRIVER=smtp',
      'AUTH_MAIL_FROM=system@ayvo.test',
      'AUTH_SMTP_HOST=smtp.example.test',
      'AUTH_SMTP_PORT=587',
      'AUTH_SMTP_USER=system@ayvo.test',
      `AUTH_SMTP_PASSWORD=${SMTP_PASSWORD}`,
    ]);
    expect(status).toBe(0);
  });

  it.each([
    ['no mail mode', ['AUTH_MAIL_FROM=system@ayvo.test'], 'AUTH_MAIL_DRIVER'],
    [
      'an unknown mode',
      ['AUTH_MAIL_DRIVER=anonymous', 'AUTH_MAIL_FROM=system@ayvo.test'],
      'must be smtp or google-relay',
    ],
    [
      'the memory test driver',
      ['AUTH_MAIL_DRIVER=memory', 'AUTH_MAIL_FROM=system@ayvo.test'],
      'must be smtp or google-relay',
    ],
    ['no sender', ['AUTH_MAIL_DRIVER=google-relay'], 'AUTH_MAIL_FROM'],
    [
      'relay with a password',
      [...RELAY, `AUTH_SMTP_PASSWORD=${SMTP_PASSWORD}`],
      'remove AUTH_SMTP_HOST/USER/PASSWORD',
    ],
    [
      'relay with another host',
      [...RELAY, 'AUTH_SMTP_HOST=smtp.example.test'],
      'remove AUTH_SMTP_HOST/USER/PASSWORD',
    ],
    [
      'smtp without a password',
      [
        'AUTH_MAIL_DRIVER=smtp',
        'AUTH_MAIL_FROM=system@ayvo.test',
        'AUTH_SMTP_HOST=smtp.example.test',
        'AUTH_SMTP_USER=u',
      ],
      'needs AUTH_SMTP_HOST, AUTH_SMTP_USER and AUTH_SMTP_PASSWORD',
    ],
    [
      'smtp on port 25',
      [
        'AUTH_MAIL_DRIVER=smtp',
        'AUTH_MAIL_FROM=system@ayvo.test',
        'AUTH_SMTP_HOST=smtp.example.test',
        'AUTH_SMTP_USER=u',
        `AUTH_SMTP_PASSWORD=${SMTP_PASSWORD}`,
        'AUTH_SMTP_PORT=25',
      ],
      '465 or 587',
    ],
  ])('refuses %s', (_, auth, message) => {
    const { status, output } = check(auth);
    expect(status).not.toBe(0);
    expect(output).toContain(message);
    expect(output).not.toContain('Check passed');
  });

  it.each([
    ['the automated-test key', '1'.repeat(64), 'is not random'],
    ['a typed pattern', '0123'.repeat(16), 'is not random'],
    ['a short key', 'abc123', '32-byte hex key'],
  ])('refuses %s as AUTH_ENCRYPTION_KEY', (_, key, message) => {
    const { status, output } = check(RELAY, { extra: `AUTH_ENCRYPTION_KEY=${key}` });
    expect(status).not.toBe(0);
    expect(output).toContain(message);
  });

  it('passes the tailnet and host guard checks (ADR 0026)', () => {
    const { status, output } = check();
    expect(output).toContain('Tailscale IPv4 100.100.100.1 on tailscale0');
    expect(output).toContain('ayvo-dev-docker-guard.service active and enabled');
    expect(output).toContain('Tailscale SNAT off');
    expect(status).toBe(0);
  });

  it.each([
    ['without a Tailscale address', { TS_IP: '' }, 'no Tailscale IPv4 address'],
    ['on an address outside 100.64.0.0/10', { TS_IP: '100.128.0.1' }, 'no Tailscale IPv4 address'],
    ['on a public address', { TS_IP: '203.0.113.7' }, 'no Tailscale IPv4 address'],
    [
      'without the host guard',
      { GUARD: 'inactive' },
      'ayvo-dev-docker-guard.service is not active',
    ],
    ['without ip_nonlocal_bind', { NONLOCAL: '0' }, 'net.ipv4.ip_nonlocal_bind must be 1'],
    // PR #33 on DEV: Tailscale masqueraded forwarded tailnet traffic to the Docker gateway
    // (172.20.0.1), so Caddy saw no tailnet peer and aborted every request.
    ['with Tailscale SNAT on', { NOSNAT: 'false' }, 'Tailscale SNAT is on'],
    [
      'with DEV_TAILNET_IPV4 in the env file',
      { extra: 'DEV_TAILNET_IPV4=100.100.100.1' },
      'remove DEV_TAILNET_IPV4',
    ],
  ])('fails closed %s', (_, host, message) => {
    const { status, output } = check(RELAY, host);
    expect(status).not.toBe(0);
    expect(output).toContain(message);
    expect(output).not.toContain('Check passed');
  });
});
