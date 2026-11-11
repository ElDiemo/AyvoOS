import { expect, test, type APIRequestContext, type Browser, type Page } from '@playwright/test';

/**
 * Package starts limited in time (review 6800881871; owner 2026-11-11: a package is fetched about
 * once or twice a month), on the second test server with the default quotas (one start per account
 * per 10 minutes, 4 a day, 30 a day in total): a second start of the same account is refused at
 * once with its reason and no request reaches Finance; a refused period (no invoices) costs no
 * start; another account is not affected; single PDFs are never limited by it.
 */
const QUOTA = 'http://localhost:3301';
const STUB = 'http://127.0.0.1:4301';
const control = (r: APIRequestContext, body: Record<string, unknown>) =>
  r.post(`${STUB}/__control`, { data: body });
const stubState = async (r: APIRequestContext) =>
  (await (await r.get(`${STUB}/__state`)).json()) as {
    invoices: { id: string }[];
    packageRequests: number;
  };

async function account(browser: Browser, which?: 'second' | 'third') {
  const context = await browser.newContext();
  const page: Page = await context.newPage();
  if (which) await control(page.request, { nextAccount: which });
  // Signed in on the main test server (the stub's CSRF origin); the cookie is the same session.
  await page.goto('/login');
  await page.locator('[name=email]').fill('recepce@hotel-e2e.test');
  await page.locator('[name=password]').fill('Dlouhe portalove heslo 2026');
  await page.getByRole('button', { name: 'Pokračovat' }).click();
  await page.locator('[name=code]').fill('123456');
  await page.getByRole('button', { name: 'Přihlásit' }).click();
  await expect(page.getByRole('heading', { name: 'Moje hotely' })).toBeVisible();
  const cookie = (await context.cookies()).map((c) => `${c.name}=${c.value}`).join('; ');
  return { context, cookie };
}
const get = (path: string, cookie: string) =>
  fetch(`${QUOTA}${path}`, { headers: { cookie }, redirect: 'manual' });
async function packageOf(cookie: string, period = 'from=2026-09&to=2026-10') {
  const r = await get(`/invoices/package?${period}`, cookie);
  const body = await r.arrayBuffer();
  return { status: r.status, location: r.headers.get('location'), bytes: body.byteLength };
}

test.describe('hotel portal: package starts limited per account and day', () => {
  test.afterEach(async ({ request }) => {
    await control(request, { packageMode: 'ok', nextAccount: null });
  });

  test('a second start within 10 minutes is refused before Finance; a refusal costs nothing; others unaffected', async ({
    browser,
    request,
  }) => {
    test.skip(test.info().project.name !== 'desktop-1440', 'one width is enough');
    const a = await account(browser);
    const b = await account(browser, 'second');

    // A period without invoices: refused by Finance, the start is given back.
    await control(request, { packageMode: 'empty' });
    expect(await packageOf(a.cookie)).toMatchObject({
      status: 303,
      location: expect.stringMatching(/balicek=NO_INVOICES/),
    });
    await control(request, { packageMode: 'ok' });

    // The first real package: delivered.
    const first = await packageOf(a.cookie);
    expect(first.status).toBe(200);
    expect(first.bytes).toBeGreaterThan(0);

    // Again at once: refused with its reason, nothing reaches Finance.
    const before = (await stubState(request)).packageRequests;
    expect(await packageOf(a.cookie)).toMatchObject({
      status: 303,
      location: expect.stringMatching(/balicek=PACKAGE_RATE/),
      bytes: 0,
    });
    expect((await stubState(request)).packageRequests).toBe(before);

    // Another account starts its own; the first account's single PDFs still download.
    expect((await packageOf(b.cookie)).status).toBe(200);
    const pdf = await get(`/invoices/${(await stubState(request)).invoices[0]!.id}/pdf`, a.cookie);
    expect(pdf.status).toBe(200);
    await pdf.arrayBuffer();

    // The reason is shown on "Faktury" in words.
    const page = await a.context.newPage();
    await page.goto(`${QUOTA}/invoices?balicek=PACKAGE_RATE`);
    await expect(page.getByText(/nejdříve za 10 minut/)).toBeVisible();
    for (const x of [a, b]) await x.context.close();
  });

  test('switched off (the first PROD release): no package on "Faktury", its route 404, PDFs work', async ({
    browser,
    request,
  }) => {
    test.skip(test.info().project.name !== 'desktop-1440', 'one width is enough');
    const OFF = 'http://localhost:3302';
    const a = await account(browser);
    const page = await a.context.newPage();
    await page.goto(`${OFF}/invoices`);
    await expect(page.getByRole('heading', { name: 'Faktury' })).toBeVisible();
    await expect(page.getByTestId('invoice-package')).toHaveCount(0);
    const before = (await stubState(request)).packageRequests;
    const r = await fetch(`${OFF}/invoices/package?from=2026-09&to=2026-10`, {
      headers: { cookie: a.cookie },
      redirect: 'manual',
    });
    expect(r.status).toBe(404);
    expect((await stubState(request)).packageRequests).toBe(before);
    const pdf = await fetch(`${OFF}/invoices/${(await stubState(request)).invoices[0]!.id}/pdf`, {
      headers: { cookie: a.cookie },
    });
    expect(pdf.status).toBe(200);
    expect(pdf.headers.get('content-type')).toBe('application/pdf');
    await pdf.arrayBuffer();
    await a.context.close();
  });
});
