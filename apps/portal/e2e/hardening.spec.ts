import { request as httpRequest } from 'node:http';
import { expect, test, type Page } from '@playwright/test';

/**
 * Review 5818694161 in the real Next.js server (next start) against the synthetic contracts:
 * the page CSP with a nonce per answer, input limits on the public sign-in steps (the request
 * body reaches the route as a stream — no proxy buffers it), a truthful sign-out, and Finance's
 * PDF headers checked.
 */
const STUB = 'http://127.0.0.1:4301';
const email = 'recepce@hotel-e2e.test';
const password = 'Dlouhe portalove heslo 2026';
const control = (page: Page, body: Record<string, unknown>) =>
  page.request.post(`${STUB}/__control`, { data: body });
const stubState = async (page: Page) =>
  (await (await page.request.get(`${STUB}/__state`)).json()) as {
    coreCalls: number;
    sessions: number;
    invoices: { id: string }[];
  };

/** Collects every CSP violation the page reports. */
async function watchCsp(page: Page) {
  const violations: string[] = [];
  page.on('console', (m) => {
    if (/Content Security Policy/i.test(m.text())) violations.push(m.text());
  });
  await page.addInitScript(() => {
    document.addEventListener('securitypolicyviolation', (e) => {
      console.error(`Content Security Policy violation: ${e.violatedDirective} ${e.blockedURI}`);
    });
  });
  return violations;
}

async function signIn(page: Page) {
  await page.goto('/login');
  await page.locator('[name=email]').fill(email);
  await page.locator('[name=password]').fill(password);
  await page.getByRole('button', { name: 'Pokračovat' }).click();
  await page.locator('[name=code]').fill('123456');
  await page.getByRole('button', { name: 'Přihlásit' }).click();
  await expect(page.getByRole('heading', { name: 'Moje hotely' })).toBeVisible();
}

/** A raw POST that sends its body in pieces (chunked, no Content-Length), as any HTTP client can. */
function trickle(path: string, pieces: number, size: number, everyMs: number) {
  return new Promise<{ status: number; body: string; ms: number }>((resolve, reject) => {
    const started = Date.now();
    const req = httpRequest(
      {
        host: 'localhost',
        port: 3300,
        path,
        method: 'POST',
        headers: {
          origin: 'http://localhost:3300',
          'content-type': 'application/json',
          'transfer-encoding': 'chunked',
        },
      },
      (res) => {
        let body = '';
        res.on('data', (c) => (body += c));
        res.on('end', () => {
          clearInterval(timer);
          req.destroy();
          resolve({ status: res.statusCode ?? 0, body, ms: Date.now() - started });
        });
      },
    );
    req.on('error', (e) => (e.message.includes('EPIPE') ? undefined : reject(e)));
    let sent = 0;
    const timer = setInterval(() => {
      if (sent++ >= pieces) {
        clearInterval(timer);
        req.end();
      } else if (!req.destroyed) req.write(Buffer.alloc(size, 0x20));
    }, everyMs);
  });
}

