import { spawnSync } from 'node:child_process';
import { randomBytes, randomInt } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir, userInfo } from 'node:os';
import { join, resolve } from 'node:path';
import type { Server } from 'node:https';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { BankStatus, BankSyncResult, BankTransactionPage } from '@ayvo/types';
import { loadFinanceEnv } from '../src/finance/finance-env.js';
import { entryJson, RB_BASE_PATH, rbSimulationServer } from '../src/finance/rb-simulation.js';
import { BASE_PATH as FAKE_BASE_PATH, entryJson as fakeEntryJson } from './support/fake-rb.js';
import {
  createFinanceTestApp,
  financeDatabaseUrl,
  type FinanceTestApp,
} from './support/finance-app.js';
import { hasDatabase } from './support/test-app.js';

/**
 * The DEV path of Finance's bank connection (doc 036 §10a): the SAME topology and checks as
 * production — the three files of the connection in <secrets>/rb-premium mounted read-only into
 * Finance alone, the same file checks (scripts/lib/rb-premium-files.sh) and the same in-container
 * verification — with the bank replaced by the `rb-simulation` container and test certificates
 * from scripts/dev-rb-simulation-certs.sh. Here: the script's certificates; the real DEV Compose
 * files rendered with the override; the simulation server from that render's files; Finance
 * configured from the rendered env (paths resolved through the rendered mounts) reading over
 * mTLS with full verification of the simulation's certificate — and refusing a foreign CA or a
 * foreign client certificate. Synthetic accounts and data only; no bank is ever contacted.
 */
const root = resolve(import.meta.dirname, '../../..');
const run = (cmd: string, args: string[], env: Record<string, string> = {}) =>
  spawnSync(cmd, args, { cwd: root, encoding: 'utf8', env: { ...process.env, ...env } });
const hasCompose = run('docker', ['compose', 'version']).status === 0;
const hasOpenssl = run('openssl', ['version']).status === 0;
const uid = userInfo().uid;
const B = '/api/admin/finance/bank';

const tmp = mkdtempSync(join(tmpdir(), 'ayvo-rb-sim-'));
/** A secrets directory with the script's certificates (owned by this user, as uid 1000 on DEV). */
const certs = () => {
  const dir = mkdtempSync(join(tmp, 'secrets-'));
  const res = run('scripts/dev-rb-simulation-certs.sh', [
    '--secrets-dir',
    dir,
    '--owner-uid',
    String(uid),
  ]);
  expect(res.status, res.stderr).toBe(0);
  return { dir, out: res.stdout + res.stderr };
};
const files = (dir: string, sub: string) =>
  Object.fromEntries(
    [
      'certificate.p12',
      'client-id',
      'p12-passphrase',
      'simulation-ca.crt',
      'server.key',
      'server.crt',
      'ca.crt',
    ]
      .filter((f) => existsSync(join(dir, sub, f)))
      .map((f) => [f, join(dir, sub, f)]),
  );

interface RenderedService {
  environment?: Record<string, string>;
  networks?: Record<string, unknown>;
  ports?: unknown[];
  volumes?: {
    type: string;
    source: string;
    target: string;
    read_only?: boolean;
    bind?: Record<string, unknown>;
  }[];
}
/** `docker compose config` of deploy/dev/compose.yml + the bank simulation override. */
function renderDev(secrets: string, accounts: string) {
  const env = join(tmp, `dev-${randomInt(1e9)}.env`);
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
      `CORE_DB_PASSWORD=${hex(24)}`,
      'POSTGRES_DB=fixture_db',
      `AUTH_ENCRYPTION_KEY=${hex(32)}`,
      'AUTH_MAIL_DRIVER=smtp',
      'AUTH_MAIL_FROM=noreply@example.test',
      `FINANCE_DB_PASSWORD=${hex(24)}`,
      `FINANCE_DB_OWNER_PASSWORD=${hex(24)}`,
      'FINANCE_IMAGE_TAG=fixture',
      `RB_PREMIUM_ACCOUNTS=${accounts}`,
      '',
    ].join('\n'),
  );
  const res = run(
    'docker',
    [
      'compose',
      '--project-directory',
      'deploy/dev',
      '-f',
      'deploy/dev/compose.yml',
      '-f',
      'deploy/dev/compose.rb-premium.yml',
      '--env-file',
      env,
      '--profile',
      'finance',
      'config',
      '--format',
      'json',
    ],
    { AYVO_DEV_SECRETS_DIR: secrets },
  );
  expect(res.status, res.stderr).toBe(0);
  return JSON.parse(res.stdout) as {
    services: Record<string, RenderedService>;
    networks: Record<string, { internal?: boolean }>;
  };
}

