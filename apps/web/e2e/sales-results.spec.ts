import { expect, test } from '@playwright/test';
import type { ProspectDetail } from '@ayvo/types';
import { json, noOverflow } from './dispatch-setup';
import { prospect, shot, signIn } from './sales-setup';

test.describe.configure({ mode: 'serial' });

const tag = Date.now().toString(36).slice(-5).toUpperCase();
const K = { email: `e2e-vysledky-${tag}@ayvo.test`.toLowerCase(), name: 'Karel Obchodník' };
const L = { email: `e2e-vysledky-l-${tag}@ayvo.test`.toLowerCase(), name: 'Lenka Obchodnice' };
const codes: Record<'mine' | 'fresh' | 'foreign', string> = { mine: '', fresh: '', foreign: '' };

/**
 * Výsledky obchodu (sales:manage): the administrator sees the funnel, the period's moves and
 * activities and every salesperson's row; the period switches; a salesperson never opens it;
 * 390 px without sideways scrolling.
 */
test.beforeAll(async ({ browser }) => {
  const admin = await browser.newContext({ storageState: 'e2e/.auth/admin.json' });
  for (const u of [K, L])
    await json(
      await admin.request.post('/api/admin/identity/users', {
        data: {
          email: u.email,
          displayName: u.name,
          roles: ['SALES'],
          siteIds: [],
          warehouseCodes: [],
          reason: 'obchodník (E2E výsledky)',
        },
      }),
    );
  await admin.close();
  for (const [u, key, name, contacted] of [
    [K, 'mine', `Hotel Výsledky ${tag}`, true],
    [K, 'fresh', `Hotel Výsledky nový ${tag}`, false],
    [L, 'foreign', `Hotel Výsledky cizí ${tag}`, true],
  ] as const) {
    const page = await signIn(browser, u.email);
    const d = await json<ProspectDetail>(
      await page.request.post('/api/admin/sales/prospects', {
        data: prospect(name, { city: 'Brno' }),
      }),
    );
    if (contacted)
      await json(
        await page.request.post(`/api/admin/sales/prospects/${d.code}/stage`, {
          data: {
            requestId: crypto.randomUUID(),
            revision: d.revision,
            stage: 'CONTACTED',
            reason: null,
            lostReason: null,
          },
        }),
      );
    codes[key] = d.code;
    await page.context().close();
  }
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
  // "Bez dalšího kroku" → the list of prospects IN PROGRESS without a next step (as on Přehled).
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.getByTestId('results-without-next-step-link').click();
  await expect(page).toHaveURL(/next=none/);
  await expect(page).toHaveURL(/phase=in-progress/);
  await expect(page.getByTestId('filter-phase')).toBeVisible();
  await expect(page.getByTestId(`prospect-${codes.mine}`)).toBeVisible();
  await expect(page.getByTestId(`prospect-${codes.foreign}`)).toBeVisible(); // the owner: everyone
  await expect(page.getByTestId(`prospect-${codes.fresh}`)).toHaveCount(0); // NEW: not in progress
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
  // The same list for a salesperson: only their own prospects, never another's.
  await page.goto('/sales/prospects?next=none&phase=in-progress');
  await expect(page.getByTestId(`prospect-${codes.mine}`)).toBeVisible();
  await expect(page.getByTestId(`prospect-${codes.foreign}`)).toHaveCount(0);
  await expect(page.getByTestId(`prospect-${codes.fresh}`)).toHaveCount(0);
  expect((await page.request.get('/api/admin/sales/results')).status()).toBe(403);
  await page.context().close();
});
