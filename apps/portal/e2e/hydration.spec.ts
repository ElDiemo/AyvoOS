import { expect, test, type Page } from '@playwright/test';

/**
 * The sign-in forms before the page is interactive (CI 43020769648, hardening.spec.ts:222 on
 * mobile-390: "waiting for locator('[name=code]')"). A submit before React handles the form was
 * the browser's own — a GET of /login with the e-mail AND THE PASSWORD in the URL (history, logs),
 * then a fresh page without the second step. The page's scripts are delayed here as on a slow
 * phone or a busy runner; the forms must not take input until they are interactive, and never
 * put a credential into a URL.
 */
const email = 'recepce@hotel-e2e.test';
const password = 'Dlouhe portalove heslo 2026';

async function slowScripts(page: Page) {
  await page.route('**/_next/static/chunks/**', async (route) => {
    await new Promise((r) => setTimeout(r, 1500));
    await route.continue();
  });
}
const code = '123456';
const token = 'A'.repeat(43);
/** Any request whose URL carries a credential: by name, or by its value (also encoded). */
const credentialUrls = (urls: string[]) =>
  urls.filter(
    (u) =>
      /[?&](password|email|code|token)=/.test(u) ||
      [password, encodeURIComponent(password), code, token].some((v) => u.includes(v)),
  );

test.describe('hotel portal: forms before hydration', () => {
  test('sign-in typed while the scripts are still loading: never a GET with the password, and it signs in', async ({
    page,
  }) => {
    const urls: string[] = [];
    page.on('request', (r) => urls.push(r.url()));
    await slowScripts(page);
    await page.goto('/login', { waitUntil: 'commit' });
    await page.locator('[name=email]').fill(email);
    await page.locator('[name=password]').fill(password);
    await page.getByRole('button', { name: 'Pokračovat' }).click();
    await page.locator('[name=code]').fill(code);
    await page.getByRole('button', { name: 'Přihlásit' }).click();
    await expect(page.getByRole('heading', { name: 'Moje hotely' })).toBeVisible();
    // Neither the password nor the second-factor code in any request URL, the page's own included.
    expect(credentialUrls(urls)).toEqual([]);
    expect(credentialUrls([page.url()])).toEqual([]);
  });

  test('activation while the scripts are still loading: the link token, the new password and the code never reach a URL', async ({
    page,
  }) => {
    const urls: string[] = [];
    page.on('request', (r) => urls.push(r.url()));
    await slowScripts(page);
    // The token is in the fragment: never sent to a server; the page removes it from the address.
    await page.goto(`/activate#token=${token}`, { waitUntil: 'commit' });
    await page.locator('[name=password]').fill(password);
    await page.getByRole('button', { name: 'Nastavit heslo' }).click();
    await page.locator('[name=code]').fill(code);
    await page.getByRole('button', { name: 'Dokončit aktivaci' }).click();
    await expect(page.getByTestId('recovery-codes')).toBeVisible();
    expect(credentialUrls(urls)).toEqual([]);
    expect(page.url()).not.toContain(token);
    // Every request that carried a credential was a POST body, never a GET.
    const gets: string[] = [];
    page.on('request', (r) => r.method() === 'GET' && gets.push(r.url()));
    await page.getByRole('button', { name: 'Uloženo, pokračovat' }).click();
    await expect(page.getByTestId('portal-hotels')).toBeVisible();
    expect(credentialUrls(gets)).toEqual([]);
  });

  test('the forms are POST forms and disabled until interactive (server HTML)', async ({
    page,
  }) => {
    for (const path of ['/login', '/forgot-password']) {
      const html = await (await page.request.get(path)).text();
      const forms = html.match(/<form\b[^>]*>/g) ?? [];
      expect(forms.length, path).toBeGreaterThan(0);
      for (const form of forms) expect(form, path).toMatch(/method="post"/);
      // The fields are inside a fieldset that the server renders disabled.
      expect(html, path).toMatch(/<fieldset[^>]*disabled/);
    }
    // Activation and reset render their form only in the browser (the link's token is in the
    // fragment): nothing to submit before the page is interactive.
    for (const path of ['/activate', '/reset-password']) {
      const html = await (await page.request.get(path)).text();
      expect(html.match(/<form\b/g) ?? [], path).toEqual([]);
    }
  });
});