afterAll(() => {
  // The script leaves read-only directories; make them removable.
  run('chmod', ['-R', 'u+w', tmp]);
  rmSync(tmp, { recursive: true, force: true });
});

describe('the DEV simulation answers in the same format as the test simulation', () => {
  it('one entry serializes identically (test/support/fake-rb.ts stays self-contained for the e2e server)', () => {
    const e = {
      entryReference: 'SIM-1',
      amount: '1500.50',
      creditDebitIndication: 'CRDT' as const,
      bookingDate: '2026-10-27T00:00:00.000+02:00',
      counterParty: { name: 'Plátce', accountNumber: '123', bankCode: '0100' },
      variable: '20261027',
      message: 'zpráva',
    };
    expect(entryJson(e, 'CZK')).toBe(fakeEntryJson(e, 'CZK'));
    expect(RB_BASE_PATH).toBe(FAKE_BASE_PATH);
  });
});

describe.skipIf(!hasOpenssl)('scripts/dev-rb-simulation-certs.sh', () => {
  it('writes exactly the connection files and the simulation files, owner-only, CA key discarded, nothing printed', () => {
    const { dir, out } = certs();
    const client = files(dir, 'rb-premium');
    const sim = files(dir, 'rb-simulation');
    expect(Object.keys(client).sort()).toEqual([
      'certificate.p12',
      'client-id',
      'p12-passphrase',
      'simulation-ca.crt',
    ]);
    expect(Object.keys(sim).sort()).toEqual(['ca.crt', 'client-id', 'server.crt', 'server.key']);
    for (const sub of ['rb-premium', 'rb-simulation']) {
      expect((statSync(join(dir, sub)).mode & 0o777).toString(8)).toBe('500');
      for (const f of Object.values(files(dir, sub))) {
        expect((statSync(f).mode & 0o777).toString(8), f).toBe('400');
        expect(statSync(f).uid).toBe(uid);
      }
    }
    expect(existsSync(join(dir, 'rb-simulation', 'ca.key'))).toBe(false);
    // The server certificate is for `rb-simulation` and chains to the CA Finance trusts.
    const verify = run('openssl', [
      'verify',
      '-CAfile',
      client['simulation-ca.crt']!,
      sim['server.crt']!,
    ]);
    expect(verify.stdout, verify.stderr).toContain(': OK');
    const san = run('openssl', [
      'x509',
      '-in',
      sim['server.crt']!,
      '-noout',
      '-ext',
      'subjectAltName',
    ]);
    expect(san.stdout).toMatch(/DNS:rb-simulation\s*$/);
    expect(readFileSync(client['client-id']!, 'utf8')).toBe(
      readFileSync(sim['client-id']!, 'utf8'),
    );
    for (const secret of [client['p12-passphrase']!, client['client-id']!])
      expect(out).not.toContain(readFileSync(secret, 'utf8'));
  });

  it('refuses a production host and never replaces an existing set', () => {
    const prod = mkdtempSync(join(tmp, 'prod-'));
    writeFileSync(join(prod, 'prod.env'), 'POSTGRES_DB=x\n');
    const refused = run('scripts/dev-rb-simulation-certs.sh', [
      '--secrets-dir',
      prod,
      '--owner-uid',
      String(uid),
    ]);
    expect([refused.status, refused.stderr]).toEqual([1, expect.stringMatching(/production host/)]);
    expect(existsSync(join(prod, 'rb-premium'))).toBe(false);
    const { dir } = certs();
    const before = readFileSync(join(dir, 'rb-premium', 'client-id'), 'utf8');
    const again = run('scripts/dev-rb-simulation-certs.sh', [
      '--secrets-dir',
      dir,
      '--owner-uid',
      String(uid),
    ]);
    expect([again.status, again.stderr]).toEqual([1, expect.stringMatching(/already exists/)]);
    expect(readFileSync(join(dir, 'rb-premium', 'client-id'), 'utf8')).toBe(before);
  });
});

