import { expect, test } from '@playwright/test';
import { e2eRows } from './e2e-db';

/**
 * "Odepsat pumpičky" (doc 047 §6.2, step P) on the real built app at 390 px: one count X per
 * entry; an uncertain answer keeps the entry apart with its own request id, and "Zkusit znovu"
 * sends the SAME request even after another entry changed the total — one row of X, never two;
 * no stock movement.
 */
test.use({ storageState: 'e2e/.auth/admin.json' });

test('an uncertain write-off of 5 is retried as the same request after the total changed', async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 900 });
  await page.goto('/warehouse/returns');
  await page.getByRole('button', { name: 'Otevřít příjem' }).click();
  await expect(page).toHaveURL(/\/returns\/RR-\d{6}$/);
  const code = page.url().split('/').pop()!;
  const movements = async () =>
    Number(
      (await e2eRows<{ n: bigint }>(`SELECT count(*) AS "n" FROM "inventory_movements"`))[0]!.n,
    );
  const before = await movements();
  const ids: string[] = [];
  let lose = true;
  await page.route(`**/api/admin/returns/receipts/${code}/pumps`, async (route) => {
    ids.push((JSON.parse(route.request().postData()!) as { requestId: string }).requestId);
    if (!lose) return route.continue();
    // The server commits, the answer is lost on the way back.
    lose = false;
    await route.fetch();
    await route.fulfill({ status: 503, body: '{"statusCode":503}' });
  });
  const field = page.getByRole('textbox', { name: 'Odepsat pumpičky (ks)' });
  await field.fill('5');
  await page.getByRole('button', { name: 'Zapsat odpis' }).click();
  const unconfirmed = page.getByTestId('pump-unconfirmed');
  await expect(unconfirmed).toContainText('Výsledek nepotvrzený: odpis 5 ks');
  await expect(field).toBeDisabled();
  // Meanwhile another entry (another operator): the total changes on the server.
  const other = await page.request.post(`/api/admin/returns/receipts/${code}/pumps`, {
    data: { requestId: crypto.randomUUID(), defective: 2, reason: null },
  });
  expect(other.ok()).toBe(true);
  await unconfirmed.getByRole('button', { name: 'Zkusit znovu' }).click();
  await expect(unconfirmed).toHaveCount(0);
  await expect(page.getByTestId('pump-count')).toHaveText('Odepsané pumpičky: 7');
  expect(ids).toHaveLength(2);
  expect(ids[1]).toBe(ids[0]);
  const rows = await e2eRows<{ defective: number }>(
    `SELECT c."defective" FROM "return_pump_counts" c JOIN "return_receipts" r ON r."id" = c."receipt_id"
      WHERE r."code" = '${code}' ORDER BY c."defective"`,
  );
  expect(rows.map((r) => Number(r.defective))).toEqual([2, 5]);
  expect(await movements()).toBe(before);
  // A next entry is a new request; an invalid count is not offered.
  await field.fill('0');
  await expect(page.getByRole('button', { name: 'Zapsat odpis' })).toBeDisabled();
  await field.fill('1');
  await page.getByRole('button', { name: 'Zapsat odpis' }).click();
  await expect(page.getByTestId('pump-count')).toHaveText('Odepsané pumpičky: 8');
  expect(new Set(ids).size).toBe(2);
});
