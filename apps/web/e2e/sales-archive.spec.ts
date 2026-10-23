import { expect, test } from '@playwright/test';
import type { ProspectDetail } from '@ayvo/types';
import { json, noOverflow } from './dispatch-setup';
import { pragueDay, prospect, shot, signIn } from './sales-setup';

/**
 * Obchod (doc 034 §3a, §6) in the real built app: a SALES-only salesperson edits an open task
 * (also against a concurrent edit, keeping what was typed), archives a prospect only after its
 * open task is resolved, finds it through the archive filter and restores it. ADMIN may give a
 * task to a sales administrator. Synthetic data only.
 */
test.describe.configure({ mode: 'serial' });

const tag = Date.now().toString(36).slice(-5).toUpperCase();
const C = { email: `e2e-obchod-c-${tag}@ayvo.test`.toLowerCase(), name: 'Cyril Obchodník' };
const name = `Penzion Archivní ${tag}`;
let code = '';

test.beforeAll(async ({ browser }) => {
  const admin = await browser.newContext({ storageState: 'e2e/.auth/admin.json' });
  await json(
    await admin.request.post('/api/admin/identity/users', {
      data: {
        email: C.email,
        displayName: C.name,
        roles: ['SALES'],
        siteIds: [],
        warehouseCodes: [],
        reason: 'obchodník (E2E)',
      },
    }),
  );
  await admin.close();
  const c = await signIn(browser, C.email);
  let d = await json<ProspectDetail>(
    await c.request.post('/api/admin/sales/prospects', {
      data: prospect(name, {
        city: 'Telč',
        contact: {
          label: 'Recepce',
          position: null,
          email: null,
          phone: '+420 777 123 456',
          note: null,
          isPrimary: true,
        },
      }),
    }),
  );
  code = d.code;
  d = await json<ProspectDetail>(
    await c.request.post(`/api/admin/sales/prospects/${code}/contacts`, {
      data: {
        requestId: crypto.randomUUID(),
        revision: null,
        label: 'Ing. Nováková',
        position: 'Provozní',
        email: null,
        phone: null,
        note: null,
        isPrimary: false,
      },
    }),
  );
  await json(
    await c.request.post(`/api/admin/sales/prospects/${code}/tasks`, {
      data: {
        requestId: crypto.randomUUID(),
        title: 'Zavolat recepci',
        dueOn: pragueDay(1),
        contactId: null,
        assigneeId: null,
        note: null,
      },
    }),
  );
  await c.context().close();
});

test('ADMIN takes over the task while the salesperson edits it: the reload sends the new assignee', async ({
  browser,
}) => {
  const one = await signIn(browser, C.email);
  const created = await json<ProspectDetail>(
    await one.request.post(`/api/admin/sales/prospects/${code}/tasks`, {
      data: {
        requestId: crypto.randomUUID(),
        title: 'Poslat ceník',
        dueOn: pragueDay(2),
        contactId: null,
        assigneeId: null,
        note: null,
      },
    }),
  );
  const t0 = created.openTasks.find((t) => t.title === 'Poslat ceník')!;
  await one.goto(`/sales/prospects/${code}`);
  await one.getByTestId('task-Poslat ceník').getByTestId('task-edit').click();
  const dialog = one.getByTestId('task-edit-dialog');
  await dialog.getByTestId('task-edit-title').fill('Poslat ceník a vzorky');
  await dialog.getByTestId('task-edit-note').fill('Po telefonu s ředitelkou');

  // Meanwhile ADMIN takes the task over (the salesperson's form still holds the old assignee).
  const admin = await browser.newContext({ storageState: 'e2e/.auth/admin.json' });
  const me = await json<{ user: { id: string } }>(await admin.request.get('/api/auth/me'));
  await json(
    await admin.request.post(`/api/admin/sales/tasks/${t0.id}/update`, {
      data: {
        requestId: crypto.randomUUID(),
        revision: t0.revision,
        title: t0.title,
        note: null,
        contactId: null,
        assigneeId: me.user.id,
      },
    }),
  );

  // The first save is refused as stale; after reloading, the typed text is saved — with the
  // assignee as the server has it now (never the hidden old one, which the API would refuse).
  await dialog.getByTestId('task-edit-dialog-submit').click();
  await expect(dialog.getByTestId('task-edit-dialog-error')).toContainText(
    'Vaše úpravy zůstaly ve formuláři',
  );
  await dialog.getByTestId('dialog-reload').click();
  await expect(dialog.getByTestId('task-edit-reloaded')).toBeVisible();
  await expect(dialog.getByTestId('task-edit-title')).toHaveValue('Poslat ceník a vzorky');
  await dialog.getByTestId('task-edit-dialog-submit').click();
  await expect(dialog).not.toBeVisible();
  await expect(one.getByTestId('task-Poslat ceník a vzorky')).toContainText(
    'Po telefonu s ředitelkou',
  );
  const after = await json<ProspectDetail>(
    await admin.request.get(`/api/admin/sales/prospects/${code}`),
  );
  expect(after.openTasks.find((t) => t.id === t0.id)).toMatchObject({
    title: 'Poslat ceník a vzorky',
    note: 'Po telefonu s ředitelkou',
    assignee: { id: me.user.id },
  });
  // Leave the prospect as the following tests expect it (one open task).
  const done = after.openTasks.find((t) => t.id === t0.id)!;
  await json(
    await admin.request.post(`/api/admin/sales/tasks/${t0.id}/cancel`, {
      data: { requestId: crypto.randomUUID(), revision: done.revision, reason: 'konec testu' },
    }),
  );
  await admin.close();
  await one.context().close();
});

