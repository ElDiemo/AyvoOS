import { expect, test, type Page } from '@playwright/test';

/**
 * Issue #11: the access editor protects unsaved changes (UI-01) and comes before the audit on
 * narrow screens (UI-03). The admin session is shared with other specs, so the site switch is
 * only ever cancelled here, never performed.
 */
test.use({ storageState: 'e2e/.auth/admin.json' });

async function newUser(page: Page, email: string): Promise<string> {
  const created = await page.request.post('/api/admin/identity/users', {
    data: {
      email,
      displayName: 'Neuložené změny',
      roles: ['WAREHOUSE_OPERATOR'],
      siteIds: ['01990000-0000-7000-8000-000000000001'],
      warehouseCodes: [],
      reason: 'unsaved changes test',
    },
  });
  expect(created.status()).toBe(201);
  return ((await created.json()) as { id: string }).id;
}

test('unsaved access changes: marked, kept on "continue", dropped on "discard"', async ({
  page,
}) => {
  const id = await newUser(page, 'e2e-unsaved-access@ayvo.test');
  await page.goto(`/admin/users/${id}`);
  const editor = page.getByTestId('access-editor');
  const supervisor = editor.getByRole('checkbox', { name: /^Vedoucí skladu/ });
  const dialog = page.getByTestId('unsaved-dialog');
  const leave = page.getByRole('link', { name: 'Uživatelé a role' }).first();

  // A clean form leaves without any question.
  await expect(editor.getByTestId('unsaved-badge')).toHaveCount(0);
  await leave.click();
  await expect(page).toHaveURL(/\/admin\/users$/);
  await expect(dialog).toBeHidden();
  await page.goto(`/admin/users/${id}`);

  // A change is marked; leaving asks; "continue editing" keeps the draft and the page.
  await supervisor.check();
  await expect(editor.getByTestId('unsaved-badge')).toHaveText('Neuložené změny');
  await leave.click();
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText('Změny v tomto formuláři nejsou uložené.');
  await expect(dialog.getByRole('button', { name: 'Pokračovat v úpravách' })).toBeFocused();
  await dialog.getByRole('button', { name: 'Pokračovat v úpravách' }).click();
  await expect(dialog).toBeHidden();
  await expect(page).toHaveURL(new RegExp(`/admin/users/${id}$`));
  await expect(supervisor).toBeChecked();
  await expect(editor.getByTestId('access-summary')).toContainText('Vedoucí skladu');

  // Escape keeps editing too.
  await leave.click();
  await expect(dialog).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
  await expect(supervisor).toBeChecked();

  // Switching the active site asks as well; cancelling keeps the site and the draft.
  const switcher = page.getByTestId('site-switcher');
  const site = await switcher.inputValue();
  const other = await switcher
    .locator('option')
    .evaluateAll(
      (o, current) => (o as HTMLOptionElement[]).find((x) => x.value && x.value !== current)?.value,
      site,
    );
  expect(other).toBeTruthy();
  await switcher.selectOption(other!);
  await expect(dialog).toBeVisible();
  await dialog.getByRole('button', { name: 'Pokračovat v úpravách' }).click();
  await expect(switcher).toHaveValue(site);
  await expect(supervisor).toBeChecked();

  // Reload and closing the tab: the page asks the browser for its standard prompt (the
  // beforeunload event is cancelled) only while there are unsaved changes.
  const unloadBlocked = () =>
    page.evaluate(() => {
      const e = new Event('beforeunload', { cancelable: true });
      window.dispatchEvent(e);
      return e.defaultPrevented;
    });
  expect(await unloadBlocked()).toBe(true);

  // "Discard" leaves, and nothing was saved.
  await leave.click();
  await dialog.getByRole('button', { name: 'Zahodit změny' }).click();
  await expect(page).toHaveURL(/\/admin\/users$/);
  await page.goto(`/admin/users/${id}`);
  await expect(supervisor).not.toBeChecked();
  await expect(page.getByTestId('user-roles')).toHaveText('Skladník');
  expect(await unloadBlocked()).toBe(false);
});

test('after saving or discarding explicitly, leaving asks nothing', async ({ page }) => {
  const id = await newUser(page, 'e2e-unsaved-saved@ayvo.test');
  await page.goto(`/admin/users/${id}`);
  const editor = page.getByTestId('access-editor');
  const supervisor = editor.getByRole('checkbox', { name: /^Vedoucí skladu/ });
  const dialog = page.getByTestId('unsaved-dialog');
  const leave = page.getByRole('link', { name: 'Uživatelé a role' }).first();

  // The editor's own "discard" clears the guard.
  await supervisor.check();
  await editor.getByRole('button', { name: 'Zahodit změny' }).click();
  await expect(editor.getByTestId('unsaved-badge')).toHaveCount(0);
  await leave.click();
  await expect(page).toHaveURL(/\/admin\/users$/);
  await expect(dialog).toBeHidden();

  // A successful save clears it too.
  await page.goto(`/admin/users/${id}`);
  await supervisor.check();
  await editor.getByLabel('Důvod změny (povinný)').fill('vedoucí skladu');
  await editor.getByRole('button', { name: 'Uložit změny' }).click();
  await expect(page.getByTestId('user-roles')).toContainText('Vedoucí skladu');
  await expect(editor.getByTestId('unsaved-badge')).toHaveCount(0);
  await leave.click();
  await expect(page).toHaveURL(/\/admin\/users$/);
  await expect(dialog).toBeHidden();
});

test('on phones the access editor comes before the audit; no sideways scrolling', async ({
  page,
}) => {
  const id = await newUser(page, 'e2e-unsaved-mobile@ayvo.test');
  for (const width of [320, 390]) {
    await page.setViewportSize({ width, height: 800 });
    await page.goto(`/admin/users/${id}`);
    const editor = await page.getByTestId('access-editor').boundingBox();
    const audit = await page.getByTestId('user-audit').boundingBox();
    expect(editor && audit && editor.y < audit.y, `editor before audit at ${width}px`).toBe(true);
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow, `overflow at ${width}px`).toBeLessThanOrEqual(0);
  }
  // Wide screens keep the two columns: editing on the right, next to the overview.
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(`/admin/users/${id}`);
  const editing = await page.getByTestId('user-editing').boundingBox();
  const audit = await page.getByTestId('user-audit').boundingBox();
  expect(editing!.x).toBeGreaterThan(audit!.x + audit!.width - 1);
  expect(editing!.y).toBeLessThan(audit!.y);
});
