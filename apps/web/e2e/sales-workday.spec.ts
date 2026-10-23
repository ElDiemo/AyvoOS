import { readFileSync } from 'node:fs';
import { expect, test, type Page } from '@playwright/test';
import type { ProspectDetail } from '@ayvo/types';
import { json, noOverflow } from './dispatch-setup';
import { e2eSql } from './e2e-db';
import { pragueDay, prospect, shot, signIn } from './sales-setup';

/**
 * A salesperson's working day in Obchod (doc 034) with a SALES-only account and no site, in the
 * real built app: the overview with today's and overdue tasks, a new prospect with several
 * contacts, yesterday's call with the next step, editing and completing tasks, a stage change,
 * archive and restore, a CSV import of a table like the ones kept today (with errors, a duplicate
 * and Czech accents) and the CSV export — on a computer and at 390 / 320 px. A second
 * salesperson and ADMIN check what they may see. Synthetic data only.
 */
test.describe.configure({ mode: 'serial' });

const tag = Date.now().toString(36).slice(-5).toUpperCase();
const D = { email: `e2e-obchod-d-${tag}@ayvo.test`.toLowerCase(), name: 'Dana Obchodnice' };
const E = { email: `e2e-obchod-e-${tag}@ayvo.test`.toLowerCase(), name: 'Emil Obchodník' };
let importUrl = '';
let importedCode = '';

const task = (title: string, dueOn: string) => ({
  requestId: crypto.randomUUID(),
  title,
  dueOn,
  contactId: null,
  assigneeId: null,
  note: null,
});

test.beforeAll(async ({ browser }) => {
  const admin = await browser.newContext({ storageState: 'e2e/.auth/admin.json' });
  for (const u of [D, E]) {
    await json(
      await admin.request.post('/api/admin/identity/users', {
        data: {
          email: u.email,
          displayName: u.name,
          roles: ['SALES'],
          siteIds: [],
          warehouseCodes: [],
          reason: 'obchodník (E2E)',
        },
      }),
    );
  }
  await admin.close();
  // The morning: one task for today, one left over from an earlier day.
  const d = await signIn(browser, D.email);
  const morning = await json<ProspectDetail>(
    await d.request.post('/api/admin/sales/prospects', {
      data: prospect(`Hotel Ranní ${tag}`, { city: 'Olomouc' }),
    }),
  );
  await json(
    await d.request.post(`/api/admin/sales/prospects/${morning.code}/tasks`, {
      data: task('Zavolat recepci kvůli vzorkům', pragueDay(0)),
    }),
  );
  const late = await json<ProspectDetail>(
    await d.request.post('/api/admin/sales/prospects', {
      data: prospect(`Penzion Opožděný ${tag}`, { city: 'Jihlava' }),
    }),
  );
  const t = await json<ProspectDetail>(
    await d.request.post(`/api/admin/sales/prospects/${late.code}/tasks`, {
      data: task('Poslat ceník', pragueDay(0)),
    }),
  );
  // Test-only: the task was due two days ago (a due date in the past cannot be entered).
  await e2eSql([
    `UPDATE "sales_tasks" SET "due_on" = DATE '${pragueDay(-2)}', "revision" = "revision" + 1 WHERE "id" = '${t.openTasks[0]!.id}'`,
  ]);
  await d.context().close();
});

async function dialogSubmit(page: Page, id: string) {
  await page.getByTestId(`${id}-submit`).click();
  await expect(page.getByTestId(id)).toBeHidden();
}

