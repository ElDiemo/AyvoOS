import { expect, test, type Page } from '@playwright/test';
import type { ProspectDetail } from '@ayvo/types';
import { json, noOverflow } from './dispatch-setup';
import { pragueDay, prospect, shot, signIn } from './sales-setup';

test.describe.configure({ mode: 'serial' });

const tag = Date.now().toString(36).slice(-5).toUpperCase();
const V = { email: `e2e-navsteva-${tag}@ayvo.test`.toLowerCase(), name: 'Vera Obchodnice' };
let code = '';

async function dialogSubmit(page: Page, id: string) {
  await page.getByTestId(`${id}-submit`).click();
  await expect(page.getByTestId(id)).toBeHidden();
}

/**
 * "Zahájit návštěvu" (Obchod): a short guide through a visit saves one ordinary Schůzka with what
 * was covered; without a next task the detail offers to plan it (the same next step), with one it
 * does not; 390 px without sideways scrolling.
 */
test.beforeAll(async ({ browser }) => {
  const admin = await browser.newContext({ storageState: 'e2e/.auth/admin.json' });
  await json(
    await admin.request.post('/api/admin/identity/users', {
      data: {
        email: V.email,
        displayName: V.name,
        roles: ['SALES'],
        siteIds: [],
        warehouseCodes: [],
        reason: 'obchodník (E2E návštěva)',
      },
    }),
  );
  await admin.close();
  const page = await signIn(browser, V.email);
  const d = await json<ProspectDetail>(
    await page.request.post('/api/admin/sales/prospects', {
      data: prospect(`Hotel Návštěva ${tag}`, { city: 'Olomouc' }),
    }),
  );
  await json(
    await page.request.post(`/api/admin/sales/prospects/${d.code}/stage`, {
      data: {
        requestId: crypto.randomUUID(),
        revision: d.revision,
        stage: 'CONTACTED',
        reason: null,
        lostReason: null,
      },
    }),
  );
  code = d.code;
  await page.context().close();
});

test('the visit guide saves one Schůzka with what was covered and offers the next step (390 px)', async ({
  browser,
}) => {
  const page = await signIn(browser, V.email);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`/sales/prospects/${code}`);
  await page.getByTestId('start-visit').click();
  const visit = page.getByTestId('visit-dialog');
  await expect(visit.getByTestId('visit-progress')).toHaveText('0/5 hotovo');
  // Nothing filled in: refused, nothing written.
  await visit.getByTestId('visit-dialog-submit').click();
  await expect(visit).toContainText('Vyplňte aspoň jeden bod nebo poznámku.');
  await visit.getByTestId('visit-done-who').check();
  await expect(visit).not.toContainText('Vyplňte aspoň jeden bod nebo poznámku.');
  await visit.getByTestId('visit-text-who').fill('provozní manažerka');
  await visit.getByTestId('visit-done-box').check();
  await visit.getByTestId('visit-text-now').fill('jednorázové lahvičky od velkoobchodu');
  await visit.getByTestId('visit-done-objections').check();
  await visit.getByTestId('visit-text-objections').fill('cena');
  await expect(visit.getByTestId('visit-progress')).toHaveText('3/5 hotovo');
  await visit.getByTestId('visit-notes').fill('Ředitel chce porovnat náklady.');
  await noOverflow(page);
  await shot(page, 'sales-visit-dialog-390');
  await dialogSubmit(page, 'visit-dialog');

  const offer = page.getByTestId('next-step-offer');
  await expect(offer).toBeVisible();
  const detail = await json<ProspectDetail>(
    await page.request.get(`/api/admin/sales/prospects/${code}`),
  );
  const meetings = detail.activities.filter((x) => x.kind === 'MEETING');
  expect(meetings).toHaveLength(1);
  expect(meetings[0]!.content).toBe(
    [
      'S kým: provozní manažerka',
      'Prezentační krabička ukázána.',
      'Současná kosmetika: jednorázové lahvičky od velkoobchodu',
      'Námitky: cena',
      'Poznámky: Ředitel chce porovnat náklady.',
    ].join('\n'),
  );
  await expect(page.getByTestId('prospect-last-contact')).not.toContainText('zatím žádný');
  await shot(page, 'sales-visit-saved-390');

  // The offer leads to the ordinary task form.
  await page.getByTestId('next-step-plan').click();
  await page.getByTestId('task-dialog').getByTestId('task-title').fill('Poslat porovnání nákladů');
  await page.getByTestId('task-dialog').getByTestId('task-due').fill(pragueDay(2));
  await dialogSubmit(page, 'task-dialog');
  await expect(page.getByTestId('prospect-next')).toContainText('Poslat porovnání nákladů');
  await page.context().close();
});

test('a visit with its next task planned in the guide: no offer', async ({ browser }) => {
  const page = await signIn(browser, V.email);
  await page.setViewportSize({ width: 1280, height: 900 });
  // The open task of the previous visit is done first, so the prospect has no next step.
  const d = await json<ProspectDetail>(
    await page.request.get(`/api/admin/sales/prospects/${code}`),
  );
  for (const t of d.openTasks)
    await json(
      await page.request.post(`/api/admin/sales/tasks/${t.id}/done`, {
        data: { requestId: crypto.randomUUID(), revision: t.revision, result: null },
      }),
    );
  await page.goto(`/sales/prospects/${code}`);
  await page.getByTestId('start-visit').click();
  const visit = page.getByTestId('visit-dialog');
  await visit.getByTestId('visit-done-next').check();
  await visit.getByTestId('visit-notes').fill('Domluveno jednání o pilotu.');
  await visit.getByTestId('visit-follow-up').check();
  await visit.getByTestId('visit-follow-title').fill('Jednání o pilotu');
  await visit.getByTestId('visit-follow-due').fill(pragueDay(5));
  await dialogSubmit(page, 'visit-dialog');
  await expect(page.getByTestId('prospect-next')).toContainText('Jednání o pilotu');
  await expect(page.getByTestId('next-step-offer')).toHaveCount(0);
  await shot(page, 'sales-visit-1280');
  await page.context().close();
});
