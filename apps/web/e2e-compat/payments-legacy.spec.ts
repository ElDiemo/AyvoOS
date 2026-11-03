import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { expect, test } from '@playwright/test';

/**
 * Doc 041 §8a: this web and API with a real earlier Finance process, as after `deploy-prod.sh
 * --release` and before `--finance`, on a synthetic database.
 */
const OLD_ROOT = process.env.AYVO_COMPAT_OLD_ROOT!;
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
let oldFinance: ChildProcess | null = null;

const up = async () =>
  (await fetch(`${FINANCE}/api/admin/finance/health/ready`).catch(() => null))?.status === 200;
const waitFinance = (want: boolean) => expect.poll(up, { timeout: 40_000 }).toBe(want);

function financeEnv() {
  const children = execFileSync('pgrep', ['-P', String(serverPid())], { encoding: 'utf8' })
    .trim()
    .split('\n');
  for (const pid of children) {
    if (!readFileSync(`/proc/${pid}/cmdline`, 'utf8').includes('dist/finance/main.js')) continue;
    return Object.fromEntries(
      readFileSync(`/proc/${pid}/environ`, 'utf8')
        .split('\0')
        .filter(Boolean)
        .map((kv) => [kv.slice(0, kv.indexOf('=')), kv.slice(kv.indexOf('=') + 1)]),
    );
  }
  throw new Error('Finance process not found');
}
async function startOldFinance() {
  const env = financeEnv();
  stopTestFinance();
  await waitFinance(false);
  oldFinance = spawn(process.execPath, ['dist/finance/main.js'], {
    cwd: resolve(OLD_ROOT, 'apps/api'),
    env,
    stdio: 'ignore',
  });
  await waitFinance(true);
}
async function startNewFinance() {
  // As `docker stop`: a grace period, then killed (open connections can hold a graceful stop).
  const stopping = oldFinance;
  stopping?.kill('SIGTERM');
  setTimeout(() => stopping?.kill('SIGKILL'), 5_000).unref();
  oldFinance = null;
  await waitFinance(false);
  process.kill(serverPid(), 'SIGUSR1');
  await waitFinance(true);
}
test('with an older Finance the list is read-only and offers no action; a return and upgrade restore it', async ({
  page,
}) => {
  const actions = async (count: number) => {
    await expect(page.getByTestId('import-bank')).toHaveCount(count);
    await expect(page.getByTestId('payments-simulation')).toHaveCount(count);
  };
  try {
    for (let round = 0; round < 2; round++) {
      await page.goto('/finance/payments');
      await expect(page.getByTestId('payments-legacy')).toHaveCount(0);
      await expect(page.getByTestId('payments-filters')).toBeVisible();
      await actions(1);

      await startOldFinance();
      await page.goto('/finance/payments');
      await expect(page.getByTestId('payments-legacy')).toBeVisible();
      await expect(page.getByTestId('payments-filters')).toHaveCount(0);
      await expect(page.getByTestId('payments-search')).toHaveCount(0);
      await expect(page.getByTestId('payments')).toBeVisible();
      await actions(0);
      expect((await page.goto('/finance/payments/PP-000001'))?.status()).toBe(404);

      await startNewFinance();
    }
  } finally {
    if (oldFinance) await startNewFinance();
  }
});
