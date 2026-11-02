import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
const ADMIN_STATE = 'e2e/.auth/admin.json';

/**
 * The run settings on Měsíční běh (doc 040 §11, §13): saved as a version with a reason, the plan
 * of an issue month (issue date, billed month per billing timing) and a link that opens the run
 * with them filled in — the person still loads, reviews and confirms. Synthetic values; nothing is
 * issued or sent here.
 */
const screenshots = resolve(import.meta.dirname, '../../../docs/screenshots/finance');

test.describe('Nastavení měsíčního běhu', () => {
  test.use({ storageState: ADMIN_STATE });

  test('a version with a reason, the plan of a month, the run filled in', async ({ page }) => {
    await page.goto('/finance/invoices/run');
    const card = page.getByTestId('run-settings');
    await expect(card).toBeVisible();
    const form = page.getByTestId('run-settings-form');
    await form.getByTestId('run-settings-day').fill('1');
    await form.getByTestId('run-settings-advance').selectOption('ISSUE_MONTH');
    await form.getByTestId('run-settings-arrears').selectOption('PREVIOUS_MONTH');
    await form.getByTestId('run-settings-reason').fill('Jako UOL: 1. dne za daný měsíc (E2E)');
    await form.getByTestId('run-settings-save').click();
    await expect(page.getByTestId('run-settings-current')).toContainText(
      'Vystavení 1. dne v měsíci · smlouvy předem: měsíc vystavení · smlouvy zpětně: předchozí měsíc',
    );

    const plan = page.getByTestId('run-plan');
    await plan.getByTestId('run-plan-month').fill('2026-12');
    await plan.getByTestId('run-plan-load').click();
    await expect(plan.getByTestId('run-plan-ADVANCE')).toContainText(
      'období 2026-12, vystavení 2026-12-01',
    );
    await expect(plan.getByTestId('run-plan-ARREARS')).toContainText(
      'období 2026-11, vystavení 2026-12-01',
    );
    await mkdir(screenshots, { recursive: true });
    for (const width of [1440, 390]) {
      await page.setViewportSize({ width, height: 900 });
      await page.evaluate(() => window.scrollTo(0, 0));
      expect(
        await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
      ).toBe(true);
      await page.screenshot({
        path: resolve(screenshots, `finance-run-settings-${width}.png`),
        fullPage: true,
      });
    }
    await page.setViewportSize({ width: 1280, height: 900 });

    // The link opens the run with the period, issue date and timing; nothing is loaded or issued
    // by itself.
    await plan.getByTestId('run-plan-ARREARS').click();
    await expect(page).toHaveURL(/month=2026-11&issuedOn=2026-12-01&timing=ARREARS/);
    await expect(page.getByTestId('run-planned')).toContainText('Smlouvy zpětně');
    await expect(page.getByTestId('run-month')).toHaveValue('2026-11');
    await expect(page.getByTestId('run-items')).toHaveCount(0);
    await page.getByTestId('run-load').click();
    await expect(page.getByTestId('run-issued-on').or(page.getByTestId('run-empty'))).toBeVisible();
    if (await page.getByTestId('run-issued-on').isVisible())
      await expect(page.getByTestId('run-issued-on')).toHaveValue('2026-12-01');
  });

  // --- reviews RUN112-R1, R2 (Codex 2026-11-02, reproductions taken over) ---------------------

  async function saveDay(page: Page, day: string) {
    // Wait for the new version itself (the same day may already be shown from before).
    const current = page.getByTestId('run-settings-current');
    const before = (await current.textContent())!;
    const form = page.getByTestId('run-settings-form');
    await form.getByTestId('run-settings-day').fill(day);
    await form.getByTestId('run-settings-advance').selectOption('ISSUE_MONTH');
    await form.getByTestId('run-settings-arrears').selectOption('PREVIOUS_MONTH');
    await form.getByTestId('run-settings-reason').fill(`Den ${day} (E2E review)`);
    await form.getByTestId('run-settings-save').click();
    await expect(current).not.toHaveText(before);
    await expect(current).toContainText(`Vystavení ${day}. dne`);
  }

  test('RUN112-R1: a new settings version drops the calculated plan; an older link fills nothing in', async ({
    page,
  }) => {
    await page.goto('/finance/invoices/run');
    await saveDay(page, '1');
    await page.getByTestId('run-plan-month').fill('2026-12');
    await page.getByTestId('run-plan-load').click();
    await expect(page.getByTestId('run-plan-ADVANCE')).toContainText('2026-12-01');
    const oldLink = await page.getByTestId('run-plan-ADVANCE').getAttribute('href');
    await saveDay(page, '15');
    await expect(page.getByTestId('run-plan-ADVANCE')).toHaveCount(0);
    // Calculated again: the new issue day.
    await page.getByTestId('run-plan-month').fill('2026-12');
    await page.getByTestId('run-plan-load').click();
    await expect(page.getByTestId('run-plan-ADVANCE')).toContainText('2026-12-15');
    // The link of the older plan: nothing filled in, said so.
    await page.goto(oldLink!);
    await expect(page.getByTestId('run-planned-stale')).toBeVisible();
    await expect(page.getByTestId('run-planned')).toHaveCount(0);
    await expect(page.getByTestId('run-month')).toHaveValue('');
  });

  test('RUN112-R2: a late plan or error of an earlier month is dropped', async ({ page }) => {
    await page.goto('/finance/invoices/run');
    let seen!: () => void, release!: () => void;
    const arrived = new Promise<void>((r) => (seen = r));
    const gate = new Promise<void>((r) => (release = r));
    await page.route(
      '**/api/admin/finance/invoices/test-run/plan?issueMonth=2026-12',
      async (route) => {
        seen();
        await gate;
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({
            issueMonth: '2026-12',
            settingsRevision: 1,
            issuedOn: '2026-12-01',
            groups: [
              { billingTiming: 'ADVANCE', billedMonth: '2026-12' },
              { billingTiming: 'ARREARS', billedMonth: '2026-11' },
            ],
          }),
        });
      },
    );
    await page.getByTestId('run-plan-month').fill('2026-12');
    await page.getByTestId('run-plan-load').click();
    await arrived;
    await page.getByTestId('run-plan-month').fill('2027-01');
    const late = page.waitForResponse((r) => r.url().includes('issueMonth=2026-12'));
    release();
    await (await late).finished();
    await page.evaluate(
      () => new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r()))),
    );
    await expect(page.getByTestId('run-plan-ADVANCE')).toHaveCount(0);
    await expect(page.getByTestId('run-plan-month')).toHaveValue('2027-01');

    // A late error of an earlier attempt never replaces a newer plan.
    let failSeen!: () => void, failRelease!: () => void;
    const failArrived = new Promise<void>((r) => (failSeen = r));
    const failGate = new Promise<void>((r) => (failRelease = r));
    await page.route(
      '**/api/admin/finance/invoices/test-run/plan?issueMonth=2027-02',
      async (route) => {
        failSeen();
        await failGate;
        await route.fulfill({
          status: 503,
          contentType: 'application/json',
          body: JSON.stringify({ statusCode: 503, code: 'X', message: 'pozdní chyba (test)' }),
        });
      },
    );
    await page.getByTestId('run-plan-month').fill('2027-02');
    await page.getByTestId('run-plan-load').click();
    await failArrived;
    await page.getByTestId('run-plan-month').fill('2027-01');
    await page.getByTestId('run-plan-load').click();
    await expect(page.getByTestId('run-plan-ADVANCE')).toContainText('2027-01');
    const lateError = page.waitForResponse((r) => r.url().includes('issueMonth=2027-02'));
    failRelease();
    await (await lateError).finished();
    await page.evaluate(
      () => new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r()))),
    );
    await expect(page.getByTestId('run-plan')).not.toContainText('pozdní chyba');
    await expect(page.getByTestId('run-plan-ADVANCE')).toContainText('2027-01');
  });
});
