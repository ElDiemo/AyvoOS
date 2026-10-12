import { expect, test, type Page } from '@playwright/test';

/**
 * The access editor of an existing user (doc 021 §7): one draft for roles and sites, a Czech
 * summary of what will be saved, the reason checked only when saving, one atomic save — and the
 * original state restored afterwards. Keyboard operable and without sideways scrolling.
 */
test.use({ storageState: 'e2e/.auth/admin.json' });

const EMAIL = 'e2e-access-editor@ayvo.test';

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

test('ADMIN changes a user’s roles and sites in one save and restores them', async ({ page }) => {
  const created = await page.request.post('/api/admin/identity/users', {
    data: {
      email: EMAIL,
      displayName: 'Editor přístupu',
      roles: ['WAREHOUSE_OPERATOR'],
      siteIds: ['01990000-0000-7000-8000-000000000001'],
      warehouseCodes: [],
      reason: 'access editor test',
    },
  });
  expect(created.status()).toBe(201);
  const { id } = (await created.json()) as { id: string };
  await page.goto(`/admin/users/${id}`);

  const editor = page.getByTestId('access-editor');
  const status = editor.getByTestId('access-status');
  const summary = editor.getByTestId('access-summary');
  const save = editor.getByRole('button', { name: 'Uložit změny' });
  const supervisor = editor.getByRole('checkbox', { name: /^Vedoucí skladu/ });
  const operator = editor.getByRole('checkbox', { name: /^Skladník/ });
  const de = editor.locator('[data-access-site="E2E-DE"]').getByRole('checkbox');
  const cz = editor.locator('[data-access-site="CZ-PREROV-01"]').getByRole('checkbox');

  // Current state is marked; nothing to save yet, and the button says why.
  await expect(operator).toBeChecked();
  await expect(editor.locator('[data-role="WAREHOUSE_OPERATOR"]')).toContainText('(současná)');
  await expect(cz).toBeChecked();
  await expect(editor.locator('[data-access-site="CZ-PREROV-01"]')).toContainText(
    'Všechny sklady provozovny (MAIN).',
  );
  await expect(save).toBeEnabled();
  await expect(status).toHaveText('Nejsou žádné změny k uložení.');

  // Draft by keyboard and mouse: add a role and a site, remove a role.
  await supervisor.focus();
  await page.keyboard.press('Space');
  await expect(supervisor).toBeChecked();
  await de.check();
  await operator.uncheck();
  await expect(editor.locator('[data-role="WAREHOUSE_OPERATOR"]')).toContainText('(odebere se)');
  await expect(editor.locator('[data-role="WAREHOUSE_SUPERVISOR"]')).toContainText('(přidá se)');
  await expect(summary).toContainText('Přidané role');
  await expect(summary).toContainText('Vedoucí skladu');
  await expect(summary).toContainText('Přidané provozovny');
  await expect(summary).toContainText('E2E-DE');
  await expect(summary).toContainText('Odebrané role');
  await expect(summary).toContainText('Skladník');
  await expect(status).toBeEmpty();
  // Nothing is saved yet.
  await expect(page.getByTestId('user-roles')).toHaveText('Skladník');

  // The reason is checked when saving: a concrete message, the field gets focus.
  await save.click();
  await expect(status).toHaveText('Vyplňte důvod změny (alespoň 3 znaky).');
  const reason = editor.getByLabel('Důvod změny (povinný)');
  await expect(reason).toBeFocused();
  await page.keyboard.type('vedoucí skladu pro obě provozovny');
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('user-roles')).toHaveText('Vedoucí skladu');
  await expect(page.getByTestId('user-audit')).toContainText('Změna přístupu');
  await expect(page.getByTestId('user-audit')).toContainText('vedoucí skladu pro obě provozovny');
  await expect(editor.locator('[data-access-site="E2E-DE"]')).toContainText('(současná)');
  await expect(status).toHaveText('Nejsou žádné změny k uložení.');

  for (const width of [320, 390, 820, 1280]) {
    await page.setViewportSize({ width, height: 900 });
    await noOverflow(page, `user detail at ${width}px`);
  }
  await page.setViewportSize({ width: 1280, height: 900 });

  // Restore the original access in one save.
  await operator.check();
  await supervisor.uncheck();
  await de.uncheck();
  await reason.fill('návrat do původního stavu');
  await save.click();
  await expect(page.getByTestId('user-roles')).toHaveText('Skladník');
  await expect(de).not.toBeChecked();
  await expect(cz).toBeChecked();
  const after = (await (await page.request.get(`/api/admin/identity/users/${id}`)).json()) as {
    roles: { code: string }[];
    scopes: { type: string; siteCode: string | null }[];
  };
  expect(after.roles.map((r) => r.code)).toEqual(['WAREHOUSE_OPERATOR']);
  expect(after.scopes.map((s) => `${s.type}:${s.siteCode}`)).toEqual(['SITE:CZ-PREROV-01']);
});
