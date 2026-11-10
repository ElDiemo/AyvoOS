import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test, type Page } from '@playwright/test';

const STUB = 'http://127.0.0.1:4301';
const control = (page: Page, body: Record<string, unknown>) =>
  page.request.post(`${STUB}/__control`, { data: body });
const WIDTHS = [320, 390, 1440];

const shot = async (page: Page, name: string) => {
  const dir = process.env.PORTAL_SCREENSHOTS;
  if (!dir) return;
  mkdirSync(dir, { recursive: true });
  await page.screenshot({
    path: join(dir, `${name}-${page.viewportSize()!.width}.png`),
    fullPage: true,
  });
};
const noSideways = async (page: Page) =>
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    ),
  ).toBeLessThanOrEqual(0);
/** The focused element shows a visible focus ring (an outline or a box shadow). */
const focusVisible = (page: Page) =>
  page.evaluate(() => {
    const el = document.activeElement as HTMLElement | null;
    if (!el) return false;
    const s = getComputedStyle(el);
    return (s.outlineStyle !== 'none' && s.outlineWidth !== '0px') || s.boxShadow !== 'none';
  });

async function signIn(page: Page) {
  await page.goto('/login');
  await page.locator('[name=email]').fill('recepce@hotel-e2e.test');
  await page.locator('[name=password]').fill('Dlouhe portalove heslo 2026');
  await page.getByRole('button', { name: 'Pokračovat' }).click();
  await page.locator('[name=code]').fill('123456');
  await page.getByRole('button', { name: 'Přihlásit' }).click();
  await expect(page.getByRole('heading', { name: 'Moje hotely' })).toBeVisible();
}

/**
 * Small portal UX (synthetic stub data): "Faktury" lists the invoices first and keeps the ZIP as a
 * collapsible secondary action; an empty list explains itself and names the billing address of
 * the invoice e-mails (doc 043); password recovery has a way back to the sign-in; the signed-out
 * pages share the portal's look. Keyboard and focus, 320/390/1440 px, no sideways scrolling.
 * Sign-in, its limits and the package's rules are unchanged (their own specs).
 */