test('edits a task in the detail; a concurrent edit keeps what was typed', async ({ browser }) => {
  const one = await signIn(browser, C.email);
  await one.goto(`/sales/prospects/${code}`);
  const tasks = one.getByTestId('open-task-list');
  await tasks.getByTestId('task-edit').click();
  const dialog = one.getByTestId('task-edit-dialog');
  await expect(dialog.getByTestId('task-edit-title')).toHaveValue('Zavolat recepci');
  // No error yet → no (empty) alert in the dialog.
  await expect(dialog.getByRole('alert')).toHaveCount(0);
  // A salesperson is not offered other assignees.
  await expect(dialog.getByTestId('task-edit-assignee')).toHaveCount(0);
  await dialog.getByTestId('task-edit-title').fill('Zavolat paní Novákové');
  await dialog.getByTestId('task-edit-contact').selectOption({ label: 'Ing. Nováková' });
  await dialog.getByTestId('task-edit-note').fill('Rozhoduje o kosmetice');

  // Meanwhile the same task is edited in another window.
  const two = await signIn(browser, C.email);
  await two.goto(`/sales/prospects/${code}`);
  await two.getByTestId('open-task-list').getByTestId('task-edit').click();
  await two.getByTestId('task-edit-note').fill('Volat dopoledne');
  await two.getByTestId('task-edit-dialog-submit').click();
  await expect(two.getByTestId('task-edit-dialog')).not.toBeVisible();
  await expect(two.getByTestId('open-task-list')).toContainText('Volat dopoledne');
  await two.context().close();

  // The first save is refused; the typed values stay; after reloading it saves.
  await dialog.getByTestId('task-edit-dialog-submit').click();
  await expect(dialog.getByTestId('task-edit-dialog-error')).toContainText(
    'Vaše úpravy zůstaly ve formuláři',
  );
  await dialog.getByTestId('dialog-reload').click();
  await expect(dialog.getByTestId('task-edit-reloaded')).toBeVisible();
  await expect(dialog.getByTestId('task-edit-title')).toHaveValue('Zavolat paní Novákové');
  await expect(dialog.getByTestId('task-edit-note')).toHaveValue('Rozhoduje o kosmetice');
  await dialog.getByTestId('task-edit-dialog-submit').click();
  await expect(dialog).not.toBeVisible();
  const task = one.getByTestId('task-Zavolat paní Novákové');
  await expect(task).toContainText('Ing. Nováková');
  await expect(task).toContainText('Rozhoduje o kosmetice');
  // The due date is unchanged (it moves only through "Přesunout"); the change is in the history.
  await expect(task.getByTestId('task-due-label')).toHaveText('zítra');
  await one.getByTestId('history-all').click();
  await expect(one.getByTestId('all-changes')).toContainText(
    'název úkolu: Zavolat recepci → Zavolat paní Novákové',
  );
  await one.context().close();
});

