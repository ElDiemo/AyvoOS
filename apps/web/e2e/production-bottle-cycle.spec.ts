import { resolve } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { json, noOverflow } from './dispatch-setup';

/**
 * Výroba → Oběh lahví (owner 2026-11-09): Příjem vratek and Po mytí moved from Sklad to Výroba,
 * next to the station. Only the staff UI changed — the same screens, the same API, permissions and
 * site scope. Covered here: the navigation at 390 and 1440 px (where to scan a return, where to
 * confirm washing, where to go on), an account with returns:receive alone, the HTTP redirects of
 * the former warehouse URLs (also a receipt detail) and the active site. The bottle detail's
 * receipt link is checked in workflow-returns.spec.ts. The scan regressions stay in workflow-returns.spec.ts, on the new URLs.
 */
test.use({ storageState: 'e2e/.auth/admin.json' });
test.describe.configure({ mode: 'serial' });

/** The migrated initial site of the e2e server (auth.setup.ts) and the fictional second one. */
const INITIAL_SITE_ID = '01990000-0000-7000-8000-000000000001';
const SECOND_SITE_ID = '01990000-0000-7000-8000-0000000000e2';
const SHOTS = resolve(import.meta.dirname, '../../../docs/screenshots/returns');

async function activeSite(page: Page, siteId: string) {
  await json(await page.request.post('/api/auth/active-site', { data: { siteId } }));
}

for (const width of [390, 1440] as const) {
  test(`at ${width} px: Výroba → Práce → Oběh lahví, its two actions and the station`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 900 });
    await activeSite(page, INITIAL_SITE_ID);
    await page.goto('/production');
    const production = page.getByRole('navigation', { name: 'Výroba' });
    await production.getByTestId('section-work').click();
    await expect(page).toHaveURL(/\/production\/station$/);
    // Práce names its two pages; Oběh lahví is one tap away from the station.
    const tabs = production.getByTestId('module-tabs').getByRole('link');
    await expect(tabs).toHaveText(['Pracovat na pracovišti', 'Oběh lahví']);
    await tabs.filter({ hasText: 'Oběh lahví' }).click();
    await expect(page).toHaveURL(/\/production\/cycle$/);
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Oběh lahví');
    await expect(production.getByTestId('section-work')).toHaveAttribute('aria-current', 'true');
    await expect(page.getByTestId('cycle-site')).toContainText('CZ-PREROV-01');
    const steps = page.getByTestId('cycle-steps');
    await expect(steps).toContainText('Krok 1 · Příjem vratek');
    await expect(steps).toContainText('pípáte vrácenou bednu');
    await expect(steps).toContainText('Krok 2 · Po mytí');
    await expect(steps).toContainText('potvrzujete umytou a zkontrolovanou lahev');
    await expect(page.getByTestId('cycle-station')).toHaveAttribute('href', '/production/station');
    // The Po mytí counts load in their own panel; the screenshot shows numbers, not the placeholder.
    await expect(page.getByTestId('cycle-waiting')).toHaveText(/^\d+$/);
    await expect(page.getByTestId('cycle-ready')).toHaveText(/^\d+$/);
    await noOverflow(page);
    await page.screenshot({ path: `${SHOTS}/bottle-cycle-${width}.png`, fullPage: true });

    // Příjem vratek: the existing screen, its views, and the next step.
    await page.getByTestId('cycle-returns').click();
    await expect(page).toHaveURL(/\/production\/cycle\/returns$/);
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Příjem vratek');
    const views = page.getByRole('navigation', { name: 'Části oběhu lahví' });
    await expect(views.getByRole('link')).toHaveText(['Přehled', 'Příjem vratek', 'Po mytí']);
    await expect(views.getByRole('link', { name: 'Příjem vratek' })).toHaveAttribute(
      'aria-current',
      'page',
    );
    await expect(page.getByRole('button', { name: 'Otevřít příjem' })).toBeVisible();
    await noOverflow(page);
    await page.getByRole('link', { name: 'Pokračovat: Po mytí' }).click();

    // Po mytí: the scan field is ready at once — no step before the first scan.
    await expect(page).toHaveURL(/\/production\/cycle\/after-wash$/);
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Po mytí');
    await expect(
      page.getByRole('textbox', { name: /umytou a zkontrolovanou lahev/ }),
    ).toBeFocused();
    await expect(views.getByRole('link', { name: 'Po mytí' })).toHaveAttribute(
      'aria-current',
      'page',
    );
    await noOverflow(page);

    // Sklad no longer lists them.
    await page.goto('/warehouse');
    const warehouse = page.getByRole('navigation', { name: 'Sklad' });
    await expect(warehouse.getByRole('link', { name: 'Příjem vratek' })).toHaveCount(0);
    await expect(warehouse.getByRole('link', { name: 'Po mytí' })).toHaveCount(0);
  });
}