test.describe('hotel portal: invoices and sign-in UX', () => {
  // The widths are set inside each test; one project is enough.
  test.beforeEach(({}, info) => {
    test.skip(info.project.name !== 'mobile-390', 'widths set per test');
  });
  test.afterEach(async ({ page }) => {
    await control(page, { invoicesMode: 'ok' });
  });

  test('invoices first, the ZIP a collapsed secondary action, at 320/390/1440 px', async ({
    page,
  }) => {
    await signIn(page);
    for (const width of WIDTHS) {
      await page.setViewportSize({ width, height: 844 });
      await page.goto('/invoices');
      const list = page.getByTestId('portal-invoices');
      const pkg = page.getByTestId('invoice-package');
      await expect(list).toBeVisible();
      expect((await list.boundingBox())!.y).toBeLessThan((await pkg.boundingBox())!.y);
      await expect(pkg.getByLabel('Od měsíce')).toBeHidden();
      await noSideways(page);
      await shot(page, 'ux-invoices');
    }
    // Keyboard: the summary takes the focus visibly and opens the form.
    await page.getByTestId('invoice-package-open').focus();
    expect(await focusVisible(page)).toBe(true);
    await page.keyboard.press('Enter');
    await expect(page.getByTestId('invoice-package').getByLabel('Od měsíce')).toBeVisible();
    // Coming back with a refusal opens it with the reason.
    await page.goto('/invoices?balicek=NO_INVOICES&from=2025-01&to=2025-02');
    await expect(page.getByTestId('invoice-package').getByRole('alert')).toBeVisible();
  });

  test('no invoice yet: an explanation and the billing address, no package', async ({ page }) => {
    await signIn(page);
    await control(page, { invoicesMode: 'empty' });
    for (const width of WIDTHS) {
      await page.setViewportSize({ width, height: 844 });
      await page.goto('/invoices');
      const empty = page.getByTestId('invoices-empty');
      await expect(empty).toContainText('Zatím tu nejsou žádné faktury.');
      await expect(empty.getByRole('link', { name: 'invoice@ayvo.co' })).toHaveAttribute(
        'href',
        'mailto:invoice@ayvo.co',
      );
      await expect(page.getByTestId('invoice-package')).toHaveCount(0);
      await noSideways(page);
      await shot(page, 'ux-invoices-empty');
    }
  });

  test('password recovery leads back to the sign-in, by mouse and keyboard', async ({ page }) => {
    for (const width of WIDTHS) {
      await page.setViewportSize({ width, height: 844 });
      await page.goto('/login');
      await noSideways(page);
      await shot(page, 'ux-login');
      await page.locator('a[href="/forgot-password"]').click();
      await expect(page.getByRole('heading', { level: 1, name: 'Zapomenuté heslo' })).toBeVisible();
      await noSideways(page);
      await shot(page, 'ux-forgot');
      await page.getByTestId('back-to-login').click();
      await expect(page).toHaveURL(/\/login$/);
    }
    // Keyboard only: tab from the e-mail field past the button to the way back.
    await page.goto('/forgot-password');
    await page.locator('[name=email]').focus();
    expect(await focusVisible(page)).toBe(true);
    let onBack = false;
    for (let i = 0; i < 5 && !onBack; i++) {
      await page.keyboard.press('Tab');
      onBack = await page
        .getByTestId('back-to-login')
        .evaluate((el) => el === document.activeElement);
    }
    expect(onBack).toBe(true);
    expect(await focusVisible(page)).toBe(true);
    await page.keyboard.press('Enter');
    await expect(page).toHaveURL(/\/login$/);
    // The reset page (opened from the e-mailed link) has the same way back.
    await page.goto('/reset-password');
    await expect(page.getByTestId('back-to-login')).toHaveAttribute('href', '/login');
  });

  test('profile edit: the impact before saving, Uložit/Zrušit at hand on a phone, nothing covered', async ({
    page,
  }) => {
    await control(page, { resetProfile: true, profileSaves: 0, lastProfileBody: null });
    await signIn(page);
    await page.getByRole('link', { name: /Hotel Portál E2E/ }).click();
    await page.getByRole('link', { name: 'Upravit profil' }).click();
    await expect(page.getByRole('heading', { name: 'Upravit profil hotelu' })).toBeVisible();
    const actions = page.getByTestId('profile-actions');
    const save = actions.getByRole('button', { name: 'Uložit' });
    // The impact is read before the decision: before the actions in the document, and above them
    // on a wide screen where they follow the form.
    expect(
      await page
        .getByTestId('profile-impact')
        .evaluate(
          (el) =>
            !!(
              el.compareDocumentPosition(document.querySelector('[data-testid=profile-actions]')!) &
              Node.DOCUMENT_POSITION_FOLLOWING
            ),
        ),
    ).toBe(true);
    await page.setViewportSize({ width: 1440, height: 900 });
    expect((await page.getByTestId('profile-impact').boundingBox())!.y).toBeLessThan(
      (await save.boundingBox())!.y,
    );
    // A phone with the keyboard open (a short viewport): the actions stay in view at the top of
    // the form, and no focused field is ever under them.
    await page.setViewportSize({ width: 390, height: 560 });
    await page.evaluate(() => window.scrollTo(0, 0));
    await expect(save).toBeInViewport();
    await expect(actions.getByRole('link', { name: 'Zrušit' })).toBeInViewport();
    const uncovered = async (selector: string) => {
      const bar = (await actions.boundingBox())!;
      const box = (await page.locator(selector).boundingBox())!;
      expect(box.y + box.height, selector).toBeLessThanOrEqual(bar.y + 1);
    };
    for (const name of [
      'addressLine1',
      'city',
      'contactEmail',
      'receivingContactEmail',
      'deliveryNote',
      'reason',
    ]) {
      await page.locator(`[name=${name}]`).focus();
      await uncovered(`[name=${name}]`);
    }
    await shot(page, 'ux-profile-edit');
    // Errors: the summary takes the focus; its link brings the field into view above the actions.
    await page.locator('[name=addressLine1]').fill('');
    await page.locator('[name=reason]').fill('');
    await save.click();
    const summary = page.getByTestId('profile-form').getByRole('alert');
    await expect(summary).toBeFocused();
    await expect(summary).toContainText('Důvod'); // the reason is still required
    await summary.getByRole('link').first().click();
    await uncovered('[name=addressLine1]');
    await noSideways(page);
    await shot(page, 'ux-profile-errors');
    // Wide screens: the actions simply follow the form.
    await page.setViewportSize({ width: 1440, height: 900 });
    expect(await actions.evaluate((el) => getComputedStyle(el).position)).toBe('static');
  });
});
