import { expect, test } from '@playwright/test';
import type { ProspectDetail } from '@ayvo/types';
import { json, noOverflow } from './dispatch-setup';
import { e2eSql } from './e2e-db';
import { pragueDay, prospect, shot, signIn } from './sales-setup';

test.describe.configure({ mode: 'serial' });

const tag = Date.now().toString(36).slice(-5).toUpperCase();
const F = { email: `e2e-kalendar-${tag}@ayvo.test`.toLowerCase(), name: 'Filip Obchodník' };
const task = (title: string, dueOn: string) => ({
  requestId: crypto.randomUUID(),
  title,
  dueOn,
  contactId: null,
  assigneeId: null,
  note: null,
});

/**
 * Kalendář (Obchod): a salesperson sees their tasks by day — today's, tomorrow's and an overdue
 * one marked so (or counted, when it fell in the previous month) — moves between months, opens a
 * task's prospect; at 390 px the days with tasks are a list without sideways scrolling.
 */
test.beforeAll(async ({ browser }) => {
  const admin = await browser.newContext({ storageState: 'e2e/.auth/admin.json' });
  await json(
    await admin.request.post('/api/admin/identity/users', {
      data: {
        email: F.email,
        displayName: F.name,
        roles: ['SALES'],
        siteIds: [],
        warehouseCodes: [],
        reason: 'obchodník (E2E kalendář)',
      },
    }),
  );
  await admin.close();
  const f = await signIn(browser, F.email);
  const p = await json<ProspectDetail>(
    await f.request.post('/api/admin/sales/prospects', {
      data: prospect(`Hotel Kalendář ${tag}`, { city: 'Brno' }),
    }),
  );
  for (const [title, day] of [
    ['Zavolat řediteli', pragueDay(0)],
    ['Poslat vzorky', pragueDay(1)],
    ['Připomenout nabídku', pragueDay(0)],
  ] as const)
    await json(
      await f.request.post(`/api/admin/sales/prospects/${p.code}/tasks`, {
        data: task(title, day),
      }),
    );
  // Test-only: one task was due two days ago (a past due date cannot be entered).
  const detail = await json<ProspectDetail>(
    await f.request.get(`/api/admin/sales/prospects/${p.code}`),
  );
  const late = detail.openTasks.find((x) => x.title === 'Připomenout nabídku')!;
  await e2eSql([
    `UPDATE "sales_tasks" SET "due_on" = DATE '${pragueDay(-2)}', "revision" = "revision" + 1 WHERE "id" = '${late.id}'`,
  ]);
  await f.context().close();
});

test('the month grid: tasks by day, overdue marked, months, a task opens its prospect', async ({
  browser,
}) => {
  const page = await signIn(browser, F.email);
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto('/sales');
  await page
    .getByRole('navigation', { name: 'Obchod' })
    .getByRole('link', { name: 'Kalendář' })
    .click();
  await expect(page.getByRole('heading', { level: 1, name: 'Kalendář' })).toBeVisible();
  const today = pragueDay(0);
  const grid = page.getByTestId('calendar-grid');
  await expect(grid.getByTestId(`calendar-day-${today}`)).toContainText('Zavolat řediteli');
  await expect(grid.getByTestId(`calendar-day-${today}`)).toContainText(`Hotel Kalendář ${tag}`);
  const tomorrow = pragueDay(1);
  if (tomorrow.slice(0, 7) === today.slice(0, 7))
    await expect(grid.getByTestId(`calendar-day-${tomorrow}`)).toContainText('Poslat vzorky');
  const before = pragueDay(-2);
  if (before.slice(0, 7) === today.slice(0, 7)) {
    await expect(grid.getByTestId(`calendar-day-${before}`)).toContainText('Po termínu');
  } else {
    await expect(page.getByText('po termínu z dřívějška')).toBeVisible();
  }
  await noOverflow(page);
  await shot(page, 'sales-calendar-1280');

  // The next month and back ("Dnes").
  await page.getByRole('link', { name: 'Další měsíc' }).click();
  await expect(page).toHaveURL(/month=\d{4}-\d{2}/);
  await expect(grid.getByTestId(`calendar-day-${today}`)).toHaveCount(0);
  await page.getByRole('link', { name: 'Dnes' }).click();
  await expect(grid.getByTestId(`calendar-day-${today}`)).toContainText('Zavolat řediteli');

  await grid.getByRole('link', { name: /Zavolat řediteli/ }).click();
  await expect(page.getByRole('heading', { level: 1 })).toContainText(`Hotel Kalendář ${tag}`);
  await page.context().close();
});

test('390 px: the days with tasks as a list, no sideways scrolling', async ({ browser }) => {
  const page = await signIn(browser, F.email);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/sales/calendar');
  const agenda = page.getByTestId('calendar-agenda');
  await expect(agenda.getByTestId(`agenda-day-${pragueDay(0)}`)).toContainText('Zavolat řediteli');
  await expect(agenda.getByTestId(`agenda-day-${pragueDay(0)}`)).toContainText('Dnes');
  await expect(page.getByTestId('calendar-grid')).toBeHidden();
  await noOverflow(page);
  await shot(page, 'sales-calendar-390');
  await page.context().close();
});
