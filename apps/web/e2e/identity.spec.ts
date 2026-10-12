import { expect, test, type Page } from '@playwright/test';

/**
 * Identity and access in the browser (Milestone 2C, ADR 0022): sign-in through the identity
 * provider (the fake one, APP_ENV=test), permission-aware navigation and pages, the user
 * administration with reasons and audit, deactivation and sign-out.
 */
test.describe.configure({ mode: 'serial' });
test.use({ storageState: { cookies: [], origins: [] } });

const ADMIN = 'e2e/.auth/admin.json';

async function signInWithForm(page: Page, email: string) {
  await page.getByTestId('sign-in').click();
  await page.getByLabel('E-mail').fill(email);
  await page.getByRole('button', { name: 'Continue' }).click();
}

async function noOverflow(page: Page, what: string) {
  await expect
    .poll(
      () =>
        page.evaluate(
          () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
        ),
      {
        message: `horizontal overflow on ${what}`,
      },
    )
    .toBeLessThanOrEqual(0);
}

test('without a session every page leads to the sign-in page and back to where it started', async ({
  page,
}) => {
  for (const path of ['/', '/warehouse/stock', '/bottles', '/admin/users']) {
    await page.goto(path);
    await expect(page).toHaveURL(
      new RegExp(`/login\\?next=${encodeURIComponent(path).replace(/\//g, '%2F')}$`),
    );
  }
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Přihlášení do AYVO OS');
  await page.goto('/login?next=%2Fwarehouse%2Fstock');
  await signInWithForm(page, 'e2e-operator@ayvo.test');
  await expect(page).toHaveURL(/\/warehouse\/stock$/);
  await expect(page.getByTestId('current-user')).toHaveText('E2E Operátor');
});

test('the API refuses anonymous access; the passport stays public', async ({ request }) => {
  expect((await request.get('/api/admin/inventory/stock')).status()).toBe(401);
  expect((await request.get('/api/admin/identity/users')).status()).toBe(401);
  expect((await request.get('/api/health')).status()).toBe(200);
  expect((await request.get('/api/public/bottles/AAAAAAAAAAAAAAAAAAAAAA')).status()).toBe(404);
});

test('an unknown identity gets a clear "no access" page', async ({ page }) => {
  await page.goto('/login');
  await signInWithForm(page, 'stranger@ayvo.test');
  await expect(page).toHaveURL(/\/account-inactive\?reason=no-access$/);
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Účet nemá přístup');
});

test('administration: create a user, grant and revoke, deactivate — with reasons and audit', async ({
  browser,
}) => {
  const admin = await browser.newContext({ storageState: ADMIN });
  const page = await admin.newPage();
  await page.goto('/');
  // The administrator sees the whole system — every module, through ordinary permissions.
  const nav = page.getByRole('navigation', { name: 'Hlavní navigace' });
  await expect(nav.getByRole('link')).toHaveText(['Přehled', 'Sklad', 'Výroba', 'Správa systému']);
  await expect(page.getByText('nemá přístup k žádnému provoznímu modulu')).toHaveCount(0);

  await nav.getByRole('link', { name: 'Správa systému' }).click();
  await page.getByRole('link', { name: 'Nový uživatel' }).click();
  await page.getByLabel('E-mail').fill('e2e-warehouse@ayvo.test');
  await page.getByLabel('Jméno').fill('Skladník Test');
  await page.getByLabel('Skladník').check();
  await page.getByLabel(/Přerov 1/).check();
  await page.getByLabel('Důvod (povinný)').fill('new warehouse colleague');
  await page.getByRole('button', { name: 'Založit uživatele' }).click();
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Skladník Test');
  await expect(page.getByTestId('user-roles')).toHaveText('Skladník');
  await expect(page.getByTestId('user-audit')).toContainText('Založení uživatele');

  // Grant a role in the access editor, with a reason.
  const editor = page.getByTestId('access-editor');
  const production = editor.getByRole('checkbox', { name: /^Operátor výroby/ });
  await production.check();
  await editor.getByLabel('Důvod změny (povinný)').fill('helps in production too');
  await editor.getByRole('button', { name: 'Uložit změny' }).click();
  await expect(page.getByTestId('user-roles')).toHaveText('Operátor výroby, Skladník');
  await expect(page.getByTestId('user-audit')).toContainText('helps in production too');

  // The warehouse colleague signs in and sees exactly what the roles allow.
  const colleague = await browser.newContext();
  const colleaguePage = await colleague.newPage();
  await colleaguePage.goto('/login');
  await signInWithForm(colleaguePage, 'e2e-warehouse@ayvo.test');
  const colleagueNav = colleaguePage.getByRole('navigation', { name: 'Hlavní navigace' });
  await expect(colleagueNav.getByRole('link')).toHaveText(['Přehled', 'Sklad', 'Výroba']);
  await colleaguePage.goto('/admin/users');
  await expect(colleaguePage).toHaveURL(/\/forbidden$/);
  await expect(colleaguePage.getByRole('heading', { level: 1 })).toHaveText('Nemáte oprávnění');

  // Revoking a role takes effect on the next request (no new sign-in).
  await production.uncheck();
  await editor.getByLabel('Důvod změny (povinný)').fill('back to the warehouse only');
  await editor.getByRole('button', { name: 'Uložit změny' }).click();
  await expect(page.getByTestId('user-roles')).toHaveText('Skladník');
  await colleaguePage.goto('/bottles');
  await expect(colleaguePage).toHaveURL(/\/forbidden$/);
  await colleaguePage.goto('/');
  await expect(colleagueNav.getByRole('link')).toHaveText(['Přehled', 'Sklad']);

  // Deactivation ends access at once.
  const actions = page.getByTestId('user-actions');
  await actions.getByLabel('Důvod akce s účtem (povinný)').fill('left the company');
  await actions.getByRole('button', { name: 'Deaktivovat účet' }).click();
  await expect(page.getByTestId('user-status')).toContainText('Deaktivovaný');
  await colleaguePage.goto('/warehouse');
  await expect(colleaguePage).toHaveURL(/\/account-inactive$/);
  await expect(colleaguePage.getByRole('heading', { level: 1 })).toHaveText('Účet není aktivní');
  await expect(page.getByTestId('user-audit')).toContainText('Deaktivace');

  for (const width of [320, 390, 1280]) {
    await page.setViewportSize({ width, height: 900 });
    for (const path of ['/admin/users', '/admin/users/new']) {
      await page.goto(path);
      await noOverflow(page, `${path} at ${width}px`);
    }
  }
  await colleague.close();
  await admin.close();
});

