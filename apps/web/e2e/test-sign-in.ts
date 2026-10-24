import type { Page } from '@playwright/test';

/**
 * Signs a synthetic e2e user in through the automated-test identity fixture (AUTH_PROVIDER=test,
 * which exists only with APP_ENV=test; ADR 0037). The real /login page has no button for it — on
 * DEV/PROD it is password + TOTP only — so the fixture is entered at /api/auth/login, keeping the
 * `next` of a /login page the test was sent to. The session, permissions and redirects that
 * follow are the application's own.
 */
export async function signInWithForm(page: Page, email: string): Promise<void> {
  const here = /^https?:/.test(page.url()) ? new URL(page.url()) : null;
  const next = here?.pathname === '/login' ? (here.searchParams.get('next') ?? '/') : '/';
  await page.goto(`/api/auth/login?next=${encodeURIComponent(next)}`);
  await page.getByLabel('E-mail').fill(email);
  await page.getByRole('button', { name: 'Continue' }).click();
}