describe.skipIf(!hasOpenssl)(
  'the DEV deployment checks the files exactly as production does',
  () => {
    const lib = readFileSync(join(root, 'scripts/lib/rb-premium-files.sh'), 'utf8');
    const script = readFileSync(join(root, 'scripts/deploy-finance-dev.sh'), 'utf8');
    const fn = (() => {
      const lines = script.split('\n');
      const start = lines.findIndex((l) => l.startsWith('check_rb_simulation() {'));
      return lines.slice(start, lines.indexOf('}', start) + 1).join('\n');
    })();
    const check = (dir: string, accounts: string) =>
      spawnSync(
        'bash',
        [
          '-c',
          [
            'set -Eeuo pipefail',
            'die() { echo "ERROR $*" >&2; exit 1; }',
            'ok() { echo "ok $*"; }',
            lib,
            `SECRETS_DIR=${dir}; FINANCE_UID=${uid}; RB_SIMULATION_FILES="ca.crt client-id server.crt server.key"`,
            'DEPLOY_DIR=/deploy; COMPOSE_FILES=(-f base.yml); RB_ENABLED=false',
            `declare -A CFG=([RB_PREMIUM_ACCOUNTS]='${accounts}')`,
            fn,
            'check_rb_simulation',
            'echo "ENABLED=$RB_ENABLED FILES=${COMPOSE_FILES[*]}"',
          ].join('\n'),
        ],
        { encoding: 'utf8' },
      );
    const deployProd = readFileSync(join(root, 'scripts/deploy-prod.sh'), 'utf8');

    it('both deployments use the one shared check; production allows exactly the three files', () => {
      for (const s of [script, deployProd]) {
        expect(s).toContain('source "$REPO_ROOT/scripts/lib/rb-premium-files.sh"');
        expect(s).toContain('rb_premium_check_dir "$SECRETS');
        expect(s).toContain('node -e "$RB_PREMIUM_VERIFY_JS"');
      }
      expect(deployProd).toContain(
        'rb_premium_check_dir "$SECRETS/rb-premium" "$FINANCE_UID" "$RB_PREMIUM_FILES"',
      );
      expect(lib).toMatch(
        /^readonly RB_PREMIUM_FILES="certificate\.p12 client-id p12-passphrase"$/m,
      );
    });

    it('the in-container check: the simulation needs its CA; production never has one', () => {
      const js = lib.split("readonly RB_PREMIUM_VERIFY_JS='")[1]!.split("'\n")[0]!;
      const { dir } = certs();
      const rb = join(dir, 'rb-premium');
      const check = (env: Record<string, string>) =>
        spawnSync('node', ['-e', js.replaceAll('/run/secrets/rb-premium', rb)], {
          encoding: 'utf8',
          env: { PATH: process.env.PATH, ...env },
        }).status;
      const sim = {
        WANT: 'simulation',
        RB_PREMIUM_ENVIRONMENT: 'simulation',
        RB_PREMIUM_P12_FILE: `${rb}/certificate.p12`,
        RB_PREMIUM_SIMULATION_CA_FILE: `${rb}/simulation-ca.crt`,
      };
      expect(check(sim)).toBe(0);
      expect(check({ ...sim, RB_PREMIUM_SIMULATION_CA_FILE: '' })).toBe(5);
      expect(check({ ...sim, RB_PREMIUM_ENVIRONMENT: 'production' })).toBe(3);
      expect(check({ ...sim, WANT: 'production', RB_PREMIUM_ENVIRONMENT: 'production' })).toBe(5);
      expect(check({ WANT: 'none' })).toBe(2);
    });

    it('off without accounts; on with the script’s files (the override added); refused when anything differs', () => {
      expect(check(tmp, '').stdout).toContain('ENABLED=false FILES=-f base.yml');
      const { dir } = certs();
      const on = check(dir, '1234567890:CZK');
      expect(on.status, on.stderr).toBe(0);
      expect(on.stdout).toContain(
        'ENABLED=true FILES=-f base.yml -f /deploy/compose.rb-premium.yml',
      );
      expect(check(dir, '19-123:CZK').stderr).toMatch(/number:CUR/);
      // A file readable by others, or an extra file: the same refusals as production.
      const rb = join(dir, 'rb-premium');
      chmodSync(rb, 0o700);
      chmodSync(join(rb, 'client-id'), 0o440);
      expect(check(dir, '1234567890:CZK').stderr).toMatch(/readable by its owner only/);
      chmodSync(join(rb, 'client-id'), 0o400);
      writeFileSync(join(rb, 'copy.p12'), 'x');
      expect(check(dir, '1234567890:CZK').stderr).toMatch(/must hold exactly/);
    });
  },
);

