import { createHmac } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { expect, test, type Page } from '@playwright/test';

/**
 * Native sign-in in a real browser against the built API and web app (doc 038): the emailed
 * activation link → own password → authenticator QR/TOTP → recovery codes → sign-out → sign-in
 * with password + TOTP → sign-out → sign-in with a recovery code. The administrator and the
 * activation mail come from apps/api/scripts/start-native-auth-e2e.mjs (synthetic, in-memory
 * mail of APP_ENV=test only). No fake identity endpoint, no external request, no screenshots.
 */
const fixture = JSON.parse(readFileSync(resolve(import.meta.dirname, '.fixture.json'), 'utf8')) as {
  email: string;
  activationUrl: string;
};
const PASSWORD = 'Vlastni dlouhe heslo pro AYVO 2026';

/** RFC 6238 TOTP (SHA-1, 6 digits, 30 s) for a base32 secret at a given time step. */
function totp(secret: string, step: number): string {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = '';
  for (const c of secret.replace(/=+$/, ''))
    bits += alphabet.indexOf(c).toString(2).padStart(5, '0');
  const key = Buffer.from(bits.match(/.{8}/g)!.map((b) => parseInt(b, 2)));
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(step));
  const mac = createHmac('sha1', key).update(counter).digest();
  const offset = mac[mac.length - 1]! & 0xf;
  return String((mac.readUInt32BE(offset) & 0x7fffffff) % 1_000_000).padStart(6, '0');
}
const stepNow = () => Math.floor(Date.now() / 30_000);

async function me(page: Page) {
  return (await page.request.get('/api/auth/me')).status();
}

async function signOut(page: Page) {
  await page
    .getByRole('button', { name: /Odhlásit/ })
    .filter({ visible: true })
    .first()
    .click();
  await expect(page).toHaveURL(/\/login/);
  expect(await me(page)).toBe(401);
}

async function passwordStep(page: Page) {
  await page.goto('/login');
  await page.getByLabel('E-mail').fill(fixture.email);
  await page.getByLabel('Heslo', { exact: true }).fill(PASSWORD);
  await page.getByRole('button', { name: 'Přihlásit se' }).click();
  await expect(page.getByLabel('Ověřovací kód')).toBeVisible();
  // One factor is not a session.
  expect(await me(page)).toBe(401);
}

test('activation, TOTP sign-in, sign-out and recovery-code sign-in in the browser', async ({
  page,
}) => {
  const external: string[] = [];
  page.on('request', (request) => {
    const url = new URL(request.url());
    if (url.hostname !== 'localhost' && url.protocol !== 'data:') external.push(url.origin);
  });

  // 1. The emailed link: the token is read from the fragment and removed from the address bar.
  await page.goto(fixture.activationUrl);
  await expect(page).toHaveURL((url) => url.pathname === '/activate' && url.hash === '');
  expect(await me(page)).toBe(401);
  await page.getByLabel('Nové heslo').fill(PASSWORD);
  await page.getByLabel('Heslo znovu').fill(PASSWORD);
  await page.getByRole('button', { name: 'Pokračovat' }).click();

  // 2. Authenticator setup: QR plus the manual key; still no session before the code.
  await expect(page.getByAltText('QR pro nastavení ověřovací aplikace AYVO OS')).toBeVisible();
  await page.getByText('Nemohu načíst QR kód').click();
  const secret = (await page.locator('details p.font-mono').textContent())!.trim();
  expect(secret).toMatch(/^[A-Z2-7]{32,64}$/);
  expect(await me(page)).toBe(401);
  const enrolledAt = stepNow();
  await page.getByLabel('Ověřovací kód').fill(totp(secret, enrolledAt));
  await page.getByRole('button', { name: 'Ověřit a pokračovat' }).click();

  // 3. Ten one-time recovery codes, shown once.
  const list = page.getByRole('list', { name: 'Záložní kódy' });
  await expect(list.getByRole('listitem')).toHaveCount(10);
  const codes = (await list.getByRole('listitem').allTextContents()).map((c) => c.trim());
  expect(new Set(codes).size).toBe(10);
  await page.getByRole('button', { name: 'Kódy mám uložené — pokračovat' }).click();
  await expect(page.getByTestId('current-user')).toHaveText('Native UI Admin');
  expect(await me(page)).toBe(200);
  // No link token or secret is kept by the browser outside its HttpOnly cookies.
  const stored = await page.evaluate(() => JSON.stringify({ ...localStorage, ...sessionStorage }));
  expect(stored).not.toContain(secret);
  expect(stored).not.toMatch(/token/i);
  await signOut(page);

  // 4. Password, then the authenticator. The same time step as the enrolment is refused (replay);
  //    the next step (accepted within the ±1 window) signs in.
  await passwordStep(page);
  await page.getByLabel('Ověřovací kód').fill(totp(secret, enrolledAt));
  await page.getByRole('button', { name: 'Ověřit a pokračovat' }).click();
  await expect(page.locator('p[role=alert]')).toContainText('Kód neplatí');
  expect(await me(page)).toBe(401);
  await page.getByLabel('Ověřovací kód').fill(totp(secret, enrolledAt + 1));
  await page.getByRole('button', { name: 'Ověřit a pokračovat' }).click();
  await expect(page.getByTestId('current-user')).toHaveText('Native UI Admin');
  await signOut(page);

  // 5. Lost phone: a recovery code instead of the authenticator, usable exactly once.
  await passwordStep(page);
  await page.getByRole('button', { name: 'Nemám telefon — použít záložní kód' }).click();
  await page.getByLabel('Záložní kód').fill(codes[0]!);
  await page.getByRole('button', { name: 'Ověřit a pokračovat' }).click();
  await expect(page.getByTestId('current-user')).toHaveText('Native UI Admin');
  await signOut(page);
  await passwordStep(page);
  await page.getByRole('button', { name: 'Nemám telefon — použít záložní kód' }).click();
  await page.getByLabel('Záložní kód').fill(codes[0]!);
  await page.getByRole('button', { name: 'Ověřit a pokračovat' }).click();
  await expect(page.locator('p[role=alert]')).toContainText('Kód neplatí');
  expect(await me(page)).toBe(401);

  // 6. The activation link is single-use.
  await page.goto(fixture.activationUrl);
  await page.getByLabel('Nové heslo').fill(PASSWORD);
  await page.getByLabel('Heslo znovu').fill(PASSWORD);
  await page.getByRole('button', { name: 'Pokračovat' }).click();
  await expect(page.locator('p[role=alert]')).toContainText('Odkaz už neplatí');

  expect(external).toEqual([]);
});
