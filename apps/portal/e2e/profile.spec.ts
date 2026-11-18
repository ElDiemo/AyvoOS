import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test, type Page } from '@playwright/test';

const STUB = 'http://127.0.0.1:4301';
const ORIGIN = 'http://localhost:3300';
const control = (page: Page, body: Record<string, unknown>) =>
  page.request.post(`${STUB}/__control`, { data: body });
const stubState = async (page: Page) =>
  (await (await page.request.get(`${STUB}/__state`)).json()) as {
    profile: Record<string, string | null>;
    profileSaves: number;
    lastProfileBody: Record<string, unknown> | null;
    hotelId: string;
    foreignHotelId: string;
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
 * "Profil hotelu" in the browser against the core stub (the contract's access, revocation and
 * concurrency rules are tested against the real core in the API suite): the profile in three
 * groups, a keyboard-only edit, validation, a concurrent change, a revoked grant, a foreign hotel,
 * portal-web's own CSRF, whitelist and size limits; 390 and 1440 px without sideways scrolling.
 */
test.describe('hotel portal: the hotel profile', () => {
  test.beforeEach(async ({ page }) => {
    await control(page, { resetProfile: true, profileSaves: 0, lastProfileBody: null });
  });

  test('the profile: hero, three groups, empty states, only finished sections in the navigation', async ({
    page,
  }) => {
    await signIn(page);
    await noSideways(page);
    await shot(page, 'hotels');
    await page.getByRole('link', { name: 'Zobrazit profil: Hotel Portál E2E' }).click();
    await expect(page.getByTestId('portal-hotel-name')).toHaveText('Hotel Portál E2E');
    await expect(page.getByTestId('profile-address')).toContainText('Portálová 1');
    await expect(page.getByTestId('profile-contact')).toContainText('Marie Recepční');
    await expect(page.getByTestId('profile-receiving')).toContainText(
      'Kontakt pro příjem zboží zatím není vyplněný.',
    );
    await expect(page.getByTestId('profile-receiving')).toContainText('Bez pokynů k doručení.');
    const nav = page.getByRole('navigation', { name: 'Hlavní navigace' });
    await expect(nav.getByRole('link')).toHaveText([
      'Moje hotely',
      'Dodávky',
      'Smlouvy',
      'Faktury',
    ]);
    await noSideways(page);
    await shot(page, 'profile-empty');
  });

  test('editing with the keyboard only: tab, type, Enter — saved and shown', async ({ page }) => {
    await signIn(page);
    const { hotelId } = await stubState(page);
    await page.goto(`/hotels/${hotelId}`);
    const edit = page.getByRole('link', { name: 'Upravit profil' });
    await edit.focus();
    await page.keyboard.press('Enter');
    await expect(page.getByRole('heading', { name: 'Upravit profil hotelu' })).toBeVisible();
    await noSideways(page);
    await shot(page, 'profile-edit');

    // The first field, then the natural tab order through the form.
    await page.getByLabel('Ulice a číslo').focus();
    await page.keyboard.press('ControlOrMeta+a');
    await page.keyboard.type('Dlouhá 5');
    await page.keyboard.press('Tab'); // Doplněk adresy
    await page.keyboard.type('vchod ze dvora');
    await page.keyboard.press('Tab'); // PSČ
    await page.keyboard.press('Tab'); // Město
    await page.keyboard.press('Tab'); // Jméno (hlavní kontakt)
    await page.keyboard.press('Tab'); // Telefon
    await page.keyboard.press('Tab'); // E-mail
    await page.keyboard.press('Tab'); // Jméno pro příjem
    await expect(page.getByLabel('Jméno (nepovinné)')).toBeFocused();
    await page.keyboard.type('Petr Sklad');
    await page.keyboard.press('Tab');
    await page.keyboard.type('+420 600 300 400');
    await page.getByLabel('Pokyny k doručení (nepovinné)').focus();
    await page.keyboard.type('Příjem 7–11 h, rampa.');
    await page.getByLabel('Důvod změny').focus();
    await page.keyboard.type('Nový vchod ze dvora');
    await page.getByLabel('E-mail', { exact: true }).focus();
    await page.keyboard.press('Enter');

    await expect(page.getByRole('status')).toHaveText('Profil hotelu je uložený.');
    await expect(page.getByTestId('profile-address')).toContainText('Dlouhá 5');
    await expect(page.getByTestId('profile-address')).toContainText('vchod ze dvora');
    await expect(page.getByTestId('profile-receiving')).toContainText('Petr Sklad');
    await expect(page.getByTestId('profile-receiving')).toContainText('Příjem 7–11 h, rampa.');
    await shot(page, 'profile-saved');

    const state = await stubState(page);
    expect(state.profileSaves).toBe(1);
    // Only the whitelisted fields, the fingerprint and the browser request reached the core.
    expect(Object.keys(state.lastProfileBody!).sort()).toEqual([
      'client',
      'expected',
      'profile',
      'reason',
    ]);
    expect(state.lastProfileBody!.reason).toBe('Nový vchod ze dvora');
    expect(Object.keys(state.lastProfileBody!.profile as object).sort()).toEqual(
      [
        'addressLine1',
        'addressLine2',
        'city',
        'contactEmail',
        'contactName',
        'contactPhone',
        'deliveryNote',
        'postalCode',
        'receivingContactEmail',
        'receivingContactName',
        'receivingContactPhone',
      ].sort(),
    );
    expect(state.lastProfileBody!.client).toMatchObject({ origin: ORIGIN });
    expect(state.profile).toMatchObject({ addressLine1: 'Dlouhá 5', receivingContactEmail: null });
  });

  test('invalid values: an error summary that takes the focus, marked fields, nothing sent', async ({
    page,
  }) => {
    await signIn(page);
    const { hotelId } = await stubState(page);
    await page.goto(`/hotels/${hotelId}/edit`);
    await page.getByLabel('Město').fill('');
    await page.getByLabel('E-mail', { exact: true }).fill('neni-email');
    await page.getByLabel('Telefon (nepovinné)').fill('+420 600 000 000');
    await page.getByRole('button', { name: 'Uložit změny' }).click();
    const alert = page.getByTestId('profile-form').getByRole('alert');
    await expect(alert).toBeFocused();
    await expect(alert).toContainText('Město: Vyplňte prosím.');
    await expect(alert).toContainText('E-mail: Zadejte platný e-mail.');
    await expect(alert).toContainText('Jméno (nepovinné): Kontakt pro příjem potřebuje jméno.');
    await expect(alert).toContainText('Důvod změny: Napište prosím důvod změny');
    await expect(page.getByLabel('Důvod změny')).toHaveAttribute('aria-invalid', 'true');
    await expect(page.getByLabel('Město')).toHaveAttribute('aria-invalid', 'true');
    await noSideways(page);
    await shot(page, 'profile-invalid');
    expect((await stubState(page)).profileSaves).toBe(0);
  });

  test('a concurrent change is reported, not overwritten; a revoked grant is “no longer yours”', async ({
    page,
  }) => {
    await signIn(page);
    const { hotelId } = await stubState(page);
    await page.goto(`/hotels/${hotelId}/edit`);
    await control(page, { touchProfile: true });
    await page.getByLabel('Ulice a číslo').fill('Souběžná 1');
    await page.getByLabel('Důvod změny').fill('Oprava adresy');
    await page.getByRole('button', { name: 'Uložit změny' }).click();
    await expect(page.getByTestId('profile-form').getByRole('alert')).toContainText(
      'mezitím změnil někdo jiný',
    );
    expect((await stubState(page)).profile.addressLine1).toBe('Portálová 1');
    await page.getByRole('link', { name: 'Načíst aktuální údaje' }).click();
    await expect(page.getByLabel('Město')).toHaveValue('Olomouc-jinde');

    await control(page, { profileGrant: false });
    await page.getByLabel('Ulice a číslo').fill('Odvolaná 1');
    await page.getByLabel('Důvod změny').fill('Oprava adresy');
    await page.getByRole('button', { name: 'Uložit změny' }).click();
    await expect(page.getByTestId('profile-form').getByRole('alert')).toContainText(
      'Tento hotel už ve vašem přístupu není.',
    );
    await page.goto(`/hotels/${hotelId}`);
    await expect(page.getByRole('heading', { name: 'Nenalezeno' })).toBeVisible();
    expect((await stubState(page)).profileSaves).toBe(0);
  });

  test('portal-web’s own checks: foreign hotel, CSRF, whitelist, size, no session', async ({
    page,
  }) => {
    await signIn(page);
    const { hotelId, foreignHotelId } = await stubState(page);
    for (const path of [`/hotels/${foreignHotelId}`, `/hotels/${foreignHotelId}/edit`]) {
      await page.goto(path);
      await expect(page.getByRole('heading', { name: 'Nenalezeno' })).toBeVisible();
    }
    const current = (await (await page.request.get(`${STUB}/__state`)).json()) as {
      profile: Record<string, string | null>;
    };
    const body = { expected: 'a'.repeat(64), profile: current.profile, reason: 'Oprava údajů' };
    const save = (id: string, data: unknown, headers: Record<string, string> = {}) =>
      page.request.post(`/hotels/${id}/profile`, {
        data,
        headers: { origin: ORIGIN, 'sec-fetch-site': 'same-origin', ...headers },
      });

    const foreign = await save(foreignHotelId, body);
    expect([foreign.status(), (await foreign.json()).code]).toEqual([404, 'HOTEL_NOT_FOUND']);
    for (const headers of [
      { origin: 'https://evil.example' },
      { 'sec-fetch-site': 'cross-site' },
    ] as Record<string, string>[]) {
      const res = await save(hotelId, body, headers);
      expect([res.status(), (await res.json()).code]).toEqual([403, 'CSRF_REJECTED']);
    }
    const extra = await save(hotelId, { ...body, profile: { ...body.profile, name: 'Jiný' } });
    expect([extra.status(), (await extra.json()).code]).toEqual([400, 'INVALID_REQUEST']);
    const big = await save(hotelId, { ...body, padding: 'x'.repeat(9 * 1024) });
    expect([big.status(), (await big.json()).code]).toEqual([413, 'REQUEST_TOO_LARGE']);
    expect((await stubState(page)).profileSaves).toBe(0);

    // The profile save is JSON with the script-free policy, never cached.
    const stale = await save(hotelId, body);
    expect(stale.status()).toBe(409);
    expect(stale.headers()['cache-control']).toBe('no-store');
    expect(stale.headers()['content-security-policy']).toContain("default-src 'none'");

    await page.context().clearCookies();
    const anonymous = await save(hotelId, body);
    expect([anonymous.status(), (await anonymous.json()).code]).toEqual([401, 'UNAUTHENTICATED']);
  });
});
