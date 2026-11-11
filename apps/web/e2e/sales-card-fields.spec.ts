import { expect, test, type Page } from '@playwright/test';
import type { ProspectDetail } from '@ayvo/types';
import { json, noOverflow } from './dispatch-setup';
import { prospect, shot, signIn } from './sales-setup';

test.describe.configure({ mode: 'serial' });

const tag = Date.now().toString(36).slice(-5).toUpperCase();
const U = { email: `e2e-karta-${tag}@ayvo.test`.toLowerCase(), name: 'Petra Obchodnice' };
const codes: Record<'visit' | 'failed', string> = { visit: '', failed: '' };

async function dialogSubmit(page: Page, id: string) {
  await page.getByTestId(`${id}-submit`).click();
  await expect(page.getByTestId(id)).toBeHidden();
}
const meetings = async (page: Page, code: string) =>
  (
    await json<ProspectDetail>(await page.request.get(`/api/admin/sales/prospects/${code}`))
  ).activities.filter((x) => x.kind === 'MEETING');

/**
 * "Současná kosmetika" and "Hlavní námitka" on the hotel's card: filled from the visit guide
 * (one Schůzka, then the card), shown on the card and in its edit form; when the card cannot be
 * updated the Schůzka stays saved once and the page says so; 390 px without sideways scrolling.
 */
test.beforeAll(async ({ browser }) => {
  const admin = await browser.newContext({ storageState: 'e2e/.auth/admin.json' });
  await json(
    await admin.request.post('/api/admin/identity/users', {
      data: {
        email: U.email,
        displayName: U.name,
        roles: ['SALES'],
        siteIds: [],
        warehouseCodes: [],
        reason: 'obchodník (E2E karta hotelu)',
      },
    }),
  );
  await admin.close();
  const page = await signIn(browser, U.email);
  for (const key of ['visit', 'failed'] as const) {
    const d = await json<ProspectDetail>(
      await page.request.post('/api/admin/sales/prospects', {
        data: prospect(`Hotel Karta ${key} ${tag}`, { city: 'Přerov' }),
      }),
    );
    codes[key] = d.code;
  }
  await page.context().close();
});

test('the visit guide fills the card; the edit form shows and saves both fields (390 px)', async ({
  browser,
}) => {
  const page = await signIn(browser, U.email);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`/sales/prospects/${codes.visit}`);
  await expect(page.getByTestId('prospect-amenities')).toHaveText('neuvedeno');
  await page.getByTestId('start-visit').click();
  const visit = page.getByTestId('visit-dialog');
  await expect(visit.getByTestId('visit-to-card')).toHaveCount(0); // nothing to copy yet
  await visit.getByTestId('visit-text-now').fill('jednorázové lahvičky od velkoobchodu');
  await visit.getByTestId('visit-text-objections').fill('cena');
  await expect(visit.getByTestId('visit-to-card')).toBeChecked();
  await dialogSubmit(page, 'visit-dialog');
  await expect(page.getByTestId('prospect-amenities')).toHaveText(
    'jednorázové lahvičky od velkoobchodu',
  );
  await expect(page.getByTestId('prospect-objection')).toHaveText('cena');
  expect(await meetings(page, codes.visit)).toHaveLength(1);
  await noOverflow(page);
  await shot(page, 'sales-card-fields-390');
  // The edit form: both fields, saved like any other profile field.
  await page.getByTestId('edit-prospect').click();
  await page.locator('[name=mainObjection]').fill('logistika – kdo bude měnit lahve');
  await page.getByRole('button', { name: 'Uložit změny' }).click();
  await expect(page.getByTestId('prospect-objection')).toHaveText(
    'logistika – kdo bude měnit lahve',
  );
  await page.context().close();
});

test('the card cannot be updated: the Schůzka stays saved once, the page says so', async ({
  browser,
}) => {
  const page = await signIn(browser, U.email);
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto(`/sales/prospects/${codes.failed}`);
  await page.route(`**/api/admin/sales/prospects/${codes.failed}/update`, (route) =>
    route.abort('connectionreset'),
  );
  await page.getByTestId('start-visit').click();
  const visit = page.getByTestId('visit-dialog');
  await visit.getByTestId('visit-text-objections').fill('současný dodavatel');
  await dialogSubmit(page, 'visit-dialog');
  await expect(page.getByTestId('visit-card-failed')).toBeVisible();
  expect(await meetings(page, codes.failed)).toHaveLength(1);
  await page.unroute(`**/api/admin/sales/prospects/${codes.failed}/update`);
  await page.reload();
  await expect(page.getByTestId('prospect-objection')).toHaveText('neuvedeno');
  await page.context().close();
});