describe.skipIf(!hasCompose || !hasOpenssl)(
  'the rendered DEV topology with the bank simulation',
  () => {
    it('Finance mounts the connection read-only, shares an internal network with the simulation alone, nothing is published', () => {
      const { dir } = certs();
      const r = renderDev(dir, '1234567890:CZK');
      const finance = r.services.finance!;
      expect(finance.environment).toMatchObject({
        APP_ENV: 'development',
        RB_PREMIUM_ENVIRONMENT: 'simulation',
        RB_PREMIUM_SIMULATION_CA_FILE: '/run/secrets/rb-premium/simulation-ca.crt',
        RB_PREMIUM_ACCOUNTS: '1234567890:CZK',
      });
      expect(finance.volumes!.filter((v) => v.type === 'bind')).toEqual([
        expect.objectContaining({
          source: join(dir, 'rb-premium'),
          target: '/run/secrets/rb-premium',
          read_only: true,
        }),
      ]);
      const sim = r.services['rb-simulation']!;
      expect(sim.ports ?? []).toEqual([]);
      expect(Object.keys(sim.networks ?? {})).toEqual(['rb-simulation']);
      expect(sim.volumes).toEqual([
        expect.objectContaining({ source: join(dir, 'rb-simulation'), read_only: true }),
      ]);
      expect(r.networks['rb-simulation']).toMatchObject({ internal: true });
      const onNetwork = Object.entries(r.services)
        .filter(([, s]) => 'rb-simulation' in (s.networks ?? {}))
        .map(([n]) => n)
        .sort();
      expect(onNetwork).toEqual(['finance', 'rb-simulation']);
      // Nothing else of the bank connection anywhere else.
      for (const [name, s] of Object.entries(r.services))
        if (name !== 'finance' && name !== 'rb-simulation')
          expect(JSON.stringify(s), name).not.toMatch(/rb-premium|RB_PREMIUM/);
    });
  },
);

