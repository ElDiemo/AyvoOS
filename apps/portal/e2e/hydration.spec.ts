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
const credentialUrls = (urls: string[]) =>
  urls.filter(
    (u) => /[?&](password|email|code)=/.test(u) || u.includes(encodeURIComponent(password)),
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
    await page.locator('[name=code]').fill('123456');
    await page.getByRole('button', { name: 'Přihlásit' }).click();
    await expect(page.getByRole('heading', { name: 'Moje hotely' })).toBeVisible();
    expect(credentialUrls(urls)).toEqual([]);
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
