import { expect, test, type Page } from '@playwright/test';
import type { ProspectDetail } from '@ayvo/types';
import { json, noOverflow } from './dispatch-setup';
import { pragueDay, prospect, shot, signIn } from './sales-setup';

test.describe.configure({ mode: 'serial' });

const tag = Date.now().toString(36).slice(-5).toUpperCase();
const V = { email: `e2e-navsteva-${tag}@ayvo.test`.toLowerCase(), name: 'Vera Obchodnice' };
const W = { email: `e2e-navsteva-w-${tag}@ayvo.test`.toLowerCase(), name: 'Waldemar Obchodník' };
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
  for (const u of [V, W])
    await json(
      await admin.request.post('/api/admin/identity/users', {
        data: {
          email: u.email,
          displayName: u.name,
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

test('a lost answer: the form locks, "Ověřit uložení" resends the same write — one Schůzka, one task (390 px)', async ({
  browser,
}) => {
  const page = await signIn(browser, V.email);
  await page.setViewportSize({ width: 390, height: 844 });
  const read = async () =>
    json<ProspectDetail>(await page.request.get(`/api/admin/sales/prospects/${code}`));
  const before = await read();
  const meetings = (d: ProspectDetail) => d.activities.filter((x) => x.kind === 'MEETING').length;
  const tasks = (d: ProspectDetail) => d.openTasks.filter((x) => x.title === `Pilot ${tag}`).length;
  await page.goto(`/sales/prospects/${code}`);
  await page.getByTestId('start-visit').click();
  const visit = page.getByTestId('visit-dialog');
  await visit.getByTestId('visit-done-who').check();
  await visit.getByTestId('visit-notes').fill('Ztracená odpověď.');
  await visit.getByTestId('visit-follow-up').check();
  await visit.getByTestId('visit-follow-title').fill(`Pilot ${tag}`);
  await visit.getByTestId('visit-follow-due').fill(pragueDay(3));
  // The first save reaches the server and is stored, but its answer never reaches the browser.
  const sent: { requestId: string; content: string }[] = [];
  let lost = false;
  await page.route(`**/api/admin/sales/prospects/${code}/activities`, async (route) => {
    if (route.request().method() !== 'POST') return route.continue();
    sent.push(route.request().postDataJSON() as { requestId: string; content: string });
    if (lost) return route.continue();
    lost = true;
    await route.fetch();
    await route.abort('connectionreset');
  });
  await visit.getByTestId('visit-dialog-submit').click();
  await expect(visit.getByTestId('visit-uncertain')).toBeVisible();
  // Locked: no edit of the visit before the original write is verified.
  await expect(visit.getByTestId('visit-notes')).toBeDisabled();
  await expect(visit.getByTestId('visit-notes')).toHaveValue('Ztracená odpověď.');
  await expect(visit.getByTestId('visit-dialog-submit')).toHaveText('Ověřit uložení');
  await noOverflow(page);
  await dialogSubmit(page, 'visit-dialog');
  const after = await read();
  expect(meetings(after)).toBe(meetings(before) + 1);
  expect(tasks(after)).toBe(tasks(before) + 1);
  expect(sent).toHaveLength(2);
  expect(sent[1]).toEqual(sent[0]); // the same request id and the same body
  await page.context().close();
});

test('a definite refusal leaves the visit editable to fix it', async ({ browser }) => {
  const page = await signIn(browser, V.email);
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto(`/sales/prospects/${code}`);
  await page.getByTestId('start-visit').click();
  const visit = page.getByTestId('visit-dialog');
  await visit.getByTestId('visit-done-box').check();
  let refused = false;
  await page.route(`**/api/admin/sales/prospects/${code}/activities`, async (route) => {
    if (refused || route.request().method() !== 'POST') return route.continue();
    refused = true;
    await route.fulfill({
      status: 422,
      contentType: 'application/json',
      body: JSON.stringify({ statusCode: 422, code: 'INVALID_TIME', message: 'Check the date' }),
    });
  });
  await visit.getByTestId('visit-dialog-submit').click();
  await expect.poll(() => refused).toBe(true);
  await expect(visit.getByTestId('visit-uncertain')).toHaveCount(0);
  await expect(visit.getByTestId('visit-notes')).toBeEnabled();
  await visit.getByTestId('visit-notes').fill('Opraveno.');
  await expect(visit.getByTestId('visit-dialog-submit')).toHaveText('Uložit návštěvu');
  await dialogSubmit(page, 'visit-dialog');
  await page.context().close();
});

test("another salesperson never opens the visit on someone else's prospect", async ({
  browser,
}) => {
  const page = await signIn(browser, W.email);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`/sales/prospects/${code}`);
  await expect(page.getByTestId('start-visit')).toHaveCount(0);
  const res = await page.request.post(`/api/admin/sales/prospects/${code}/activities`, {
    data: {
      requestId: crypto.randomUUID(),
      kind: 'MEETING',
      occurredAt: `${pragueDay(-1)}T09:00`,
      contactId: null,
      content: 'cizí návštěva',
      outcome: null,
      followUp: null,
    },
  });
  expect(res.status()).toBe(404);
  await page.context().close();
});