test('a stock-summary role sees availability for planning and nothing operational', async ({
  browser,
}) => {
  const admin = await browser.newContext({ storageState: ADMIN });
  const user = {
    email: 'e2e-sales@ayvo.test',
    displayName: 'Obchod Test',
    siteIds: ['01990000-0000-7000-8000-000000000001'],
    warehouseCodes: [],
    reason: 'sales planning',
  };
  // SALES is a planned system role (doc 021 §4c): the API refuses it even without the UI.
  const refused = await admin.request.post('/api/admin/identity/users', {
    data: { ...user, roles: ['SALES'] },
  });
  expect(refused.status()).toBe(422);
  expect((await refused.json()).code).toBe('ROLE_NOT_AVAILABLE');
  // Planning availability today: a custom role with the SALES template's permission.
  expect(
    (
      await admin.request.post('/api/admin/identity/roles', {
        data: {
          code: 'E2E_PLANNING',
          name: 'Plánování zásob',
          description: 'Stock availability for planning',
          permissions: ['inventory:stock_summary'],
          copiedFrom: 'SALES',
          reason: 'sales planning',
        },
      })
    ).status(),
  ).toBe(201);
  expect(
    (
      await admin.request.post('/api/admin/identity/users', {
        data: { ...user, roles: ['E2E_PLANNING'] },
      })
    ).status(),
  ).toBe(201);
  await admin.close();

  const sales = await browser.newContext();
  const page = await sales.newPage();
  await page.goto('/login');
  await signInWithForm(page, 'e2e-sales@ayvo.test');
  const nav = page.getByRole('navigation', { name: 'Hlavní navigace' });
  await expect(nav.getByRole('link')).toHaveText(['Přehled', 'Sklad']);
  await expect(page.getByTestId('module-availability')).toBeVisible();
  await nav.getByRole('link', { name: 'Sklad' }).click();
  await expect(page).toHaveURL(/\/warehouse\/availability$/);
  await expect(page.getByRole('navigation', { name: 'Sklad' }).getByRole('link')).toHaveText([
    'Dostupnost',
  ]);
  await expect(page.getByTestId('availability-NEW_BOTTLE')).toBeVisible();
  await expect(page.getByTestId('availability')).not.toContainText(/šarž|dodavatel|cena/i);

  for (const path of [
    '/warehouse',
    '/warehouse/stock',
    '/warehouse/receipts',
    '/warehouse/receipts/new',
    '/bottles',
  ]) {
    await page.goto(path);
    await expect(page, path).toHaveURL(/\/forbidden$/);
  }
  for (const path of [
    '/api/admin/inventory/stock',
    '/api/admin/goods-receipts',
    '/api/admin/suppliers',
  ]) {
    expect((await page.request.get(path)).status(), path).toBe(403);
  }
  for (const width of [320, 390, 1280]) {
    await page.setViewportSize({ width, height: 900 });
    await page.goto('/warehouse/availability');
    await noOverflow(page, `/warehouse/availability at ${width}px`);
  }
  await sales.close();
});

test('sign-out ends the session; status pages are clear', async ({ page }) => {
  await page.goto('/login');
  await signInWithForm(page, 'e2e-operator@ayvo.test');
  await page.getByRole('button', { name: 'Odhlásit' }).first().click();
  await expect(page).toHaveURL(/\/login\?signed_out=1$/);
  await expect(page.getByText('Byli jste odhlášeni.')).toBeVisible();
  await page.goto('/warehouse');
  await expect(page).toHaveURL(/\/login\?next=/);

  await page.goto('/session-expired?next=%2Fwarehouse');
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Relace vypršela');
  await expect(page.getByRole('link', { name: 'Přihlásit se znovu' })).toHaveAttribute(
    'href',
    '/api/auth/login?next=%2Fwarehouse',
  );
  for (const width of [320, 390]) {
    await page.setViewportSize({ width, height: 800 });
    for (const path of ['/login', '/forbidden', '/account-inactive', '/session-expired']) {
      await page.goto(path);
      await noOverflow(page, `${path} at ${width}px`);
    }
  }
});
