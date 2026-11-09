import { expect, test } from '@playwright/test';
import type { ProspectDetail } from '@ayvo/types';
import { json, noOverflow } from './dispatch-setup';
import { prospect, shot, signIn } from './sales-setup';

test.describe.configure({ mode: 'serial' });

const tag = Date.now().toString(36).slice(-5).toUpperCase();
const K = { email: `e2e-vysledky-${tag}@ayvo.test`.toLowerCase(), name: 'Karel Obchodník' };

/**
 * Výsledky obchodu (sales:manage): the administrator sees the funnel, the period's moves and
 * activities and every salesperson's row; the period switches; a salesperson never opens it;
 * 390 px without sideways scrolling.
 */
test.beforeAll(async ({ browser }) => {
  const admin = await browser.newContext({ storageState: 'e2e/.auth/admin.json' });
  await json(
    await admin.request.post('/api/admin/identity/users', {
      data: {
        email: K.email,
        displayName: K.name,
        roles: ['SALES'],
        siteIds: [],
        warehouseCodes: [],
        reason: 'obchodník (E2E výsledky)',
      },
    }),
  );
  await admin.close();
  const k = await signIn(browser, K.email);
  const d = await json<ProspectDetail>(
    await k.request.post('/api/admin/sales/prospects', {
      data: prospect(`Hotel Výsledky ${tag}`, { city: 'Brno' }),
    }),
  );
  await json(
    await k.request.post(`/api/admin/sales/prospects/${d.code}/stage`, {
      data: {
        requestId: crypto.randomUUID(),
        revision: d.revision,
        stage: 'CONTACTED',
        reason: null,
        lostReason: null,
      },
    }),
  );
  await k.context().close();
});

test('the administrator: funnel, moves, people; the period; 1280 and 390 px', async ({
  browser,
}) => {
  const admin = await browser.newContext({ storageState: 'e2e/.auth/admin.json' });
  const page = await admin.newPage();
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto('/sales');
  await page
    .getByRole('navigation', { name: 'Obchod' })
    .getByRole('link', { name: 'Výsledky' })
    .click();
  await expect(page.getByRole('heading', { level: 1, name: 'Výsledky obchodu' })).toBeVisible();
  expect(Number(await page.getByTestId('funnel-CONTACTED').textContent())).toBeGreaterThanOrEqual(
    1,
  );
  expect(Number(await page.getByTestId('reached-CONTACTED').textContent())).toBeGreaterThanOrEqual(
    1,
  );
  await expect(page.getByTestId('results-people')).toContainText(K.name);
  await noOverflow(page);
  await shot(page, 'sales-results-1280');
  await page.getByTestId('results-period').getByRole('link', { name: '7 dní' }).click();
  await expect(page).toHaveURL(/days=7/);
  await expect(page.getByTestId('results-people')).toContainText(K.name);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.reload();
  await noOverflow(page);
  await shot(page, 'sales-results-390');
  await admin.close();
});

test('a salesperson never opens the owner’s results', async ({ browser }) => {
  const page = await signIn(browser, K.email);
  await page.goto('/sales');
  await expect(
    page.getByRole('navigation', { name: 'Obchod' }).getByRole('link', { name: 'Výsledky' }),
  ).toHaveCount(0);
  await page.goto('/sales/results');
  await expect(page).toHaveURL(/\/forbidden/);
  expect((await page.request.get('/api/admin/sales/results')).status()).toBe(403);
  await page.context().close();
});
