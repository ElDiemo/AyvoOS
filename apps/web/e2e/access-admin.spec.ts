import { expect, test, type Page } from '@playwright/test';

/**
 * Access administration and the multi-site foundation in the browser (doc 021 §7a, doc 022):
 * ADMIN builds a custom role from permission checkboxes, assigns it together with sites, the
 * user's navigation and access follow at once, a role change removes access immediately, and a
 * user of two sites chooses and switches the active site. The e2e server adds a fictional second
 * site "Testovací provozovna DE" with its own warehouse.
 */
test.describe.configure({ mode: 'serial' });
test.use({ storageState: { cookies: [], origins: [] } });

const ADMIN = 'e2e/.auth/admin.json';
const ROLE_CODE = 'E2E_RECEIVER';
const USER_EMAIL = 'e2e-receiver@ayvo.test';

async function signInWithForm(page: Page, email: string) {
  await page.goto('/login');
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
      { message: `horizontal overflow on ${what}` },
    )
    .toBeLessThanOrEqual(0);
}

test('ADMIN builds a custom role, assigns it with two sites; access follows at once', async ({
  browser,
}) => {
  const admin = await browser.newContext({ storageState: ADMIN });
  const page = await admin.newPage();

  // System roles are read-only templates that can be duplicated.
  await page.goto('/admin/roles');
  await expect(page.getByTestId('roles')).toContainText('Skladník');
  await page.getByRole('link', { name: 'Skladník', exact: true }).click();
  await expect(page.getByText('Systémovou roli nelze upravit v aplikaci')).toBeVisible();
  await expect(page.getByRole('link', { name: 'Duplikovat jako vlastní roli' })).toBeVisible();

  // A custom role from checkboxes, grouped by module; security administration is not selectable.
  await page.goto('/admin/roles/new');
  await page.getByLabel('Kód (A–Z, 0–9, _)').fill(ROLE_CODE);
  await page.getByLabel('Název').fill('Příjem zboží E2E');
  await page.getByLabel('Popis').fill('Receives goods and reads stock');
  const permissions = page.getByTestId('role-permissions');
  await permissions.getByLabel(/Zobrazit sklad/).check();
  await permissions.getByLabel(/Přijímat zboží/).check();
  await expect(permissions.getByLabel(/Spravovat uživatele a jejich přístup/)).toBeDisabled();
  await page.getByLabel('Důvod (povinný)').fill('receiving team for both sites');
  await page.getByRole('button', { name: 'Uložit roli' }).click();
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Příjem zboží E2E');
  await expect(page.getByTestId('role-audit')).toContainText('Založení role');
  const roleUrl = page.url();

  // A user with that role at two sites; the preview shows what and where before saving.
  await page.goto('/admin/users/new');
  await page.getByLabel('E-mail').fill(USER_EMAIL);
  await page.getByLabel('Jméno').fill('Příjemce E2E');
  await page.getByLabel(/Příjem zboží E2E/).check();
  await page.getByLabel(/Výchozí provozovna/).check();
  await page.getByLabel(/Testovací provozovna DE/).check();
  const preview = page.getByTestId('access-preview');
  await expect(preview).toContainText('Přijímat zboží a nahrávat doklady');
  await expect(preview).toContainText('Výchozí provozovna');
  await expect(preview).toContainText('Testovací provozovna DE');
  await page.getByLabel('Důvod (povinný)').fill('new receiving colleague');
  await page.getByRole('button', { name: 'Založit uživatele' }).click();
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Příjemce E2E');
  const userUrl = page.url();
  const access = page.getByTestId('effective-access');
  await expect(access).toContainText('Zobrazit sklad');
  await expect(access.locator('[data-site]')).toHaveCount(2);

  // The colleague signs in: only Sklad, and with two sites the site has to be chosen first.
  const colleague = await browser.newContext();
  const colleaguePage = await colleague.newPage();
  await signInWithForm(colleaguePage, USER_EMAIL);
  const nav = colleaguePage.getByRole('navigation', { name: 'Hlavní navigace' });
  await expect(nav.getByRole('link')).toHaveText(['Přehled', 'Sklad']);
  await expect(colleaguePage.getByTestId('choose-site')).toBeVisible();
  await colleaguePage.goto('/warehouse/stock');
  await expect(colleaguePage).toHaveURL(/\/select-site\?next=%2Fwarehouse%2Fstock$/);
  await colleaguePage
    .getByTestId('site-choices')
    .locator('li', { hasText: 'Testovací provozovna DE' })
    .getByRole('button', { name: 'Pracovat zde' })
    .click();
  await expect(colleaguePage).toHaveURL(/\/warehouse\/stock$/);
  await expect(colleaguePage.getByRole('heading', { level: 1 })).toHaveText(
    'Stav skladu – Testovací sklad DE',
  );

  // Switching the site in the shell reloads the operational context of the other site.
  await colleaguePage
    .getByTestId('site-switcher')
    .selectOption({ label: 'SITE-1 · Výchozí provozovna' });
  await expect(colleaguePage.getByRole('heading', { level: 1 })).toHaveText(
    'Stav skladu – Hlavní sklad',
  );
  await expect(colleaguePage.locator('body')).not.toContainText('Testovací sklad DE');
  await colleaguePage.goto('/bottles');
  await expect(colleaguePage).toHaveURL(/\/forbidden$/);

  // Narrowing the role removes access on the colleague's very next request.
  await page.goto(roleUrl);
  await page
    .getByTestId('role-permissions')
    .getByLabel(/Zobrazit sklad/)
    .uncheck();
  await page.getByLabel('Důvod (povinný)').first().fill('stock overview no longer needed');
  await page.getByRole('button', { name: 'Uložit roli' }).click();
  await expect(page.getByTestId('role-audit')).toContainText('Úprava role');
  await colleaguePage.goto('/warehouse/stock');
  await expect(colleaguePage).toHaveURL(/\/forbidden$/);

  // Removing a site removes it from the colleague's choice at once.
  await page.goto(userUrl);
  const actions = page.getByTestId('user-actions');
  await actions.getByLabel('Důvod (povinný)').fill('moved to the Czech site only');
  await actions.getByRole('button', { name: 'Odebrat: E2E-DE' }).click();
  await expect(page.getByTestId('user-sites')).not.toContainText('E2E-DE');
  await colleaguePage.goto('/');
  await expect(colleaguePage.getByTestId('active-site')).toHaveText('SITE-1');
  await expect(colleaguePage.getByTestId('site-switcher')).toHaveCount(0);

  await colleague.close();
  await admin.close();
});

test('administration and site pages fit phones and desktops without sideways scrolling', async ({
  browser,
}) => {
  const admin = await browser.newContext({ storageState: ADMIN });
  const page = await admin.newPage();
  await page.goto('/admin/sites');
  await expect(page.getByTestId('sites')).toContainText('SITE-1');
  await expect(page.getByTestId('sites')).toContainText('Adresa není doplněná');
  await page.getByRole('link', { name: 'Výchozí provozovna' }).click();
  await expect(page.getByTestId('site-blockers')).toBeVisible();
  const sitePath = new URL(page.url()).pathname;
  for (const width of [320, 390, 1280]) {
    await page.setViewportSize({ width, height: 900 });
    for (const path of [
      '/admin/roles',
      '/admin/roles/new',
      '/admin/sites',
      '/admin/sites/new',
      sitePath,
      '/select-site',
    ]) {
      await page.goto(path);
      await noOverflow(page, `${path} at ${width}px`);
    }
  }
  await admin.close();
});