test('the Po mytí counts answer 503: both actions stay, the counts say unavailable, Příjem vratek opens', async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 900 });
  await activeSite(page, INITIAL_SITE_ID);
  // Only the queue read fails; Příjem vratek's own endpoints answer as usual.
  await page.route('**/api/admin/returns/after-wash', (route) =>
    route.request().method() === 'GET'
      ? route.fulfill({ status: 503, json: { message: 'unavailable' } })
      : route.continue(),
  );
  await page.goto('/production/cycle');
  await expect(page.getByTestId('cycle-counts-unavailable')).toHaveText(
    'Počty Po mytí jsou teď nedostupné. Obě akce fungují dál.',
  );
  await expect(page.getByTestId('cycle-waiting')).toHaveCount(0);
  await expect(page.getByTestId('cycle-after-wash')).toBeVisible();
  await page.getByTestId('cycle-returns').click();
  await expect(page).toHaveURL(/\/production\/cycle\/returns$/);
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Příjem vratek');
  await page.getByRole('button', { name: 'Otevřít příjem' }).click();
  await expect(page).toHaveURL(/\/production\/cycle\/returns\/RR-\d{6}$/);
  await expect(page.getByTestId('receipt-state')).toContainText('Otevřený');
});

test('the former warehouse URLs are real redirects, a receipt detail included', async ({
  page,
  browser,
}) => {
  await activeSite(page, INITIAL_SITE_ID);
  const receipt = await json<{ code: string }>(
    await page.request.post('/api/admin/returns/receipts', {
      data: { requestId: crypto.randomUUID(), hotelCode: null },
    }),
  );
  for (const [from, to] of [
    ['/warehouse/returns', '/production/cycle/returns'],
    [`/warehouse/returns/${receipt.code}`, `/production/cycle/returns/${receipt.code}`],
    ['/warehouse/after-wash', '/production/cycle/after-wash'],
    ['/warehouse/after-wash?x=1', '/production/cycle/after-wash?x=1'],
  ] as const) {
    const res = await page.request.get(from, { maxRedirects: 0 });
    expect(res.status(), from).toBe(307);
    expect(res.headers()['location'], from).toBe(to);
  }
  // A saved link to a receipt opens it, inside Oběh lahví, with the way back.
  await page.goto(`/warehouse/returns/${receipt.code}`);
  await expect(page).toHaveURL(new RegExp(`/production/cycle/returns/${receipt.code}$`));
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(`Příjem vratek ${receipt.code}`);
  await page.getByRole('link', { name: 'Příjem vratek' }).first().click();
  await expect(page).toHaveURL(/\/production\/cycle\/returns$/);
  await expect(page.getByTestId('return-receipts')).toContainText(receipt.code);
  // Without client JavaScript the HTTP redirect alone gets the browser there.
  const context = await browser.newContext({
    javaScriptEnabled: false,
    storageState: 'e2e/.auth/admin.json',
  });
  const plain = await context.newPage();
  const response = await plain.goto('/warehouse/after-wash');
  expect(response?.status()).toBe(200);
  expect(plain.url()).toMatch(/\/production\/cycle\/after-wash$/);
  await context.close();
});

