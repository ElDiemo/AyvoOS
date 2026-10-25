import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test, type APIRequestContext } from '@playwright/test';
const ADMIN_STATE = 'e2e/.auth/admin.json';

/**
 * Finance as its own unit (ADR 0039) — a REAL outage of its process, not a mocked answer: the e2e
 * server stops the Finance process (SIGUSR2) and starts it again (SIGUSR1). While it is down, only
 * the Finance pages say so; sign-in, the core's health and the rest of AYVO OS keep working. After
 * the restart Finance is ready again and its page works — nothing to repair by hand.
 */
const serverPid = () =>
  Number(readFileSync(join(tmpdir(), 'ayvo-e2e-server-4100.pid'), 'utf8').trim());
const financeReady = async (request: APIRequestContext) =>
  (await request.get('/api/admin/finance/health/ready').catch(() => null))?.status() ?? 0;

test.describe('Výpadek Financí', () => {
  test.use({ storageState: ADMIN_STATE });

  test.afterAll(async ({ request }) => {
    // Whatever happened above, the next specs get a running Finance.
    process.kill(serverPid(), 'SIGUSR1');
    await expect.poll(() => financeReady(request), { timeout: 30_000 }).toBe(200);
  });

  test('Finance down: only its pages say so; core, sign-in and health work; after restart it is ready again', async ({
    page,
    request,
    browser,
    baseURL,
  }) => {
    await expect.poll(() => financeReady(request), { timeout: 30_000 }).toBe(200);

    process.kill(serverPid(), 'SIGUSR2');
    await expect.poll(() => financeReady(request), { timeout: 15_000 }).not.toBe(200);

    // Finance: its own message, inside the normal OS shell (navigation still there).
    await page.goto('/finance/documents');
    await expect(
      page.getByRole('heading', { name: 'Finance jsou dočasně nedostupné' }),
    ).toBeVisible();
    await expect(page.getByText('Ostatní části AYVO OS fungují.')).toBeVisible();
    await expect(page.getByRole('navigation', { name: 'Hlavní navigace' })).toBeVisible();

    // The rest of the OS: another module, the core's health, the session, the sign-in page.
    await page.goto('/hotels');
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
    await expect(page.getByText('Finance jsou dočasně nedostupné')).toHaveCount(0);
    const health = await request.get('/api/health');
    expect(health.status()).toBe(200);
    expect(await health.json()).toMatchObject({ status: 'ok', checks: { database: 'up' } });
    expect((await request.get('/api/auth/me')).status()).toBe(200);
    const login = await browser.newContext({ baseURL });
    const loginPage = await login.newPage();
    expect((await loginPage.goto('/login'))?.status()).toBe(200);
    await login.close();

    // Recovery: the process starts again, Finance is ready and its page works.
    process.kill(serverPid(), 'SIGUSR1');
    await expect.poll(() => financeReady(request), { timeout: 30_000 }).toBe(200);
    await page.goto('/finance/documents');
    await expect(page.getByRole('heading', { level: 1, name: 'Přijaté doklady' })).toBeVisible();
  });
});
