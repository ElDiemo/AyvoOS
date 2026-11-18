import { expect, test, type Page } from '@playwright/test';
import type { ProspectDetail } from '@ayvo/types';
import { json, noOverflow } from './dispatch-setup';
import { pragueDay, prospect, shot, signIn } from './sales-setup';

test.describe.configure({ mode: 'serial' });

const tag = Date.now().toString(36).slice(-5).toUpperCase();
const G = { email: `e2e-krok-g-${tag}@ayvo.test`.toLowerCase(), name: 'Gita Obchodnice' };
const H = { email: `e2e-krok-h-${tag}@ayvo.test`.toLowerCase(), name: 'Hynek Obchodník' };
const codes: Record<string, string> = {};

async function dialogSubmit(page: Page, id: string) {
  await page.getByTestId(`${id}-submit`).click();
  await expect(page.getByTestId(id)).toBeHidden();
}

/**
 * The next step (Obchod): the overview lists the prospects in progress without any open task, each
 * opening its prospect; after a confirmed activity or stage change without a next step the detail
 * offers to plan one with the ordinary task form (never blocking); a lost answer retried writes the
 * activity once; another salesperson's prospects never appear; 390 px without sideways scrolling.
 */
test.beforeAll(async ({ browser }) => {
  const admin = await browser.newContext({ storageState: 'e2e/.auth/admin.json' });
  for (const u of [G, H])
    await json(
      await admin.request.post('/api/admin/identity/users', {
        data: {
          email: u.email,
          displayName: u.name,
          roles: ['SALES'],
          siteIds: [],
          warehouseCodes: [],
          reason: 'obchodník (E2E další krok)',
        },
      }),
    );
  await admin.close();
  for (const [u, key, name, stage] of [
    [G, 'lonely', `Hotel Bez kroku ${tag}`, 'CONTACTED'],
    [G, 'fresh', `Hotel Nový ${tag}`, null],
    [H, 'foreign', `Hotel Cizí ${tag}`, 'CONTACTED'],
  ] as const) {
    const page = await signIn(browser, u.email);
    const d = await json<ProspectDetail>(
      await page.request.post('/api/admin/sales/prospects', {
        data: prospect(name, { city: 'Zlín' }),
      }),
    );
    if (stage)
      await json(
        await page.request.post(`/api/admin/sales/prospects/${d.code}/stage`, {
          data: {
            requestId: crypto.randomUUID(),
            revision: d.revision,
            stage,
            reason: null,
            lostReason: null,
          },
        }),
      );
    codes[key] = d.code;
    await page.context().close();
  }
});

test('the overview lists only my prospects in progress without a next step; each opens', async ({
  browser,
}) => {
  const page = await signIn(browser, G.email);
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto('/sales');
  const card = page.getByTestId('overview-without-next-step');
  await expect(card.getByTestId(`missing-${codes.lonely}`)).toBeVisible();
  await expect(card.getByTestId(`missing-${codes.fresh}`)).toHaveCount(0); // NEW: not in progress
  await expect(card.getByTestId(`missing-${codes.foreign}`)).toHaveCount(0); // another's
  await expect(card).toContainText('zatím bez kontaktu');
  await shot(page, 'sales-next-step-overview-1280');
  // "All of them": the list filtered to in progress without a next step.
  await card.getByRole('link', { name: 'Všichni bez dalšího kroku' }).click();
  await expect(page.getByTestId('filter-phase')).toBeVisible();
  await expect(page.getByTestId(`prospect-${codes.lonely}`)).toBeVisible();
  await expect(page.getByTestId(`prospect-${codes.fresh}`)).toHaveCount(0);
  // Another salesperson's prospect: not found.
  const foreign = await page.goto(`/sales/prospects/${codes.foreign}`);
  expect(foreign?.status()).toBe(404);
  await page.goto('/sales');
  await card.getByRole('link', { name: new RegExp(`Hotel Bez kroku ${tag}`) }).click();
  await expect(page.getByRole('heading', { level: 1 })).toContainText(`Hotel Bez kroku ${tag}`);
  await page.context().close();
});

test('after an activity: the offer opens the ordinary task form; a lost answer retried writes once', async ({
  browser,
}) => {
  const page = await signIn(browser, G.email);
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto(`/sales/prospects/${codes.lonely}`);
  // The first answer of the activity write is lost after the server committed it.
  let lost = false;
  await page.route(`**/api/admin/sales/prospects/${codes.lonely}/activities`, async (route) => {
    if (!lost && route.request().method() === 'POST') {
      lost = true;
      await route.fetch();
      await route.abort('connectionreset');
      return;
    }
    await route.continue();
  });
  await page.getByTestId('record-activity').click();
  const activity = page.getByTestId('activity-dialog');
  await activity.getByTestId('activity-content').fill('Telefonát s recepcí, pošleme vzorky.');
  await activity.getByTestId('activity-dialog-submit').click();
  await expect(activity).toBeVisible(); // the answer did not arrive: the dialog keeps its text
  await dialogSubmit(page, 'activity-dialog'); // the same attempt again
  const offer = page.getByTestId('next-step-offer');
  await expect(offer).toContainText('nemá žádný další krok');
  const detail = await json<ProspectDetail>(
    await page.request.get(`/api/admin/sales/prospects/${codes.lonely}`),
  );
  expect(
    detail.activities.filter((x) => x.content === 'Telefonát s recepcí, pošleme vzorky.'),
  ).toHaveLength(1);
  await page.unroute(`**/api/admin/sales/prospects/${codes.lonely}/activities`);

  // The offer opens the ordinary task form; saving it plans the next step.
  await page.getByTestId('next-step-plan').click();
  const task = page.getByTestId('task-dialog');
  await task.getByTestId('task-title').fill('Doručit vzorky');
  await task.getByTestId('task-due').fill(pragueDay(3));
  await dialogSubmit(page, 'task-dialog');
  await expect(offer).toHaveCount(0);
  await expect(page.getByTestId('prospect-next')).toContainText('Doručit vzorky');
  await page.goto('/sales');
  await expect(page.getByTestId(`missing-${codes.lonely}`)).toHaveCount(0);
  await page.context().close();
});

test('after a stage change: the offer, never blocking ("Teď ne"); 390 px', async ({ browser }) => {
  const page = await signIn(browser, G.email);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`/sales/prospects/${codes.fresh}`);
  await page.getByTestId('change-stage').click();
  await page.getByTestId('stage-select').selectOption({ label: 'Oslovený' });
  await dialogSubmit(page, 'stage-dialog');
  await expect(page.getByTestId('prospect-stage')).toHaveText('Oslovený');
  const offer = page.getByTestId('next-step-offer');
  await expect(offer).toBeVisible();
  await noOverflow(page);
  await shot(page, 'sales-next-step-offer-390');
  // Not blocking: the page works on; "Teď ne" hides the offer.
  await expect(page.getByTestId('record-activity')).toBeEnabled();
  await page.getByTestId('next-step-later').click();
  await expect(offer).toHaveCount(0);
  await page.goto('/sales');
  await expect(page.getByTestId(`missing-${codes.fresh}`)).toBeVisible();
  await noOverflow(page);
  await shot(page, 'sales-next-step-overview-390');
  await page.context().close();
});
