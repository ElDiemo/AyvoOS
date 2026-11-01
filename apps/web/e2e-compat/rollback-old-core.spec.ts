import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { expect, test, type Page } from '@playwright/test';

/**
 * A real return (doc 040 §12a), which also takes the API back: on this release's migrated database,
 * real processes of the earlier API and web, first with this Finance (after `--rollback`), then with
 * the earlier one (after `--finance-rollback`). Synthetic data; writes nothing but sign-in state.
 */
const OLD_ROOT = process.env.AYVO_COMPAT_OLD_ROOT!;
const OLD_API = 'http://localhost:4201';
const OLD_WEB = 'http://localhost:3200';
const FINANCE = 'http://localhost:4110';
const serverPid = () =>
  Number(readFileSync(join(tmpdir(), 'ayvo-e2e-server-4100.pid'), 'utf8').trim());
/** As `docker stop`: the test server's Finance gets 5 s, then is killed (it can keep answering for 40 s). */
function stopTestFinance() {
  const pid = execFileSync('pgrep', ['-P', String(serverPid())], { encoding: 'utf8' })
    .trim()
    .split('\n')
    .find((p) => readFileSync(`/proc/${p}/cmdline`, 'utf8').includes('dist/finance/main.js'));
  process.kill(serverPid(), 'SIGUSR2');
  setTimeout(() => {
    try {
      if (pid) process.kill(Number(pid), 'SIGKILL');
    } catch {
      // already gone
    }
  }, 5_000).unref();
}
const running: ChildProcess[] = [];

function envOf(entry: string) {
  const children = execFileSync('pgrep', ['-P', String(serverPid())], { encoding: 'utf8' })
    .trim()
    .split('\n');
  for (const pid of children) {
    if (!readFileSync(`/proc/${pid}/cmdline`, 'utf8').includes(entry)) continue;
    return Object.fromEntries(
      readFileSync(`/proc/${pid}/environ`, 'utf8')
        .split('\0')
        .filter(Boolean)
        .map((kv) => [kv.slice(0, kv.indexOf('=')), kv.slice(kv.indexOf('=') + 1)]),
    );
  }
  throw new Error(`${entry} not found`);
}
const status = async (url: string) => (await fetch(url).catch(() => null))?.status ?? 0;
const ready = () => status(`${FINANCE}/api/admin/finance/health/ready`);
function start(cwd: string, args: string[], env: NodeJS.ProcessEnv) {
  const child = spawn(process.execPath, args, { cwd, env, stdio: 'ignore' });
  running.push(child);
  return child;
}
async function stop(child: ChildProcess) {
  child.kill('SIGTERM');
  setTimeout(() => child.kill('SIGKILL'), 5_000).unref();
  await expect.poll(ready, { timeout: 20_000 }).not.toBe(200);
}
async function pages(page: Page, state: string) {
  for (const url of ['/hotels', '/dispatch', '/finance', '/finance/invoices', '/finance/billing']) {
    const res = await page.goto(`${OLD_WEB}${url}`);
    expect(res?.status(), `${state} ${url}`).toBeLessThan(400);
    await expect(page.getByRole('heading').first(), `${state} ${url}`).toBeVisible();
    await expect(page.getByTestId('finance-version-mismatch'), `${state} ${url}`).toHaveCount(0);
  }
}

test('the earlier API and web run on the migrated database, with this and with the earlier Finance', async ({
  page,
}) => {
  const apiEnv = envOf('dist/main.js');
  const financeEnv = envOf('dist/finance/main.js');
  try {
    const coreOnOld = { ...financeEnv, CORE_INTERNAL_URL: OLD_API };
    start(resolve(OLD_ROOT, 'apps/api'), ['dist/main.js'], { ...apiEnv, API_PORT: '4201' });
    await expect.poll(() => status(`${OLD_API}/api/health`), { timeout: 40_000 }).toBe(200);
    start(
      resolve(OLD_ROOT, 'apps/web'),
      [resolve(OLD_ROOT, 'apps/web/node_modules/next/dist/bin/next'), 'start', '--port', '3200'],
      { ...process.env, API_URL: OLD_API, FINANCE_API_URL: FINANCE },
    );
    await expect.poll(() => status(OLD_WEB), { timeout: 40_000 }).toBeGreaterThan(0);

    // After `--rollback`: earlier core and web, this Finance.
    stopTestFinance();
    await expect.poll(ready, { timeout: 20_000 }).not.toBe(200);
    const thisFinance = start(resolve('../api'), ['dist/finance/main.js'], coreOnOld);
    await expect.poll(ready, { timeout: 40_000 }).toBe(200);
    await pages(page, 'old core + this Finance');

    // After `--finance-rollback`: everything earlier.
    await stop(thisFinance);
    start(resolve(OLD_ROOT, 'apps/api'), ['dist/finance/main.js'], coreOnOld);
    await expect.poll(ready, { timeout: 40_000 }).toBe(200);
    await pages(page, 'all earlier');
  } finally {
    for (const child of running) child.kill('SIGKILL');
    process.kill(serverPid(), 'SIGUSR1');
  }
});