test('archive is refused with an open task, then archived, found by the filter and restored', async ({
  browser,
}) => {
  const page = await signIn(browser, C.email);
  await page.goto(`/sales/prospects/${code}`);
  await page.getByTestId('change-stage').click();
  await page.getByTestId('stage-select').selectOption({ label: 'Jednání' });
  await page.getByTestId('stage-dialog-submit').click();
  await expect(page.getByTestId('prospect-stage')).toHaveText('Jednání');

  // Open task: the dialog lists it and leads to it; nothing is cancelled automatically.
  await page.getByTestId('archive-prospect').click();
  const archive = page.getByTestId('archive-dialog');
  await expect(archive.getByTestId('archive-open-tasks')).toContainText('Zavolat paní Novákové');
  await expect(archive.getByTestId('archive-reason')).toHaveCount(0);
  await archive.getByTestId('archive-to-tasks').click();
  await expect(archive).not.toBeVisible();
  await expect(page).toHaveURL(/#open-tasks$/);
  const task = page.getByTestId('open-task-list').getByTestId('task-Zavolat paní Novákové');
  await task.getByTestId('task-done').click();
  await page.getByTestId('task-action-text').fill('Hotel letos zavírá');
  await page.getByTestId('task-action-dialog-submit').click();
  await expect(page.getByTestId('open-tasks')).toContainText('Žádný otevřený úkol');

  // Now it archives — with a reason; the stage stays.
  await page.getByTestId('archive-prospect').click();
  await archive.getByTestId('archive-reason').fill('Hotel zavřel');
  await archive.getByTestId('archive-dialog-submit').click();
  const banner = page.getByTestId('prospect-archived');
  await expect(banner).toContainText('Zájemce je archivovaný');
  await expect(banner).toContainText('Hotel zavřel');
  await expect(page.getByTestId('prospect-stage')).toHaveText('Jednání');
  // Read-only until restored: no quick actions, no contact or profile edits, no corrections.
  await expect(page.getByTestId('prospect-actions')).toHaveCount(0);
  await expect(page.getByTestId('add-contact')).toHaveCount(0);
  await expect(page.getByTestId('prospect-next')).toHaveCount(0);
  await expect(page.getByTestId('edit-prospect')).toHaveCount(0);
  await expect(page.getByTestId('contact-Recepce')).toBeVisible();
  for (const width of [390, 320]) {
    await page.setViewportSize({ width, height: 800 });
    await expect(banner).toBeVisible();
    await expect(page.getByTestId('restore-prospect')).toBeVisible();
    await noOverflow(page);
    await shot(page, `sales-05-archived-${width}`);
  }
  await page.setViewportSize({ width: 1280, height: 900 });
  await shot(page, 'sales-05-archived-desktop');

  // Not among the active ones; found through the filter, marked as archived.
  await page.goto(`/sales/prospects?q=${encodeURIComponent(`Archivní ${tag}`)}`);
  await expect(page.getByTestId('prospect-total')).toHaveText('0 zájemců');
  await page.getByTestId('filter-archived').selectOption('archived');
  await page.getByTestId('apply-filters').click();
  await expect(page.getByTestId('prospect-total')).toHaveText('1 zájemce');
  await expect(page.getByTestId(`prospect-${code}`).getByTestId('archived-badge')).toBeVisible();
  await page.getByTestId(`prospect-${code}`).getByRole('link', { name }).click();

  // Restore: back as it was, no new task.
  await page.getByTestId('restore-prospect').click();
  await page.getByTestId('restore-reason').fill('Hotel znovu otevírá');
  await page.getByTestId('restore-dialog-submit').click();
  await expect(page.getByTestId('prospect-archived')).toHaveCount(0);
  await expect(page.getByTestId('prospect-actions')).toBeVisible();
  await expect(page.getByTestId('prospect-stage')).toHaveText('Jednání');
  await expect(page.getByTestId('prospect-next')).toContainText('Žádný naplánovaný krok');
  await expect(page.getByTestId('timeline')).toContainText('Obnoven: Důvod: Hotel znovu otevírá');
  await expect(page.getByTestId('timeline')).toContainText('Archivován: Důvod: Hotel zavřel');
  await page.context().close();
});

test('ADMIN may give a task to a sales administrator in the edit dialog', async ({ browser }) => {
  const c = await signIn(browser, C.email);
  await json(
    await c.request.post(`/api/admin/sales/prospects/${code}/tasks`, {
      data: {
        requestId: crypto.randomUUID(),
        title: 'Domluvit schůzku',
        dueOn: pragueDay(2),
        contactId: null,
        assigneeId: null,
        note: null,
      },
    }),
  );
  await c.context().close();
  const admin = await browser.newContext({ storageState: 'e2e/.auth/admin.json' });
  const page = await admin.newPage();
  await page.goto(`/sales/prospects/${code}`);
  await page.getByTestId('task-Domluvit schůzku').getByTestId('task-edit').click();
  const assignee = page.getByTestId('task-edit-assignee');
  await expect(assignee).toHaveValue(/.+/);
  const options = await assignee.locator('option').allTextContents();
  expect(options).toContain(C.name);
  // Only the owner and sales administrators — never another salesperson.
  expect(options.some((o) => o.startsWith('Adam Obchodník') || o.startsWith('Bára'))).toBe(false);
  await admin.close();
});
