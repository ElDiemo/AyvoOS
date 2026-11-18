import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import type { StockSummary } from '@ayvo/types';
import { json, noOverflow } from './dispatch-setup';
import { receiveStock } from './labeling-setup';
import { shot, signIn } from './sales-setup';

/**
 * Sklad → Zásoby (owner 2026-11-16): one tab for the warehouse (inventory:read) and for the
 * planning view (inventory:stock_summary only). Nothing available reads "Nic k dispozici" even
 * without a minimum; available below the set minimum "Pod minimem"; otherwise "V pořádku". The
 * planning view reads only the stock-summary contract. Its own synthetic items: a pump with
 * nothing (no minimum) and a packaging item received here.
 */
test.describe.configure({ mode: 'serial' });

const ADMIN = 'e2e/.auth/admin.json';
const SITE = '01990000-0000-7000-8000-000000000001';
const tag = Date.now().toString(36).slice(-5).toUpperCase();
const PLANNER = `e2e-zasoby-${tag}@ayvo.test`.toLowerCase();
const SALES = `e2e-zasoby-s-${tag}@ayvo.test`.toLowerCase();
const ZERO = `E2E-PUMPA-${tag}`;
const POSITIVE = `E2E-KRABICE-${tag}`;

async function component(request: APIRequestContext, code: string, name: string, kind: string) {
  await json(
    await request.post('/api/admin/catalog/components', {
      data: {
        requestId: crypto.randomUUID(),
        code,
        name,
        kind,
        unitCode: 'pcs',
        lotTracked: false,
        categoryCode: null,
        packageCapacity: kind === 'PACKAGING' ? 40 : null,
        reason: 'zásoby e2e',
      },
    }),
  );
}

const minimum = async (request: APIRequestContext, reorderPoint: string | null) =>
  json(
    await request.post(`/api/admin/inventory/items/${POSITIVE}/settings`, {
      data: {
        requestId: crypto.randomUUID(),
        reorderPoint,
        targetLevel: null,
        preferredSupplierId: null,
        leadTimeDays: null,
        purchaseMultiple: null,
      },
    }),
  );

async function states(page: Page, testId: 'stock-state' | 'availability-state') {
  await page.goto('/warehouse');
  return {
    zero: await page.getByTestId(`${testId}-${ZERO}`).textContent(),
    positive: await page.getByTestId(`${testId}-${POSITIVE}`).textContent(),
  };
}

test.beforeAll(async ({ browser }) => {
  const admin = await browser.newContext({ storageState: ADMIN });
  await component(admin.request, ZERO, `Pumpička E2E ${tag}`, 'PUMP');
  await component(admin.request, POSITIVE, `Krabice E2E ${tag}`, 'PACKAGING');
  await receiveStock(admin.request, POSITIVE, '5');
  await json(
    await admin.request.post('/api/admin/identity/roles', {
      data: {
        code: `E2E_ZASOBY_${tag}`,
        name: `Plánování ${tag}`,
        description: 'Stock availability for planning',
        permissions: ['inventory:stock_summary'],
        copiedFrom: null,
        reason: 'zásoby e2e',
      },
    }),
  );
  for (const [email, roles, siteIds] of [
    [PLANNER, [`E2E_ZASOBY_${tag}`], [SITE]],
    [SALES, ['SALES'], []],
  ] as const)
    await json(
      await admin.request.post('/api/admin/identity/users', {
        data: {
          email,
          displayName: `Zásoby ${tag}`,
          roles,
          siteIds,
          warehouseCodes: [],
          reason: 'zásoby e2e',
        },
      }),
    );
  await admin.close();
});

