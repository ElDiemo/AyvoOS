import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test, type Browser, type Page } from '@playwright/test';
import { json, noOverflow } from './dispatch-setup';

/**
 * Obchod — hotel acquisition (doc 034) in the real built app with two SALES-only salespeople
 * signed in through the real flow (no site), synthetic data only: quick creation, contacts,
 * yesterday's call with a follow-up, task completion, stages, reopening, corrections, concurrent
 * edits, another salesperson's prospects, ADMIN's assignment, paging and the phone layouts.
 * Screenshots (AYVO_SCREENSHOT_DIR) only after the real content has loaded.
 */
test.describe.configure({ mode: 'serial' });

const SHOTS = process.env.AYVO_SCREENSHOT_DIR;
const tag = Date.now().toString(36).slice(-5).toUpperCase();
const A = { email: `e2e-obchod-a-${tag}@ayvo.test`.toLowerCase(), name: 'Adam Obchodník' };
const B = { email: `e2e-obchod-b-${tag}@ayvo.test`.toLowerCase(), name: 'Bára Obchodnice' };
let prospectCode = '';

function pragueDay(offset = 0): string {
  const d = new Date(Date.now() + offset * 86_400_000);
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Prague' }).format(d);
}

async function shot(page: Page, name: string) {
  if (!SHOTS) return;
  mkdirSync(SHOTS, { recursive: true });
  await expect(page.locator('.animate-pulse')).toHaveCount(0);
  const size = page.viewportSize()!;
  const height = await page.evaluate(() => document.documentElement.scrollHeight);
  await page.setViewportSize({ width: size.width, height: Math.min(height, 4000) });
  await page.screenshot({ path: join(SHOTS, `${name}.png`) });
  await page.setViewportSize(size);
}

async function signIn(browser: Browser, email: string) {
  const context = await browser.newContext({ timezoneId: 'America/New_York' });
  const page = await context.newPage();
  await page.goto(`/api/auth/login?next=/&login_hint=${encodeURIComponent(email)}`);
  await page.waitForURL((u) => u.pathname === '/');
  return page;
}

const prospect = (name: string, extra: object = {}) => ({
  requestId: crypto.randomUUID(),
  name,
  countryCode: 'CZ',
  city: null,
  addressLine1: null,
  addressLine2: null,
  postalCode: null,
  roomsEstimate: null,
  accommodationType: null,
  website: null,
  source: null,
  priority: null,
  note: null,
  ownerId: null,
  contact: null,
  acknowledgeDuplicates: true,
  ...extra,
});

