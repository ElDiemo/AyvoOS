import { expect, test } from '@playwright/test';

/**
 * Planned system roles in the browser (doc 021 §4c): FINANCE ("Finance") and HOTEL_USER ("Uživatel
 * hotelu") appear disabled with "Připravuje se" when a user is created or
 * edited, never as selectable roles, and the role pages mark them as planned templates. The server
 * refuses them independently (API tests and identity.spec).
 */
test.use({ storageState: 'e2e/.auth/admin.json' });

const PLANNED = [
  ['FINANCE', 'Finance'],
  ['HOTEL_USER', 'Uživatel hotelu'],
] as const;

test('user creation shows planned roles disabled, labelled "Připravuje se"', async ({ page }) => {
  await page.goto('/admin/users/new');
  const planned = page.getByTestId('planned-roles');
  await expect(planned).toContainText('Připravované role (zatím nelze přidělit)');
  for (const [code, name] of PLANNED) {
    const row = planned.locator(`[data-planned-role="${code}"]`);
    await expect(row).toContainText(name);
    await expect(row).toContainText('Připravuje se');
    await expect(row.getByRole('checkbox')).toBeDisabled();
    await expect(row.getByRole('checkbox')).not.toBeChecked();
  }
  await expect(planned.locator('[data-planned-role="HOTEL_USER"]')).toContainText(
    'není to interní provozní role',
  );
  // Active roles stay selectable; the planned ones are not among them.
  const skladnik = page.getByLabel('Skladník', { exact: true });
  await expect(skladnik).toBeEnabled();
  await skladnik.check();
  await expect(page.getByTestId('access-preview')).toBeVisible();
  for (const [, name] of PLANNED) {
    await expect(page.getByRole('checkbox', { name, exact: true })).toHaveCount(0);
  }
  // SALES is assignable since Obchod exists (doc 034).
  await expect(page.locator('[data-planned-role="SALES"]')).toHaveCount(0);
  await expect(page.getByLabel('Obchod', { exact: true })).toBeEnabled();
});

test('the access editor shows planned roles only disabled, labelled "Připravuje se"', async ({
  page,
}) => {
  await page.goto('/admin/users');
  await page.locator('a[href^="/admin/users/"]:not([href="/admin/users/new"])').first().click();
  await page.waitForURL(/\/admin\/users\/[0-9a-f-]{36}$/);
  const planned = page.getByTestId('access-editor').getByTestId('planned-roles');
  for (const [code, name] of PLANNED) {
    const row = planned.locator(`[data-planned-role="${code}"]`);
    await expect(row).toContainText(name);
    await expect(row).toContainText('Připravuje se');
    await expect(row.getByRole('checkbox')).toBeDisabled();
  }
});

test('role pages mark the planned roles as templates that are not assignable', async ({ page }) => {
  await page.goto('/admin/roles');
  for (const [code] of PLANNED) {
    await expect(
      page.locator(`tr[data-role="${code}"] [data-planned-role="${code}"]`),
    ).toContainText('Připravuje se');
  }
  await expect(page.locator('tr[data-role="WAREHOUSE_OPERATOR"]')).not.toContainText(
    'Připravuje se',
  );
  await page.locator('tr[data-role="HOTEL_USER"]').getByRole('link').click();
  await expect(page.getByTestId('planned-role')).toContainText('Externí role hotelového portálu');
  await expect(page.getByTestId('planned-role')).toContainText('Nelze ji přidělit');
});