test('the active site: Oběh lahví names it and shows only its receipts', async ({ page }) => {
  await activeSite(page, INITIAL_SITE_ID);
  const receipt = await json<{ code: string }>(
    await page.request.post('/api/admin/returns/receipts', {
      data: { requestId: crypto.randomUUID(), hotelCode: null },
    }),
  );
  await page.goto('/production/cycle/returns');
  await expect(page.getByTestId('return-receipts')).toContainText(receipt.code);
  // The other site, chosen in the site switcher: its own (empty) cycle, nothing of the first.
  await Promise.all([
    page.waitForEvent('load'),
    page.getByTestId('site-switcher').selectOption(SECOND_SITE_ID),
  ]);
  await expect(page.getByTestId('site-switcher')).toHaveValue(SECOND_SITE_ID);
  await expect(page).toHaveURL(/\/production\/cycle\/returns$/);
  await expect(page.getByText(receipt.code)).toHaveCount(0);
  await page.goto('/production/cycle');
  await expect(page.getByTestId('cycle-site')).toContainText('E2E-DE');
  await activeSite(page, INITIAL_SITE_ID);
  await page.goto('/production/cycle');
  await expect(page.getByTestId('cycle-site')).toContainText('CZ-PREROV-01');
});

test('an account with returns:receive alone: Výroba → Oběh lahví only, no station, no warehouse', async ({
  page,
}) => {
  const stamp = Date.now();
  const role = await json<{ code: string }>(
    await page.request.post('/api/admin/identity/roles', {
      data: {
        code: `E2E_CYCLE_${stamp % 100000}`,
        name: 'Vratky a mytí (E2E)',
        description: 'Jen returns:receive',
        permissions: ['returns:receive'],
        copiedFrom: null,
        reason: 'end-to-end bottle cycle',
      },
    }),
  );
  const email = `e2e-cycle-${stamp}@ayvo.test`;
  await json(
    await page.request.post('/api/admin/identity/users', {
      data: {
        email,
        displayName: 'E2E Vratky',
        roles: [role.code],
        siteIds: [INITIAL_SITE_ID],
        warehouseCodes: [],
        reason: 'end-to-end bottle cycle',
      },
    }),
  );
  await page.goto(`/api/auth/login?next=/&login_hint=${email}`);
  await expect(page).toHaveURL(/\/$/);
  const main = page.getByRole('navigation', { name: 'Hlavní navigace' });
  await expect(main.getByRole('link', { name: 'Sklad' })).toHaveCount(0);
  await main.getByRole('link', { name: 'Výroba' }).click();
  await expect(page).toHaveURL(/\/production\/cycle$/);
  const production = page.getByRole('navigation', { name: 'Výroba' });
  await expect(production.getByTestId('module-sections').getByRole('link')).toHaveText([/^Práce/]);
  // One page in Práce: no strip, no station link.
  await expect(production.getByTestId('module-tabs')).toHaveCount(0);
  await expect(page.getByTestId('cycle-returns')).toBeVisible();
  await expect(page.getByTestId('cycle-after-wash')).toBeVisible();
  await expect(page.getByTestId('cycle-station')).toHaveCount(0);
  await expect(page.getByText('Pracovat na pracovišti')).toHaveCount(0);
  // Both screens open; a saved warehouse link still leads there.
  await page.goto('/warehouse/returns');
  await expect(page).toHaveURL(/\/production\/cycle\/returns$/);
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Příjem vratek');
  await page.getByRole('link', { name: 'Pokračovat: Po mytí' }).click();
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Po mytí');
  // Everything else stays closed (pages and API alike).
  for (const path of ['/production', '/production/station', '/warehouse']) {
    await page.goto(path);
    await expect(page, path).toHaveURL(/\/forbidden$/);
  }
  expect((await page.request.get('/api/admin/bottles?page=1&pageSize=1')).status()).toBe(403);
});