test.describe('portal-web hardening (review 5818694161)', () => {
  test.afterEach(async ({ page }) => {
    await control(page, { financeDown: false, logoutMode: 'ok', pdfMode: 'ok' });
  });

  test('CSP: a nonce per answer, no unsafe-inline; Next.js scripts carry it', async ({ page }) => {
    const a = await page.request.get('/login');
    const b = await page.request.get('/login');
    const csp = [a, b].map((r) => r.headers()['content-security-policy']!);
    const nonces = csp.map((c) => /'nonce-([A-Za-z0-9+/=]+)'/.exec(c)?.[1]);
    expect(nonces[0]).toBeTruthy();
    expect(nonces[0]).not.toBe(nonces[1]);
    for (const c of csp) {
      expect(c).toContain("script-src 'self' 'nonce-");
      expect(c).toContain("'strict-dynamic'");
      expect(c).toContain("frame-ancestors 'none'");
      expect(c).toContain("form-action 'self'");
      expect(c).toContain("object-src 'none'");
      expect(c).not.toContain('unsafe-inline');
      expect(c).not.toContain('unsafe-eval');
    }
    const html = await a.text();
    const scripts = html.match(/<script\b[^>]*>/g) ?? [];
    expect(scripts.length).toBeGreaterThan(0);
    for (const tag of scripts) expect(tag).toContain(`nonce="${nonces[0]}"`);
    // The JSON steps and the PDF run no script at all.
    const step = await page.request.post('/auth/password', {
      headers: { origin: 'http://localhost:3300' },
      data: {},
    });
    expect(step.headers()['content-security-policy']).toBe(
      "default-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
    );
  });

  test('CSP in the browser: activation, sign-in and the pages work with no violation', async ({
    page,
  }) => {
    const violations = await watchCsp(page);
    await page.goto(`/activate#token=${'A'.repeat(43)}`);
    await page.locator('[name=password]').fill(password);
    await page.getByRole('button', { name: 'Nastavit heslo' }).click();
    // The QR code (a data: image) is allowed by img-src.
    const qr = page.getByRole('img', { name: 'QR kód pro ověřovací aplikaci' });
    await expect(qr).toBeVisible();
    expect(await qr.evaluate((img: HTMLImageElement) => img.naturalWidth)).toBeGreaterThan(0);
    await page.locator('[name=code]').fill('123456');
    await page.getByRole('button', { name: 'Dokončit aktivaci' }).click();
    await page.getByRole('button', { name: 'Uloženo, pokračovat' }).click();
    await expect(page.getByTestId('portal-hotels')).toBeVisible();
    await page.getByRole('link', { name: 'Faktury' }).click();
    await expect(page.getByTestId('portal-invoices')).toBeVisible();
    await page.getByRole('button', { name: 'Odhlásit' }).click();
    await expect(page).toHaveURL(/\/login$/);
    await expect(page.getByRole('heading', { name: 'Přihlášení' })).toBeVisible();
    await signIn(page);
    expect(violations).toEqual([]);
  });

  test('a public step: a large body without Content-Length is refused and never reaches the core', async ({
    page,
  }) => {
    const before = (await stubState(page)).coreCalls;
    const r = await trickle('/auth/password', 64, 1024, 1);
    expect(r.status).toBe(413);
    expect(JSON.parse(r.body).code).toBe('REQUEST_TOO_LARGE');
    expect((await stubState(page)).coreCalls).toBe(before);
  });

  test('a public step: a trickling body is cut at 5 s, never reaches the core, and frees its slot', async ({
    page,
  }) => {
    const before = (await stubState(page)).coreCalls;
    const r = await trickle('/auth/password', 1000, 1, 250);
    expect(r.status).toBe(408);
    expect(r.ms).toBeGreaterThanOrEqual(4_800);
    expect(r.ms).toBeLessThan(8_000);
    expect((await stubState(page)).coreCalls).toBe(before);
    // The slot is free again: a normal sign-in works at once.
    await signIn(page);
  });

  test('sign-out with the core down: signed out here at once, the page says it is unfinished, the retry finishes it', async ({
    page,
  }) => {
    await signIn(page);
    const signedIn = (await stubState(page)).sessions;
    await control(page, { logoutMode: 'down' });
    await page.getByRole('button', { name: 'Odhlásit' }).click();
    await expect(page.getByTestId('logout-pending')).toContainText(
      'Odhlášení nebylo na serveru dokončeno',
    );
    // Local access ended, though the server still holds the session.
    expect((await stubState(page)).sessions).toBe(signedIn);
    await page.goto('/');
    await expect(page).toHaveURL(/\/login$/);
    await page.getByRole('button', { name: 'Dokončit odhlášení' }).click();
    await expect(page.getByTestId('logout-pending')).toContainText('zatím nepodařilo');
    await control(page, { logoutMode: 'ok' });
    await page.getByRole('button', { name: 'Dokončit odhlášení' }).click();
    await expect(page.getByTestId('logout-pending')).toHaveCount(0);
    expect((await stubState(page)).sessions).toBe(signedIn - 1);
    const cookies = (await page.context().cookies()).map((c) => c.name);
    expect(cookies).not.toContain('__Host-ayvo_portal');
    expect(cookies).not.toContain('__Host-ayvo_portal_out');
  });

  test('sign-out whose answer is lost after the core ended the session: unfinished, then confirmed by the retry', async ({
    page,
  }) => {
    await signIn(page);
    const signedIn = (await stubState(page)).sessions;
    await control(page, { logoutMode: 'lost' });
    await page.getByRole('button', { name: 'Odhlásit' }).click();
    await expect(page.getByTestId('logout-pending')).toBeVisible();
    expect((await stubState(page)).sessions).toBe(signedIn - 1);
    await control(page, { logoutMode: 'ok' });
    await page.getByRole('button', { name: 'Dokončit odhlášení' }).click();
    await expect(page.getByTestId('logout-pending')).toHaveCount(0);
  });

  test('the PDF: Finance announcing more than 10 MB is refused; an unexpected Content-Disposition is replaced', async ({
    page,
  }) => {
    await signIn(page);
    const { invoices } = await stubState(page);
    await control(page, { pdfMode: 'oversize' });
    expect((await page.request.get(`/invoices/${invoices[0]!.id}/pdf`)).status()).toBe(503);
    await control(page, { pdfMode: 'disposition' });
    const pdf = await page.request.get(`/invoices/${invoices[0]!.id}/pdf`);
    expect(pdf.status()).toBe(200);
    expect(pdf.headers()['content-disposition']).toBe('attachment');
    // The slots are free again.
    await control(page, { pdfMode: 'ok' });
    for (let i = 0; i < 3; i++)
      expect((await page.request.get(`/invoices/${invoices[0]!.id}/pdf`)).status()).toBe(200);
  });
});
