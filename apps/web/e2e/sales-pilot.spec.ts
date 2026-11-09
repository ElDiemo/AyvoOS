import { expect, test } from '@playwright/test';
import type { ProspectDetail } from '@ayvo/types';
import { json, noOverflow } from './dispatch-setup';
import { prospect, shot, signIn } from './sales-setup';

const tag = Date.now().toString(36).slice(-5).toUpperCase();
const U = { email: `e2e-pilot-${tag}@ayvo.test`.toLowerCase(), name: 'Pavel Obchodník' };

/** Fáze Pilot: chosen in the stage dialog, shown on the card and offered a next step; 390 px. */
test('Pilot: set from Nabídka, shown, the next-step offer; 390 px', async ({ browser }) => {
  const admin = await browser.newContext({ storageState: 'e2e/.auth/admin.json' });
  await json(
    await admin.request.post('/api/admin/identity/users', {
      data: {
        email: U.email,
        displayName: U.name,
        roles: ['SALES'],
        siteIds: [],
        warehouseCodes: [],
        reason: 'obchodník (E2E pilot)',
      },
    }),
  );
  await admin.close();
  const page = await signIn(browser, U.email);
  const d = await json<ProspectDetail>(
    await page.request.post('/api/admin/sales/prospects', {
      data: prospect(`Hotel Pilot ${tag}`, { city: 'Kroměříž' }),
    }),
  );
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`/sales/prospects/${d.code}`);
  await page.getByTestId('change-stage').click();
  await page.getByTestId('stage-select').selectOption({ label: 'Pilot' });
  await page.getByTestId('stage-dialog-submit').click();
  await expect(page.getByTestId('prospect-stage')).toHaveText('Pilot');
  await expect(page.getByTestId('next-step-offer')).toBeVisible();
  await noOverflow(page);
  await shot(page, 'sales-pilot-390');
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto('/sales/prospects?stage=PILOT');
  await expect(page.getByTestId(`prospect-${d.code}`)).toBeVisible();
  await page.context().close();
});
