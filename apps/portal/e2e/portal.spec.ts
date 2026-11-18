import { expect, test, type Page } from '@playwright/test';

const STUB = 'http://127.0.0.1:4301';
const email = 'recepce@hotel-e2e.test';
const password = 'Dlouhe portalove heslo 2026';
const control = (page: Page, body: Record<string, unknown>) =>
  page.request.post(`${STUB}/__control`, { data: body });

async function signIn(page: Page) {
  await page.goto('/login');
  await page.locator('[name=email]').fill(email);
  await page.locator('[name=password]').fill(password);
  await page.getByRole('button', { name: 'Pokračovat' }).click();
  await page.locator('[name=code]').fill('123456');
  await page.getByRole('button', { name: 'Přihlásit' }).click();
  await expect(page.getByRole('heading', { name: 'Moje hotely' })).toBeVisible();
}

test.describe('hotel portal (portal-web)', () => {
  test.afterEach(async ({ page }) => {
    await control(page, { financeDown: false });
  });

  test('activation from the invitation link: password, TOTP enrolment, recovery codes, the portal', async ({
    page,
    context,
  }) => {
    await page.goto(`/activate#token=${'A'.repeat(43)}`);
    // The link's token leaves the address bar at once.
    await expect.poll(() => page.url()).not.toContain('#token');
    await page.locator('[name=password]').fill(password);
    await page.getByRole('button', { name: 'Nastavit heslo' }).click();
    await expect(page.getByRole('img', { name: 'QR kód pro ověřovací aplikaci' })).toBeVisible();
    await expect(page.getByTestId('setup-key')).toHaveText('JBSWY3DPEHPK3PXP');
    await page.locator('[name=code]').fill('123456');
    await page.getByRole('button', { name: 'Dokončit aktivaci' }).click();
    await expect(page.getByTestId('recovery-codes')).toContainText('aaaa-bbbb-cccc');
    await page.getByRole('button', { name: 'Uloženo, pokračovat' }).click();
    await expect(page.getByTestId('portal-hotels')).toContainText('Hotel Portál E2E');
    // The session cookie: __Host-, host-only, HttpOnly, Secure, SameSite=Strict, Path=/.
    const cookies = await context.cookies();
    const sessionCookie = cookies.find((c) => c.name === '__Host-ayvo_portal');
    expect(sessionCookie).toMatchObject({
      httpOnly: true,
      secure: true,
      sameSite: 'Strict',
      path: '/',
      domain: 'localhost',
    });
    expect(cookies.find((c) => c.name === '__Host-ayvo_portal_pre')).toBeUndefined();
  });

  test('sign-in, a hotel, the invoices (TEST, payment state), the PDF, a foreign id, sign-out', async ({
    page,
  }) => {
    await signIn(page);
    await page.getByRole('link', { name: 'Zobrazit profil: Hotel Portál E2E' }).click();
    await expect(page.getByTestId('portal-hotel-name')).toHaveText('Hotel Portál E2E');
    await expect(page.getByText('Portálová 1')).toBeVisible();

    await page.getByRole('link', { name: 'Faktury' }).click();
    const list = page.getByTestId('portal-invoices');
    await expect(list.locator('li')).toHaveCount(2);
    await expect(list).toContainText('TESTOVACÍ');
    await expect(list).toContainText('Uhrazená');
    await expect(list).toContainText('Neuhrazená');
    await expect(page.getByText('faktury jsou TESTOVACÍ')).toBeVisible();
    await list.getByRole('link', { name: 'T2026-00001' }).click();
    await expect(page.getByTestId('portal-invoice-number')).toContainText('T2026-00001');
    await expect(page.getByTestId('portal-invoice-state')).toHaveText('Uhrazená');

    const href = await page.getByRole('link', { name: 'Stáhnout PDF' }).getAttribute('href');
    const pdf = await page.request.get(href!);
    expect(pdf.status()).toBe(200);
    expect(pdf.headers()['content-type']).toBe('application/pdf');
    expect(pdf.headers()['cache-control']).toBe('private, no-store');
    expect(pdf.headers()['content-disposition']).toMatch(
      /^attachment; filename="T2026-00001\.pdf"$/,
    );
    expect(pdf.headers()['x-content-type-options']).toBe('nosniff');
    expect((await pdf.body()).subarray(0, 5).toString()).toBe('%PDF-');
    const download = page.waitForEvent('download');
    await page.getByRole('link', { name: 'Stáhnout PDF' }).click();
    expect((await download).suggestedFilename()).toBe('T2026-00001.pdf');

    // Another payer's invoice (or a made-up one): not found, exactly like a missing one.
    await page.goto(`/invoices/${crypto.randomUUID()}`);
    await expect(page.getByRole('heading', { name: 'Nenalezeno' })).toBeVisible();
    expect((await page.request.get(`/invoices/${crypto.randomUUID()}/pdf`)).status()).toBe(404);

    await page.goto('/');
    await page.getByRole('button', { name: 'Odhlásit' }).click();
    await expect(page.getByRole('heading', { name: 'Přihlášení' })).toBeVisible();
    await page.goto('/');
    await expect(page).toHaveURL(/\/login$/);
  });

  test('a wrong password or code is refused; no session without one', async ({ page }) => {
    await page.goto('/');
    await expect(page).toHaveURL(/\/login$/);
    await page.locator('[name=email]').fill(email);
    await page.locator('[name=password]').fill('Spatne heslo 123456');
    await page.getByRole('button', { name: 'Pokračovat' }).click();
    await expect(page.locator('form').getByRole('alert')).toHaveText(
      'Přihlášení se nezdařilo. Zkontrolujte údaje.',
    );
    await page.locator('[name=password]').fill(password);
    await page.getByRole('button', { name: 'Pokračovat' }).click();
    await page.locator('[name=code]').fill('000000');
    await page.getByRole('button', { name: 'Přihlásit' }).click();
    await expect(page.locator('form').getByRole('alert')).toContainText('Kód neplatí');
  });

  test('CSRF: a cross-site step is refused before it reaches the core; the core gets the browser request', async ({
    page,
  }) => {
    const evil = await page.request.post('/auth/password', {
      headers: { origin: 'https://evil.example' },
      data: { email, password },
    });
    expect([evil.status(), (await evil.json()).code]).toEqual([403, 'CSRF_REJECTED']);
    const crossSite = await page.request.post('/auth/password', {
      headers: { origin: 'http://localhost:3300', 'sec-fetch-site': 'cross-site' },
      data: { email, password },
    });
    expect(crossSite.status()).toBe(403);
    await signIn(page);
    const forwarded = (await (await page.request.get(`${STUB}/__state`)).json()).lastClient;
    expect(forwarded).toMatchObject({ origin: 'http://localhost:3300', ip: '127.0.0.1' });
  });

  test('Finance down: "Faktury nejsou dostupné", while "Moje hotely" keeps working', async ({
    page,
  }) => {
    await signIn(page);
    await control(page, { financeDown: true });
    await page.goto('/invoices');
    await expect(page.getByTestId('invoices-unavailable')).toHaveText(
      'Faktury nejsou dostupné. Zkuste to prosím později.',
    );
    await page.goto('/');
    await expect(page.getByTestId('portal-hotels')).toContainText('Hotel Portál E2E');
  });
});