test("a salesperson's day: overview, new prospect, contacts, call, tasks, stage, archive", async ({
  browser,
}) => {
  const page = await signIn(browser, D.email);
  await page.setViewportSize({ width: 1280, height: 900 });
  // The home page offers Obchod only; no site is asked for.
  await expect(page.getByTestId('module-sales')).toBeVisible();
  await expect(page.getByTestId('choose-site')).toHaveCount(0);
  await page
    .getByRole('navigation', { name: 'Hlavní navigace' })
    .getByRole('link', { name: 'Obchod' })
    .click();
  await expect(page.getByTestId('count-overdue')).toHaveText('1');
  await expect(page.getByTestId('count-today')).toHaveText('1');
  await expect(page.getByTestId('overview-overdue')).toContainText('Poslat ceník');
  await expect(page.getByTestId('overview-overdue')).toContainText(`Penzion Opožděný ${tag}`);
  await expect(page.getByTestId('overview-today')).toContainText('Zavolat recepci kvůli vzorkům');

  // The overdue task: edited and completed from the overview's prospect.
  await page
    .getByTestId('overview-overdue')
    .getByRole('link', { name: `Penzion Opožděný ${tag}` })
    .click();
  const late = page.getByTestId('open-task-list').getByTestId('task-Poslat ceník');
  await expect(late.getByTestId('task-due-label')).toContainText('po termínu');
  await late.getByTestId('task-edit').click();
  await page.getByTestId('task-edit-title').fill('Poslat ceník a nabídku vzorků');
  await dialogSubmit(page, 'task-edit-dialog');
  const edited = page.getByTestId('task-Poslat ceník a nabídku vzorků');
  await edited.getByTestId('task-done').click();
  await page.getByTestId('task-action-text').fill('Ceník odeslán e-mailem');
  await dialogSubmit(page, 'task-action-dialog');
  await expect(page.getByTestId('open-tasks')).toContainText('Žádný otevřený úkol');
  await expect(page.getByTestId('prospect-stage')).toHaveText('Nový');

  // A new prospect with two contacts, yesterday's call with the next step, then a stage change.
  await page.goto('/sales/prospects/new');
  await page.getByLabel('Název hotelu nebo penzionu').fill(`Hotel Nový Den ${tag}`);
  await page.getByLabel('Země').fill('CZ');
  await page.getByLabel('Město').fill('Kroměříž');
  await page.getByLabel('Jméno nebo označení').fill('Recepce');
  await page.getByLabel('Telefon').fill('+420 573 000 111');
  await page.getByTestId('prospect-submit').click();
  await page.waitForURL(/\/sales\/prospects\/AKV-\d{6}\?created=1$/);
  const code = page.url().match(/AKV-\d{6}/)![0];
  await page.getByTestId('add-contact').click();
  const contact = page.getByTestId('contact-dialog');
  await contact.getByTestId('contact-label').fill('Ing. Petr Dvořák');
  await contact.getByTestId('contact-position').fill('Provozní');
  await contact.getByTestId('contact-email').fill(`provozni-${tag}@novyden.example`);
  await dialogSubmit(page, 'contact-dialog');
  await expect(page.getByTestId('contact-Ing. Petr Dvořák')).toBeVisible();
  await page.getByTestId('record-activity').click();
  const activity = page.getByTestId('activity-dialog');
  await activity.getByTestId('activity-at').fill(`${pragueDay(-1)}T16:10`);
  await activity.getByTestId('activity-contact').selectOption({ label: 'Ing. Petr Dvořák' });
  await activity
    .getByTestId('activity-content')
    .fill('Telefonát s provozním, chtějí vzorky do pokojů.');
  await activity.getByTestId('activity-follow-up').check();
  await activity.getByTestId('follow-up-title').fill('Doručit vzorky');
  await activity.getByTestId('follow-up-due').fill(pragueDay(2));
  await dialogSubmit(page, 'activity-dialog');
  await expect(page.getByTestId('prospect-last-contact')).toContainText('16:10');
  await expect(page.getByTestId('prospect-next')).toContainText('Doručit vzorky');
  await page.getByTestId('change-stage').click();
  await page.getByTestId('stage-select').selectOption({ label: 'Oslovený' });
  await dialogSubmit(page, 'stage-dialog');
  await expect(page.getByTestId('prospect-stage')).toHaveText('Oslovený');

  // Found again by a contact's phone, from the list.
  await page.goto(`/sales/prospects?q=${encodeURIComponent('573 000 111')}`);
  await expect(page.getByTestId('prospect-total')).toHaveText('1 zájemce');
  await expect(page.getByTestId(`prospect-${code}`)).toContainText('Doručit vzorky');

  // The morning prospect: today's task completed, then archived and restored.
  await page.goto(`/sales/prospects?q=${encodeURIComponent(`Ranní ${tag}`)}`);
  await page
    .getByRole('link', { name: `Hotel Ranní ${tag}` })
    .first()
    .click();
  await page.getByTestId('task-Zavolat recepci kvůli vzorkům').getByTestId('task-done').click();
  await dialogSubmit(page, 'task-action-dialog');
  await page.getByTestId('archive-prospect').click();
  await page.getByTestId('archive-reason').fill('Hotel je v rekonstrukci do jara');
  await dialogSubmit(page, 'archive-dialog');
  await expect(page.getByTestId('prospect-archived')).toContainText('rekonstrukci');
  await page.getByTestId('restore-prospect').click();
  await dialogSubmit(page, 'restore-dialog');
  await expect(page.getByTestId('prospect-actions')).toBeVisible();
  await page.context().close();
});