describe.skipIf(!hasDatabase || !hasCompose || !hasOpenssl)(
  'Finance reads the DEV bank simulation through the rendered wiring',
  () => {
    const apps: FinanceTestApp[] = [];
    const servers: Server[] = [];
    const account = String(randomInt(1_000_000_000, 9_999_999_999));
    let dir: string;
    let financeEnv: Record<string, string>;
    /** The simulation as the rendered `rb-simulation` service starts it (its mounted files). */
    const startSimulation = async (secrets: string) => {
      const read = (f: string) => readFileSync(join(secrets, 'rb-simulation', f));
      const server = rbSimulationServer({
        key: read('server.key'),
        cert: read('server.crt'),
        ca: read('ca.crt'),
        clientId: read('client-id').toString('utf8'),
        accounts: [`${account}:CZK`],
      });
      await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
      servers.push(server);
      return `127.0.0.1:${(server.address() as AddressInfo).port}`;
    };
    const appAt = async (address: string, over: Record<string, string> = {}) => {
      const a = await createFinanceTestApp({
        finance: {
          ...financeEnv,
          RB_PREMIUM_SIMULATION_ADDRESS_FOR_TESTS: address,
          RB_PREMIUM_RETRY_BASE_MS: '100',
          RB_PREMIUM_TIMEOUT_MS: '1500',
          ...over,
        },
      });
      apps.push(a);
      return a;
    };
    const sync = async (f: FinanceTestApp) =>
      (await f.post(`${B}/sync`).send({}).expect(200)).body as BankSyncResult;
    const listed = async (f: FinanceTestApp) =>
      (
        (await f.get(`${B}/transactions?account=${account}/CZK`).expect(200))
          .body as BankTransactionPage
      ).total;

    beforeAll(() => {
      dir = certs().dir;
      const r = renderDev(dir, `${account}:CZK`);
      const finance = r.services.finance!;
      const [mount] = finance.volumes!.filter((v) => v.type === 'bind');
      // The container paths, resolved through the rendered mount as the Finance process sees them.
      financeEnv = Object.fromEntries(
        Object.entries(finance.environment!)
          .filter(([k]) => k.startsWith('RB_PREMIUM_'))
          .map(([k, v]) => [
            k,
            v.startsWith(`${mount!.target}/`) ? mount!.source + v.slice(mount!.target.length) : v,
          ]),
      );
      // As rendered (APP_ENV=development), Finance accepts exactly this configuration.
      expect(
        loadFinanceEnv({
          ...finance.environment,
          FINANCE_DATABASE_URL: financeDatabaseUrl!,
          FINANCE_SERVICE_TOKEN: 'a'.repeat(43),
        }),
      ).toMatchObject({ APP_ENV: 'development', RB_PREMIUM_ENVIRONMENT: 'simulation' });
    });
    afterAll(async () => {
      for (const a of apps) await a.close();
      for (const s of servers) await new Promise<void>((r) => s.close(() => r()));
    });

    it('mTLS with the test certificate, the simulation verified by its CA and name: entries read once, as TEST data', async () => {
      const f = await appAt(await startSimulation(dir));
      const status = (await f.get(`${B}/status`).expect(200)).body as BankStatus;
      expect(status.certificate.state).toBe('READABLE');
      const first = await sync(f);
      expect(first.runs.map((r) => [r.accountNumber, r.environment, r.status])).toEqual([
        [account, 'TEST', 'SUCCEEDED'],
      ]);
      expect(first.runs[0]!.newCount).toBeGreaterThan(0);
      const stored = await listed(f);
      expect(stored).toBe(first.runs[0]!.newCount);
      // The simulation answers the same again: nothing new, nothing changed.
      const again = await sync(f);
      expect([again.runs[0]!.newCount, again.runs[0]!.changedCount]).toEqual([0, 0]);
    });

    it('TLS is never weakened: a simulation with another CA is refused; a foreign client certificate is rejected — nothing stored', async () => {
      const other = certs().dir;
      const before = await listed(await appAt(await startSimulation(dir)));
      // Finance trusts only its CA: the other set's simulation is not the one it knows.
      const foreignServer = await appAt(await startSimulation(other));
      const refused = await sync(foreignServer);
      expect([refused.runs[0]!.status, refused.runs[0]!.errorCode]).toEqual([
        'FAILED',
        'BANK_UNAVAILABLE',
      ]);
      // The other set's client certificate against this simulation (trusting its CA): 401.
      const foreignClient = await appAt(await startSimulation(dir), {
        RB_PREMIUM_P12_FILE: join(other, 'rb-premium', 'certificate.p12'),
        RB_PREMIUM_P12_PASSPHRASE_FILE: join(other, 'rb-premium', 'p12-passphrase'),
      });
      const rejected = await sync(foreignClient);
      expect([rejected.runs[0]!.status, rejected.runs[0]!.errorCode]).toEqual([
        'FAILED',
        'CERTIFICATE_REJECTED',
      ]);
      expect(await listed(foreignClient)).toBe(before);
    });
  },
);
