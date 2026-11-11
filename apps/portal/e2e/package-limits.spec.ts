import { expect, test, type APIRequestContext, type Browser, type Page } from '@playwright/test';

/**
 * Packages in transfer are limited (review of #178, #169 sprint 6798102589): at most one per portal
 * account and PORTAL_PACKAGE_MAX_IN_FLIGHT in portal-web (2 in this test server), on slots of their
 * own — a held package never takes a PDF's. A refused package is PACKAGE_BUSY before any byte; the
 * slot is free again once the body has been pulled (here: when the stub releases it).
 *
 * The package requests are Node's fetch with the browser's cookie (each its own connection; the
 * answer as soon as its headers arrive, the body read only when asked).
 */
const BASE = 'http://localhost:3300';
const STUB = 'http://127.0.0.1:4301';
const PERIOD = '/invoices/package?from=2026-09&to=2026-10';
const control = (r: APIRequestContext, body: Record<string, unknown>) =>
  r.post(`${STUB}/__control`, { data: body });
const stubState = async (r: APIRequestContext) =>
  (await (await r.get(`${STUB}/__state`)).json()) as {
    heldPackages: number;
    invoices: { id: string }[];
  };

async function signIn(page: Page, account?: 'second' | 'third') {
  if (account) await control(page.request, { nextAccount: account });
  await page.goto('/login');
  await page.locator('[name=email]').fill('recepce@hotel-e2e.test');
  await page.locator('[name=password]').fill('Dlouhe portalove heslo 2026');
  await page.getByRole('button', { name: 'Pokračovat' }).click();
  await page.locator('[name=code]').fill('123456');
  await page.getByRole('button', { name: 'Přihlásit' }).click();
  await expect(page.getByRole('heading', { name: 'Moje hotely' })).toBeVisible();
}
async function account(browser: Browser, which?: 'second' | 'third') {
  const context = await browser.newContext();
  const page = await context.newPage();
  await signIn(page, which);
  const cookie = (await context.cookies()).map((c) => `${c.name}=${c.value}`).join('; ');
  return { context, cookie };
}
const get = (path: string, cookie: string) =>
  fetch(`${BASE}${path}`, {
    headers: { cookie },
    redirect: 'manual',
    signal: AbortSignal.timeout(30_000),
  });
async function packageOf(cookie: string) {
  const r = await get(PERIOD, cookie);
  await r.arrayBuffer();
  return { status: r.status, location: r.headers.get('location') };
}
/** A package that stays in transfer (its body held by the stub): headers received, body unread. */
async function startHeld(r: APIRequestContext, cookie: string) {
  const before = (await stubState(r)).heldPackages;
  const response = await get(PERIOD, cookie);
  expect(response.status).toBe(200);
  await expect.poll(async () => (await stubState(r)).heldPackages).toBe(before + 1);
  return response;
}
const BUSY = { status: 303, location: expect.stringMatching(/balicek=PACKAGE_BUSY/) };

test.describe('hotel portal: packages in transfer are limited per account and in total', () => {
  test.afterEach(async ({ request }) => {
    await control(request, { releasePackages: true, packageMode: 'ok', nextAccount: null });
  });

  test('one per account, two in total, PDFs unaffected; free again after the transfer', async ({
    browser,
    request,
  }) => {
    test.skip(test.info().project.name !== 'desktop-1440', 'one width is enough');
    const a = await account(browser);
    const b = await account(browser, 'second');
    const c = await account(browser, 'third');
    await control(request, { packageMode: 'hold' });

    const aHeld = await startHeld(request, a.cookie);
    // The same account again: refused at once, before any byte.
    expect(await packageOf(a.cookie)).toEqual(BUSY);
    // …while its PDF still downloads (the package has its own slots).
    const pdf = await get(`/invoices/${(await stubState(request)).invoices[0]!.id}/pdf`, a.cookie);
    expect(pdf.status).toBe(200);
    expect(pdf.headers.get('content-type')).toBe('application/pdf');
    await pdf.arrayBuffer();

    // Another account: its own package is admitted (the second slot)…
    const bHeld = await startHeld(request, b.cookie);
    // …a third account finds both taken: refused.
    expect(await packageOf(c.cookie)).toEqual(BUSY);

    // The bodies arrive: the slots are free again; every account gets its package.
    await control(request, { releasePackages: true, packageMode: 'ok' });
    expect((await aHeld.arrayBuffer()).byteLength).toBeGreaterThan(64 * 1024);
    expect((await bHeld.arrayBuffer()).byteLength).toBeGreaterThan(64 * 1024);
    await expect.poll(async () => (await packageOf(a.cookie)).status).toBe(200);
    expect((await packageOf(c.cookie)).status).toBe(200);
    for (const x of [a, b, c]) await x.context.close();
  });

  test('pulled is not delivered: a 2 MB package keeps its account’s slot for 2 MB at 1 MB/s', async ({
    browser,
    request,
  }) => {
    test.skip(test.info().project.name !== 'desktop-1440', 'one width is enough');
    const a = await account(browser);
    await control(request, { packageMode: 'big' });
    const started = Date.now();
    const first = await get(PERIOD, a.cookie);
    expect(first.status).toBe(200);
    expect((await first.arrayBuffer()).byteLength).toBe(2_000_000);
    // All its bytes have left portal-web, yet the account's slot is held for ~2 s.
    expect(await packageOf(a.cookie)).toEqual(BUSY);
    await expect.poll(async () => (await packageOf(a.cookie)).status, { timeout: 5_000 }).toBe(200);
    expect(Date.now() - started).toBeGreaterThanOrEqual(1_900);
    await a.context.close();
  });
});