const CSV =
  '\uFEFFNázev hotelu;Země;Město;Kontaktní osoba;E-mail;Telefon;Pokoje;Poznámka;Stav;Výsledek;Interní\r\n' +
  `"Hotel ""Zlatý Jelen"" ${tag}";CZ;Telč;Ing. Jana Malá;jana-${tag}@jelen.example;+420 777 100 200;42;"Má zájem.\r\nVolat dopoledne.";Osloveno;Zájem;x\r\n` +
  `Penzion Žluťoučký kůň ${tag};SK;Bratislava;;recepce-${tag}@kun.example;00421 2 123 456;;;;;\r\n` +
  `Hotel Bez Země ${tag};;Brno;Recepce;;;12;;;;\r\n` +
  `Hotel Nový Den ${tag};CZ;Kroměříž;;;;;;;;\r\n` +
  `Hotel Chybný ${tag};CZ;Kdesi;Petr;neni-email;4,20777E+11;cca 40;;;;\r\n`;

test('imports a table: columns, preview with errors and a duplicate, confirmation, result', async ({
  browser,
}) => {
  const page = await signIn(browser, D.email);
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto('/sales/prospects');
  await page.getByTestId('import-prospects').click();
  await page.waitForURL('**/sales/prospects/import');
  await page.getByTestId('import-file-input').setInputFiles({
    name: 'zajemci.csv',
    mimeType: 'text/csv',
    buffer: Buffer.from(CSV, 'utf8'),
  });
  await page.getByTestId('import-read').click();
  await expect(page.getByTestId('import-file-info')).toContainText('5 řádků');
  await expect(page.getByTestId('import-file-info')).toContainText('středník');
  // The proposal: known columns mapped, old status columns kept as original values only.
  await expect(page.getByTestId('map-select-0')).toHaveValue('name');
  await expect(page.getByTestId('map-select-8')).toHaveValue('original');
  await expect(page.getByTestId('map-select-9')).toHaveValue('original');
  await expect(page.getByTestId('map-select-10')).toHaveValue('ignore');
  await page.getByTestId('import-default-label').fill('Recepce');
  await page.getByTestId('import-check').click();

  await expect(page.getByTestId('import-counts')).toHaveText(
    '5 řádků · 3 v pořádku · 2 s chybou · 1 možných duplicit',
  );
  const row = (n: number) => page.getByTestId(`import-row-${n}`);
  await expect(row(2)).toContainText('Hotel "Zlatý Jelen"');
  await expect(row(2)).toContainText('+420 777 100 200');
  await expect(row(3)).toContainText('00421 2 123 456');
  await expect(row(4).getByTestId('import-row-errors')).toContainText('Chybí země.');
  await expect(row(6).getByTestId('import-row-errors')).toContainText('Neplatný e-mail.');
  await expect(row(6).getByTestId('import-row-errors')).toContainText('„4,20777E+11“');
  await expect(row(6).getByTestId('import-include')).toBeDisabled();
  // The duplicate of the salesperson's own prospect: a link, excluded until confirmed.
  await expect(row(5).getByTestId('import-row-duplicates')).toContainText(`Hotel Nový Den ${tag}`);
  await expect(row(5).getByTestId('import-include')).not.toBeChecked();
  // Fix a missing country in the preview; nothing has been written yet.
  await row(4).getByTestId('import-fix-country').fill('cz');
  // A typed fix is not confirmed unchecked: the import waits for the check.
  await expect(page.getByTestId('import-fixes-pending')).toBeVisible();
  await expect(page.getByTestId('import-confirm')).toBeDisabled();
  await page.getByTestId('import-recheck').click();
  await expect(page.getByTestId('import-fixes-pending')).toHaveCount(0);
  await expect(page.getByTestId('import-counts')).toHaveText(
    '5 řádků · 4 v pořádku · 1 s chybou · 1 možných duplicit',
  );
  await expect(row(4).getByTestId('import-include')).toBeChecked();
  const before = await json<{ total: number }>(
    await page.request.get(`/api/admin/sales/prospects?q=${encodeURIComponent(tag)}`),
  );
  expect(before.total).toBe(3);
  await page.getByTestId('import-show-problems').click();
  await expect(
    page.getByTestId('import-rows').locator('li[data-testid^="import-row-"]'),
  ).toHaveCount(2);
  await page.getByTestId('import-show-all').click();
  for (const width of [390, 320]) {
    await page.setViewportSize({ width, height: 900 });
    await expect(row(2)).toBeVisible();
    await expect(page.getByTestId('import-confirm')).toBeVisible();
    await noOverflow(page);
    await shot(page, `sales-06-import-preview-${width}`);
  }
  await page.setViewportSize({ width: 1280, height: 900 });
  await shot(page, 'sales-06-import-preview-desktop');

  await expect(page.getByTestId('import-selected')).toHaveText('Vybráno 3 z 5 řádků');
  // The server says the file changed since the preview (saved again in Excel): nothing is
  // imported, the preview is loaded again and the user confirms anew.
  let refused = 0;
  await page.route('**/api/admin/sales/imports', async (route) => {
    if (refused++) return route.fallback();
    await route.fulfill({
      status: 409,
      json: { statusCode: 409, code: 'IMPORT_PREVIEW_STALE', message: 'changed' },
    });
  });
  await page.getByTestId('import-confirm').click();
  await page
    .getByTestId('import-confirm-dialog')
    .getByRole('button', { name: 'Importovat 3 zájemce' })
    .click();
  await expect(page.getByTestId('import-error')).toContainText('od náhledu změnily');
  await expect(page.getByTestId('import-counts')).toHaveText(
    '5 řádků · 4 v pořádku · 1 s chybou · 1 možných duplicit',
  );
  await page.unroute('**/api/admin/sales/imports');
  expect(
    (
      await json<{ total: number }>(
        await page.request.get(`/api/admin/sales/prospects?q=${encodeURIComponent(tag)}`),
      )
    ).total,
  ).toBe(3);
  await expect(page.getByTestId('import-selected')).toHaveText('Vybráno 3 z 5 řádků');
  await page.getByTestId('import-confirm').click();
  const confirm = page.getByTestId('import-confirm-dialog');
  await expect(confirm).toContainText('Vytvoří se 3 nových zájemců ve fázi Nový');
  await confirm.getByRole('button', { name: 'Importovat 3 zájemce' }).dblclick();
  await page.waitForURL(/\/sales\/prospects\/import\/IMP-\d{6}$/);
  importUrl = new URL(page.url()).pathname;
  await expect(page.getByTestId('import-result-summary')).toHaveText(
    `Založeno 3 z 5 řádků · obchodník ${D.name}`,
  );
  // Found again after a reload; the skipped rows with their reasons.
  await page.reload();
  await expect(page.getByTestId('import-created')).toContainText('Hotel "Zlatý Jelen"');
  await expect(page.getByTestId('import-skipped')).toContainText('Řádek 5');
  await expect(page.getByTestId('import-skipped')).toContainText('vynecháno');
  await expect(page.getByTestId('import-skipped')).toContainText('Neplatný telefon');
  for (const width of [390, 320]) {
    await page.setViewportSize({ width, height: 900 });
    await noOverflow(page);
    await shot(page, `sales-07-import-result-${width}`);
  }
  await page.setViewportSize({ width: 1280, height: 900 });
  await shot(page, 'sales-07-import-result-desktop');
  // A double click imported once.
  const after = await json<{ total: number }>(
    await page.request.get(`/api/admin/sales/prospects?q=${encodeURIComponent(tag)}`),
  );
  expect(after.total).toBe(6);
  await page
    .getByTestId('import-created')
    .getByRole('link', { name: /Zlatý Jelen/ })
    .click();
  await page.waitForURL(/\/sales\/prospects\/AKV-\d{6}$/);
  importedCode = page.url().match(/AKV-\d{6}/)![0];
  await expect(page.getByTestId('prospect-stage')).toHaveText('Nový');
  await expect(page.getByTestId('contact-Ing. Jana Malá')).toContainText('+420 777 100 200');
  await expect(page.getByTestId('prospect-profile')).toContainText('Stav: Osloveno');
  // No invented call, e-mail or task from the old status columns.
  await expect(page.getByTestId('history')).toContainText('Zatím nic');
  await expect(page.getByTestId('open-tasks')).toContainText('Žádný otevřený úkol');
  await page.context().close();
});