test.beforeAll(async ({ browser }) => {
  const admin = await browser.newContext({ storageState: 'e2e/.auth/admin.json' });
  for (const u of [A, B]) {
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
  // A larger synthetic list of salesperson A (paging, search).
  const a = await signIn(browser, A.email);
  for (let i = 0; i < 32; i++) {
    await json(
      await a.request.post('/api/admin/sales/prospects', {
        data: prospect(`Syntetický hotel ${tag} ${String(i).padStart(2, '0')}`, {
          city: i % 2 ? 'Zlín' : 'Opava',
          priority: (['A', 'B', 'C'] as const)[i % 3],
          roomsEstimate: 20 + i,
        }),
      }),
    );
  }
  await a.context().close();
});

test('a SALES-only account signs in to the overview with Obchod only — no site, no warehouse', async ({
  browser,
}) => {
  const page = await signIn(browser, A.email);
  const nav = page.getByRole('navigation', { name: 'Hlavní navigace' });
  await expect(nav.getByRole('link')).toHaveText(['Přehled', 'Obchod']);
  await expect(page.getByTestId('module-sales')).toBeVisible();
  await expect(page.getByTestId('choose-site')).toHaveCount(0);
  await nav.getByRole('link', { name: 'Obchod' }).click();
  await expect(page).toHaveURL(/\/sales$/);
  await expect(page.getByRole('heading', { name: 'Přehled obchodu' })).toBeVisible();
  for (const path of [
    '/warehouse',
    '/warehouse/availability',
    '/production',
    '/dispatch',
    '/admin/users',
  ]) {
    await page.goto(path);
    await expect(page, path).toHaveURL(/\/forbidden$/);
  }
  await page.context().close();
});

test('new prospect → contact → yesterday’s call with a follow-up → done → offer → won → reopened', async ({
  browser,
}) => {
  const page = await signIn(browser, A.email);
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto('/sales/prospects');
  await page.getByTestId('new-prospect').click();
  await page.waitForURL('**/sales/prospects/new');
  // Quick creation: a name, a country and the reception as the first contact (no person known).
  await page.getByLabel('Název hotelu nebo penzionu').fill(`Penzion U Lípy ${tag}`);
  await page.getByLabel('Země').fill('at');
  await page.getByLabel('Město').fill('Salzburg');
  await page.getByLabel('Jméno nebo označení').fill('Recepce');
  await page.getByLabel('Telefon').fill('+43 (0)662 123 456');
  await page.getByLabel('Počet pokojů (odhad)').fill('');
  await page.getByTestId('prospect-submit').dblclick();
  await page.waitForURL(/\/sales\/prospects\/AKV-\d{6}\?created=1$/);
  prospectCode = page.url().match(/AKV-\d{6}/)![0];
  await expect(page.getByTestId('prospect-stage')).toHaveText('Nový');
  await expect(page.getByTestId('prospect-owner')).toHaveText(A.name);
  await expect(page.getByTestId('prospect-next')).toContainText('Žádný naplánovaný krok');
  await expect(page.getByTestId('prospect-profile')).toContainText('neznámý');
  // A double click created one prospect.
  const list = await json<{ total: number }>(
    await page.request.get(`/api/admin/sales/prospects?q=${encodeURIComponent(`U Lípy ${tag}`)}`),
  );
  expect(list.total).toBe(1);

  // Yesterday's call (Europe/Prague, whatever the device's zone) with the next step.
  await page.getByTestId('record-activity').click();
  const dialog = page.getByTestId('activity-dialog');
  await dialog.getByTestId('activity-at').fill(`${pragueDay(-1)}T14:30`);
  await dialog.getByTestId('activity-contact').selectOption({ label: 'Recepce' });
  await dialog
    .getByTestId('activity-content')
    .fill('Volal jsem provoznímu, má zájem o vzorky. Rozhoduje ředitelka.');
  await dialog.getByTestId('activity-outcome').fill('Domluveno zavolat v pátek.');
  await dialog.getByTestId('activity-follow-up').check();
  await dialog.getByTestId('follow-up-title').fill('Zavolat ředitelce');
  await dialog.getByTestId('follow-up-due').fill(pragueDay(3));
  await dialog.getByTestId('activity-dialog-submit').click();
  await expect(dialog).toBeHidden();
  const timeline = page.getByTestId('timeline');
  await expect(timeline.getByTestId('timeline-activity').first()).toContainText('Telefonát');
  await expect(timeline.getByTestId('timeline-activity').first()).toContainText('14:30');
  await expect(timeline).toContainText('Domluveno zavolat v pátek.');
  await expect(page.getByTestId('prospect-next')).toContainText('Zavolat ředitelce');
  await expect(page.getByTestId('prospect-stage')).toHaveText('Nový');

  // A second contact, the new main one; a second task.
  await page.getByTestId('add-contact').click();
  const contact = page.getByTestId('contact-dialog');
  await contact.getByTestId('contact-label').fill('Ing. Jana Nováková');
  await contact.getByTestId('contact-position').fill('Ředitelka');
  await contact.getByTestId('contact-email').fill(`reditelka-${tag}@lipa.example`);
  await contact.getByLabel('Hlavní kontakt').check();
  await contact.getByTestId('contact-dialog-submit').click();
  await expect(contact).toBeHidden();
  await expect(page.getByTestId('contact-Ing. Jana Nováková')).toContainText('hlavní');
  await expect(page.getByTestId('contact-Recepce')).not.toContainText('hlavní');
  await page.getByTestId('add-task').click();
  const task = page.getByTestId('task-dialog');
  await task.getByTestId('task-title').fill('Poslat vzorky');
  await task.getByTestId('task-due').fill(pragueDay(5));
  await task.getByTestId('task-dialog-submit').click();
  await expect(task).toBeHidden();
  const open = page.getByTestId('open-task-list');
  await expect(open.getByTestId('task-Poslat vzorky')).toHaveCount(1);

  // Completing the follow-up does not change the stage.
  await open.getByTestId('task-Zavolat ředitelce').getByTestId('task-done').click();
  await page.getByTestId('task-action-text').fill('Ředitelka chce nabídku na 24 pokojů');
  await page.getByTestId('task-action-dialog-submit').click();
  await expect(open.getByTestId('task-Zavolat ředitelce')).toHaveCount(0);
  await expect(page.getByTestId('prospect-stage')).toHaveText('Nový');
  await expect(page.getByTestId('prospect-next')).toContainText('Poslat vzorky');

  // Offer → won; then reopened with a reason.
  for (const stage of ['Nabídka', 'Získaný']) {
    await page.getByTestId('change-stage').click();
    await page.getByTestId('stage-select').selectOption({ label: stage });
    await page.getByTestId('stage-dialog-submit').click();
    await expect(page.getByTestId('prospect-stage')).toHaveText(stage);
  }
  await page.getByTestId('change-stage').click();
  await page.getByTestId('stage-select').selectOption({ label: 'Jednání' });
  await page.getByTestId('stage-dialog-submit').click();
  await expect(page.getByTestId('stage-dialog-error')).toContainText('uveďte důvod');
  await page.getByTestId('stage-reason').fill('Ředitelka chce ještě jednat o ceně');
  await page.getByTestId('stage-dialog-submit').click();
  await expect(page.getByTestId('prospect-stage')).toHaveText('Jednání');
  await expect(timeline.getByTestId('timeline-event').first()).toContainText(
    'Získaný → Jednání · Důvod: Ředitelka chce ještě jednat o ceně',
  );
  // A stage change never shows up as a call or an e-mail.
  await expect(timeline.getByTestId('timeline-activity')).toHaveCount(1);

  // A correction keeps the original visible.
  await timeline.getByTestId('activity-correct').first().click();
  const correct = page.getByTestId('correct-dialog');
  await correct.getByLabel('Výsledek').fill('Domluveno zavolat ve čtvrtek.');
  await correct.getByTestId('correct-reason').fill('Špatně zapsaný den');
  await correct.getByTestId('correct-dialog-submit').click();
  await expect(correct).toBeHidden();
  await expect(timeline).toContainText('Domluveno zavolat ve čtvrtek.');
  await expect(timeline).toContainText('Opraveno: Špatně zapsaný den');
  await timeline.getByText('Původní verze').click();
  await expect(timeline).toContainText('Volal jsem provoznímu');
  await page.getByTestId('history-all').click();
  await expect(page.getByTestId('all-changes')).toContainText('Kontakt přidán');
  await expect(page.getByTestId('all-changes')).toContainText('Úkol dokončen');
  await page.getByTestId('history-timeline').click();
  await shot(page, 'sales-03-detail-desktop');
  await page.setViewportSize({ width: 390, height: 844 });
  await noOverflow(page);
  await shot(page, 'sales-03-detail-390');
  await page.setViewportSize({ width: 320, height: 700 });
  await noOverflow(page);
  await shot(page, 'sales-03-detail-320');
  await page.context().close();
});

test('two edits of the same prospect: the second is refused and keeps its input', async ({
  browser,
}) => {
  const one = await signIn(browser, A.email);
  const two = await one.context().newPage();
  for (const p of [one, two]) await p.goto(`/sales/prospects/${prospectCode}/edit`);
  await one.getByLabel('Město').fill('Salzburg-Stadt');
  await one.getByTestId('prospect-submit').click();
  await one.waitForURL(`**/sales/prospects/${prospectCode}?saved=1`);
  await two.getByLabel('Zdroj kontaktu').fill('Veletrh Hotel 2026');
  await two.getByTestId('prospect-submit').click();
  await expect(two.getByTestId('form-errors')).toContainText('Mezitím zájemce upravil někdo jiný');
  await expect(two.getByLabel('Zdroj kontaktu')).toHaveValue('Veletrh Hotel 2026');
  await expect(two).toHaveURL(/\/edit$/);
  await one.context().close();
});

test("another salesperson never sees A's prospect; the duplicate warning names nothing; ADMIN reassigns", async ({
  browser,
}) => {
  const b = await signIn(browser, B.email);
  await b.goto(`/sales/prospects/${prospectCode}`);
  await expect(b.getByRole('heading', { name: 'Stránka nenalezena' })).toBeVisible();
  await expect(b.locator('body')).not.toContainText('Recepce');
  expect((await b.request.get(`/api/admin/sales/prospects/${prospectCode}`)).status()).toBe(404);
  await b.goto(`/sales/prospects?q=${encodeURIComponent(`U Lípy ${tag}`)}`);
  await expect(b.getByTestId('prospect-total')).toHaveText('0 zájemců');
  // Creating the same hotel: a warning without names or contacts, then "Přesto založit".
  await b.goto('/sales/prospects/new');
  await b.getByLabel('Název hotelu nebo penzionu').fill(`Hotel U Lípy ${tag}`);
  await b.getByLabel('Země').fill('AT');
  await b.getByTestId('prospect-submit').click();
  const warning = b.getByTestId('duplicate-warning');
  await expect(warning).toContainText('patří jinému obchodníkovi');
  await expect(warning).not.toContainText('Recepce');
  await expect(warning).not.toContainText('Salzburg');
  await expect(warning.getByRole('link')).toHaveCount(0);
  await b.getByTestId('create-anyway').click();
  await b.waitForURL(/\/sales\/prospects\/AKV-\d{6}\?created=1$/);
  await b.context().close();

  // ADMIN sees everything and hands A's prospect over to B.
  const admin = await browser.newContext({ storageState: 'e2e/.auth/admin.json' });
  const page = await admin.newPage();
  await page.goto(`/sales/prospects/${prospectCode}`);
  await expect(page.getByTestId('detail-duplicates')).toContainText(`Hotel U Lípy ${tag}`);
  await page.getByTestId('change-owner').click();
  await page.getByTestId('owner-select').selectOption({ label: `${B.name} (${B.email})` });
  await page.getByTestId('owner-dialog-submit').click();
  await expect(page.getByTestId('prospect-owner')).toHaveText(B.name);
  await admin.close();
  const b2 = await signIn(browser, B.email);
  await b2.goto(`/sales/prospects/${prospectCode}`);
  await expect(b2.getByTestId('prospect-owner')).toHaveText(B.name);
  await expect(b2.getByTestId('prospect-next')).toContainText('Poslat vzorky');
  await b2.context().close();
  const a = await signIn(browser, A.email);
  expect((await a.request.get(`/api/admin/sales/prospects/${prospectCode}`)).status()).toBe(404);
  await a.context().close();
});

test('the list pages, searches and filters; overview, list and tasks read well on a phone', async ({
  browser,
}) => {
  const page = await signIn(browser, A.email);
  // A task for today on one of the synthetic prospects.
  const target = `Syntetický hotel ${tag} 07`;
  const found = await json<{ items: { code: string }[] }>(
    await page.request.get(`/api/admin/sales/prospects?q=${encodeURIComponent(target)}`),
  );
  await json(
    await page.request.post(`/api/admin/sales/prospects/${found.items[0]!.code}/tasks`, {
      data: {
        requestId: crypto.randomUUID(),
        title: 'Zavolat recepci',
        dueOn: pragueDay(0),
        contactId: null,
        assigneeId: null,
        note: null,
      },
    }),
  );
  await json(
    await page.request.post(`/api/admin/sales/prospects/${found.items[0]!.code}/stage`, {
      data: {
        requestId: crypto.randomUUID(),
        revision: 1,
        stage: 'CONTACTED',
        reason: null,
        lostReason: null,
      },
    }),
  );
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto('/sales/prospects');
  await expect(page.getByTestId('prospect-total')).toHaveText('32 zájemců');
  const rows = page.getByTestId('prospect-table').locator('tbody tr');
  await expect(rows).toHaveCount(25);
  // The nearest task first.
  await expect(rows.first()).toContainText(target);
  await expect(rows.first()).toContainText('dnes');
  await page.getByTestId('next-page').click();
  await expect(page).toHaveURL(/page=2/);
  await expect(rows).toHaveCount(7);
  await page.goto('/sales/prospects');
  await page.getByTestId('prospect-search').fill('Zlín');
  await page.getByTestId('filter-priority').selectOption('A');
  await page.getByTestId('apply-filters').click();
  await expect(page.getByTestId('prospect-total')).toHaveText('5 zájemců');
  await page.goto('/sales/prospects?next=today');
  await expect(rows).toHaveCount(1);
  await page.goto('/sales/prospects');
  await shot(page, 'sales-02-list-desktop');
  await page.goto('/sales');
  await expect(page.getByTestId('count-today')).toHaveText('1');
  await expect(page.getByTestId('overview-today')).toContainText('Zavolat recepci');
  await expect(page.getByTestId('overview-in-progress')).toContainText(target);
  await shot(page, 'sales-01-overview-desktop');
  for (const width of [390, 320]) {
    await page.setViewportSize({ width, height: 844 });
    for (const [path, name] of [
      ['/sales', 'sales-01-overview'],
      ['/sales/prospects', 'sales-02-list'],
      ['/sales/tasks', 'sales-04-tasks'],
    ] as const) {
      await page.goto(path);
      await expect(page.locator('h1')).toBeVisible();
      if (path === '/sales/prospects') {
        await expect(page.getByTestId('prospect-table')).toBeHidden();
        await expect(page.getByTestId('prospect-cards').locator('li')).toHaveCount(25);
      }
      await noOverflow(page);
      await shot(page, `${name}-${width}`);
    }
  }
  await page.context().close();
});
