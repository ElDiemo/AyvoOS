import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { expect, test, type Page } from '@playwright/test';

/**
 * The Finance window of doc 040 §12a: this web and API with a real earlier Finance process, as after
 * `deploy-prod.sh --release` and before `--finance`, on a synthetic database. The database here is
 * already migrated; the old Finance does not read the added column.
 */
const OLD_ROOT = process.env.AYVO_COMPAT_OLD_ROOT!;
const SHOTS = process.env.AYVO_COMPAT_SHOTS;
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
async function useOldFinance() {
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
async function useNewFinance() {
  // As `docker stop`: a grace period, then killed (open connections can hold a graceful stop).
  const stopping = oldFinance;
  stopping?.kill('SIGTERM');
  setTimeout(() => stopping?.kill('SIGKILL'), 5_000).unref();
  oldFinance = null;
  await waitFinance(false);
  process.kill(serverPid(), 'SIGUSR1');
  await waitFinance(true);
}
async function fillCustomer(page: Page, name: string) {
  await page.getByTestId('customer-new-open').click();
  const form = page.getByTestId('customer-new');
  await form.locator('[name=legalName]').fill(name);
  await form.locator('[name=addressLine1]').fill('Ukázková 1');
  await form.locator('[name=postalCode]').fill('602 00');
  await form.locator('[name=city]').fill('Brno');
  await form.locator('[name=billingEmail]').fill('okno@navrat.test');
  await form.locator('[name=documentLanguage]').selectOption('en');
  return form;
}
const customers = async (page: Page) =>
  (await (await page.request.get('/api/admin/finance/billing/customers')).json()) as {
    code: string;
    current: { customer: { legalName: string; documentLanguage?: string | null } };
  }[];

test('upgrade window: no language is lost, nothing fails silently, the rest of the OS works', async ({
  page,
}) => {
  const run = crypto.randomUUID().slice(0, 6).toUpperCase();
  const name = `Okno ${run} s.r.o.`;
  try {
    // A form opened before the window, saved during it; on a fresh database the list is empty.
    await page.goto('/finance/billing/customers');
    expect(await customers(page)).toEqual([]);
    const stale = await fillCustomer(page, name);
    await useOldFinance();
    expect((await page.request.get('/api/admin/finance/health/capabilities')).status()).toBe(404);
    await stale.getByTestId('customer-save').click();
    await expect(stale).toContainText('Plátce nebyl uložen');
    expect(await customers(page)).toEqual([]);

    // The same on a page opened during the window: the empty list parses, so the form is there.
    await page.goto('/finance/billing/customers');
    await expect(page.getByTestId('finance-version-mismatch')).toHaveCount(0);
    const fresh = await fillCustomer(page, name);
    await fresh.getByTestId('customer-save').click();
    await expect(fresh).toContainText('Plátce nebyl uložen');
    expect(await customers(page)).toEqual([]);

    // Back on this Finance a customer exists with its language.
    await useNewFinance();
    await page.goto('/finance/billing/customers');
    const form = await fillCustomer(page, name);
    await form.getByTestId('customer-save').click();
    await expect(form.getByTestId('customer-save')).toBeEnabled();
    await expect.poll(async () => (await customers(page)).length).toBe(1);
    const [created] = await customers(page);
    expect(created!.current.customer.documentLanguage).toBe('en');

    // In the window a page that reads it is closed and says so; no retry advice, no error page.
    await useOldFinance();
    for (const url of [
      '/finance/billing/customers',
      `/finance/billing/customers/${created!.code}`,
    ]) {
      await page.goto(url);
      const closed = page.getByTestId('finance-version-mismatch');
      await expect(closed).toBeVisible();
      await expect(closed).toContainText('Hotely, objednávky a logistika fungují dál');
      await expect(page.getByText('Zkuste to prosím za chvíli znovu')).toHaveCount(0);
    }
    if (SHOTS) await page.screenshot({ path: join(SHOTS, 'finance-window-closed.png') });

    // Pages whose contract did not change, and the rest of the OS.
    for (const url of ['/finance/documents', '/hotels', '/dispatch']) {
      const res = await page.goto(url);
      expect(res?.status(), url).toBeLessThan(400);
      await expect(page.getByTestId('finance-version-mismatch'), url).toHaveCount(0);
      await expect(page.getByRole('heading').first(), url).toBeVisible();
    }

    // After the window everything is back and the language was not touched.
    await useNewFinance();
    await page.goto(`/finance/billing/customers/${created!.code}`);
    await expect(page.getByTestId('finance-version-mismatch')).toHaveCount(0);
    expect((await customers(page))[0]!.current.customer.documentLanguage).toBe('en');
  } finally {
    if (oldFinance) await useNewFinance();
  }
});