test('nothing available without a minimum, below the minimum, fine — the warehouse and the planner, 390 and 1440 px', async ({
  browser,
  page,
}) => {
  const admin = await browser.newContext({ storageState: ADMIN });
  const planner = await signIn(browser, PLANNER);
  // 5 pcs on hand and a minimum of 10: positive, below the minimum.
  await minimum(admin.request, '10');
  // The warehouse (this project's operator: inventory:read + receive).
  expect(await states(page, 'stock-state')).toEqual({
    zero: 'Nic k dispozici',
    positive: 'Pod minimem',
  });
  await expect(page.getByTestId('attention')).toContainText(`Nic k dispozici:`);
  await expect(page.getByTestId('attention')).toContainText(`Krabice E2E ${tag}`);
  // The planner: the same tab, the same reading.
  expect(await states(planner, 'availability-state')).toEqual({
    zero: 'Nic k dispozici',
    positive: 'Pod minimem',
  });
  await expect(planner.getByTestId(`availability-${POSITIVE}`)).toContainText('5 ks');
  for (const width of [390, 1440]) {
    for (const [p, who] of [
      [page, 'sklad'],
      [planner, 'planovani'],
    ] as const) {
      await p.setViewportSize({ width, height: 900 });
      await p.goto('/warehouse');
      await noOverflow(p);
      if (who === 'sklad') await expect(p.getByTestId('receive-goods')).toBeInViewport();
      await shot(p, `zasoby-${who}-${width}`);
    }
  }
  // The warehouse's item detail: the missing minimum is said in its planning.
  await page.setViewportSize({ width: 390, height: 900 });
  await page.goto(`/warehouse?item=${ZERO}`);
  await expect(page.getByTestId(`no-minimum-${ZERO}`)).toBeVisible();
  await expect(page.getByTestId(`stock-movements-${ZERO}`)).toBeVisible();
  await noOverflow(page);
  await shot(page, 'zasoby-sklad-detail-390');
  await page.goto(`/warehouse?item=${POSITIVE}`);
  await expect(page.getByTestId(`no-minimum-${POSITIVE}`)).toHaveCount(0);
  await page.getByTestId(`stock-movements-${POSITIVE}`).click();
  await expect(page).toHaveURL(new RegExp(`/warehouse/movements\\?item=${POSITIVE}$`));
  await expect(page.getByTestId('movements')).toContainText('Příjem');

  // A minimum of 5 (available is not below it): "V pořádku" for both.
  await minimum(admin.request, '5');
  expect((await states(page, 'stock-state')).positive).toBe('V pořádku');
  expect((await states(planner, 'availability-state')).positive).toBe('V pořádku');

  // The planner's contract stays the limited one.
  const summary = await json<StockSummary>(
    await planner.request.get('/api/admin/inventory/stock-summary'),
  );
  expect(JSON.stringify(summary)).not.toMatch(/supplier|lot|price|document|onHand/i);
  await planner.context().close();
  await admin.close();
});

test('former links lead to Zásoby; receipts and movements stay; without either permission no access', async ({
  browser,
  page,
}) => {
  for (const path of ['/warehouse/stock', '/warehouse/availability']) {
    await page.goto(path);
    await expect(page, path).toHaveURL(/\/warehouse$/);
    await expect(page.getByRole('heading', { level: 1 })).toHaveText(/^Zásoby – /);
  }
  await page.goto('/warehouse');
  await page.getByRole('link', { name: 'Všechny příjmy' }).click();
  await expect(page).toHaveURL(/\/warehouse\/receipts$/);
  await page.goto('/warehouse');
  await page.getByRole('link', { name: 'Všechny pohyby' }).click();
  await expect(page).toHaveURL(/\/warehouse\/movements$/);

  const sales = await signIn(browser, SALES);
  for (const path of ['/warehouse', '/warehouse/stock', '/warehouse/availability']) {
    await sales.goto(path);
    await expect(sales, path).toHaveURL(/\/forbidden$/);
  }
  for (const path of ['/api/admin/inventory/stock-summary', '/api/admin/inventory/stock'])
    expect((await sales.request.get(path)).status(), path).toBe(403);
  await sales.context().close();
});
