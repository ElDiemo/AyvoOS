import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test, type Page } from '@playwright/test';

const STUB = 'http://127.0.0.1:4301';
const stubState = async (page: Page) =>
  (await (await page.request.get(`${STUB}/__state`)).json()) as {
    sessions: number;
    lastClient: { origin: string } | null;
  };
/** Screenshots for the PR, only when asked for (PORTAL_SCREENSHOTS=<dir>). */
const shot = async (page: Page, name: string) => {
  const dir = process.env.PORTAL_SCREENSHOTS;
  if (!dir) return;
  mkdirSync(dir, { recursive: true });
  const width = page.viewportSize()!.width;
  await page.screenshot({ path: join(dir, `${name}-${width}.png`), fullPage: true });
};
const noSideways = async (page: Page) =>
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    ),
  ).toBeLessThanOrEqual(0);

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
 * "Zabezpečení účtu" in the browser against the core stub (the real rules — password and code
 * checked, every session ended, new recovery codes, old app refused — are tested against the real
 * core in the API suite): the link in the header, a refused password, the new app's QR code and
 * code, the new recovery codes once, the earlier sessions ended; without a session the page sends
 * to sign-in and the step is refused; portal-web's own CSRF; 390 and 1440 px.
 */
test.describe('hotel portal: replacing the authenticator app', () => {
  test('from the header: a wrong password is refused; the new app, new recovery codes, earlier sessions ended', async ({
    page,
    browser,
  }) => {
    // Another device of the same account.
    const other = await browser.newPage();
    await signIn(other);
    await signIn(page);
    await page.getByTestId('account-link').click();
    await expect(page.getByRole('heading', { name: 'Zabezpečení účtu' })).toBeVisible();
    await noSideways(page);
    await shot(page, 'account');
    await page.locator('[name=password]').fill('Spatne heslo 2026 portal');
    await page.locator('[name=current-code]').fill('123456');
    await page.getByRole('button', { name: 'Pokračovat' }).click();
    await expect(page.getByTestId('replace-mfa-form').getByRole('alert')).toHaveText(
      /Heslo nebo kód nesouhlasí/,
    );
    await page.locator('[name=password]').fill('Dlouhe portalove heslo 2026');
    await page.getByRole('button', { name: 'Pokračovat' }).click();
    await expect(page.getByTestId('replace-mfa-setup')).toBeVisible();
    await expect(page.getByTestId('setup-key')).toHaveText('KRSXG5CTMVRXEZLU');
    expect((await stubState(page)).lastClient?.origin).toBe('http://localhost:3300');
    await noSideways(page);
    await shot(page, 'account-setup');
    // A wrong code of the new app keeps the step.
    await page.locator('[name=code]').fill('000000');
    await page.getByRole('button', { name: 'Dokončit výměnu' }).click();
    await expect(page.getByTestId('replace-mfa-setup').getByRole('alert')).toBeVisible();
    await page.locator('[name=code]').fill('123456');
    await page.getByRole('button', { name: 'Dokončit výměnu' }).click();
    const codes = page.getByTestId('recovery-codes');
    await expect(codes).toContainText('nnnn-oooo-pppp');
    await shot(page, 'account-codes');
    await page.getByRole('button', { name: 'Uloženo, pokračovat' }).click();
    await expect(page.getByRole('heading', { name: 'Moje hotely' })).toBeVisible();
    // Only the new session is left: the other device is signed out.
    expect((await stubState(page)).sessions).toBe(1);
    await other.reload();
    await expect(other).toHaveURL(/\/login/);
    await other.close();
  });

  test('without a session: the page sends to sign-in and the step is refused; a cross-site step is refused', async ({
    page,
  }) => {
    await page.context().clearCookies();
    await page.goto('/account');
    await expect(page).toHaveURL(/\/login/);
    const r = await page.request.post('/auth/replace-mfa', {
      headers: { Origin: 'http://localhost:3300', 'Sec-Fetch-Site': 'same-origin' },
      data: { password: 'Dlouhe portalove heslo 2026', code: '123456' },
    });
    expect(r.status()).toBe(401);
    await signIn(page);
    const cross = await page.request.post('/auth/replace-mfa', {
      headers: { Origin: 'https://evil.example.test', 'Sec-Fetch-Site': 'cross-site' },
      data: { password: 'Dlouhe portalove heslo 2026', code: '123456' },
    });
    expect(cross.status()).toBe(403);
  });
});
