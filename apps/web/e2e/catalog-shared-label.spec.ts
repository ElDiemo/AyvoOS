import { expect, test } from '@playwright/test';

/**
 * The shared blank label (doc 023 §4a, owner 2026-10-27): a label component without a product
 * category, with pieces per roll as an entry aid (the receipt aid itself is in warehouse.spec, where
 * a supplier exists).
 */
test.use({ storageState: 'e2e/.auth/admin.json' });

test('a shared blank label: no category, 300 pieces per roll (the receipt aid: warehouse.spec)', async ({
  page,
}) => {
  await page.goto('/production/catalog/components/new');
  const form = page.getByTestId('component-form');
  await form.getByLabel('Druh').selectOption({ label: 'Etiketa' });
  // No category = the shared blank label (offered as such, not an error).
  await expect(form.getByLabel('Určeno pro kategorii')).toHaveValue('');
  await expect(form.getByLabel('Určeno pro kategorii').locator('option').first()).toHaveText(
    'Společná – prázdná etiketa pro všechny produkty',
  );
  await form.getByLabel('Název').fill('Černá prázdná etiketa');
  await form.getByLabel('Kód').fill('LABEL-BLANK');
  await form.getByLabel('Sledovat po šaržích').uncheck();
  await form.getByLabel('Kusů v roli').fill('300');
  await form.getByLabel('Důvod (povinný)').fill('společný materiál etiket');
  await form.getByRole('button', { name: 'Založit komponentu' }).click();
  await expect(page).toHaveURL(/\/production\/catalog\/components\?created=LABEL-BLANK$/);
  const row = page.getByRole('listitem').filter({ hasText: 'LABEL-BLANK' });
  await expect(row).toContainText('Společná (prázdná etiketa)');
  await expect(row).toContainText('Kusů v roli: 300');
});