test('exports the filtered list; another salesperson sees nothing of it; ADMIN does', async ({
  browser,
}) => {
  const page = await signIn(browser, D.email);
  await page.goto(`/sales/prospects?q=${encodeURIComponent(tag)}`);
  await expect(page.getByTestId('prospect-total')).toHaveText('6 zájemců');
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.getByTestId('export-prospects').click(),
  ]);
  expect(download.suggestedFilename()).toMatch(/^zajemci-\d{4}-\d{2}-\d{2}\.csv$/);
  const text = readFileSync((await download.path())!, 'utf8');
  expect(text.startsWith('\uFEFFKód;Název;')).toBe(true);
  // One record per prospect (a multi-line note stays inside its quoted cell).
  expect(text.match(/\r\nAKV-\d{6};/g)).toHaveLength(6);
  expect(text).toContain('"Má zájem.\r\nVolat dopoledne.');
  expect(text).toContain(";'+420 777 100 200;");
  expect(text).toContain('Hotel Nový Den');
  await page.context().close();

  const e = await signIn(browser, E.email);
  await e.goto(importUrl);
  await expect(e.getByRole('heading', { name: 'Stránka nenalezena' })).toBeVisible();
  await e.goto(`/sales/prospects/${importedCode}`);
  await expect(e.getByRole('heading', { name: 'Stránka nenalezena' })).toBeVisible();
  await e.goto(`/sales/prospects?q=${encodeURIComponent(tag)}`);
  await expect(e.getByTestId('prospect-total')).toHaveText('0 zájemců');
  const res = await e.request.get(`/api/admin/sales/prospects/export?q=${encodeURIComponent(tag)}`);
  expect((await res.text()).trim().split('\r\n')).toHaveLength(1);
  await e.context().close();

  const admin = await browser.newContext({ storageState: 'e2e/.auth/admin.json' });
  const a = await admin.newPage();
  await a.goto(importUrl);
  await expect(a.getByTestId('import-result-summary')).toContainText(D.name);
  await admin.close();
});
