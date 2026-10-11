import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { expect, test, type APIRequestContext, type Page } from '@playwright/test';

/**
 * Route and layout hardening of the Bottles module: long values never widen the page, legacy
 * URLs are real HTTP redirects, unknown codes are real 404s. Self-contained: creates its own
 * template (with the longest possible name) and a small series through the API.
 */
test.describe.configure({ mode: 'serial' });

// 64 characters, no hyphen or space: no natural line-break opportunity anywhere.
const LONG_NAME = `long_template_name_${Date.now()}`.padEnd(64, 'x');

let templateId: string;
let versionId: string;
let batchCode: string;
let bottleCode: string;
let printJobCode: string;

async function json<T>(res: Awaited<ReturnType<APIRequestContext['get']>>): Promise<T> {
  expect(res.ok(), `${res.url()} -> ${res.status()}`).toBe(true);
  return (await res.json()) as T;
}

test.beforeAll(async ({ request }) => {
  const artwork = await json<{ id: string }>(
    await request.post('/api/admin/label-artworks', {
      multipart: {
        file: {
          name: 'mydlo1.svg',
          mimeType: 'image/svg+xml',
          buffer: await readFile(resolve(import.meta.dirname, 'fixtures/mydlo1.svg')),
        },
      },
    }),
  );
  const version = await json<{ templateId: string; versionId: string }>(
    await request.post('/api/admin/label-templates', {
      data: {
        name: LONG_NAME,
        layout: {
          artworkId: artwork.id,
          widthMm: 70,
          heightMm: 110,
          elements: [
            { type: 'QR_CODE', xMm: 27.5, yMm: 70, widthMm: 15, heightMm: 15, rotationDeg: 0 },
          ],
        },
      },
    }),
  );
  templateId = version.templateId;
  versionId = version.versionId;
  const registration = await json<{
    batch: { code: string; firstBottleCode: string };
    printJob: { code: string };
  }>(
    await request.post('/api/admin/bottle-registrations', {
      data: { requestId: crypto.randomUUID(), labelTemplateVersionId: versionId, quantity: 2 },
    }),
  );
  batchCode = registration.batch.code;
  bottleCode = registration.batch.firstBottleCode;
  printJobCode = registration.printJob.code;
  const job = await json<{ status: string }>(
    await request.post(`/api/admin/label-print-jobs/${printJobCode}/generate`),
  );
  expect(job.status).toBe('COMPLETED');
});

/** Waits for the settled layout (e.g. the designer sizes itself after a ResizeObserver tick). */
async function expectNoHorizontalOverflow(page: Page, what: string) {
  await expect
    .poll(
      () =>
        page.evaluate(
          () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
        ),
      { message: `horizontal overflow on ${what}`, timeout: 3_000 },
    )
    .toBeLessThanOrEqual(0);
}

test('long template names wrap: no horizontal page scroll at 320, 390, tablet and desktop', async ({
  page,
}) => {
  const paths = [
    '/label-templates',
    `/label-templates/${templateId}`,
    `/label-templates/${templateId}/new-version`,
    '/bottles',
    '/bottles/history',
    `/batches/${batchCode}`,
    `/bottles/${bottleCode}`,
  ];
  for (const width of [320, 390, 820, 1280]) {
    await page.setViewportSize({ width, height: 900 });
    for (const path of paths) {
      await page.goto(path);
      await expectNoHorizontalOverflow(page, `${path} at ${width}px`);
    }
    // The create workflow up to its review step (nothing is created).
    await page.goto(`/bottles/new?version=${versionId}`);
    await page.getByLabel('1 · Number of bottles').fill('2');
    await page.getByRole('button', { name: 'Review' }).click();
    await expect(page.getByTestId('create-confirmation')).toContainText(LONG_NAME);
    await expectNoHorizontalOverflow(page, `create review at ${width}px`);
  }
  // The long name is shown in full (wrapped), not cut off.
  await page.setViewportSize({ width: 320, height: 900 });
  await page.goto(`/batches/${batchCode}`);
  await expect(page.getByTestId(`print-job-${printJobCode}`)).toContainText(`${LONG_NAME} v1`);
});

test('legacy batch list URL is a real HTTP redirect that keeps the query', async ({
  request,
  browser,
}) => {
  for (const [from, to] of [
    ['/batches', '/bottles/history'],
    ['/batches?page=2', '/bottles/history?page=2'],
  ] as const) {
    const res = await request.get(from, { maxRedirects: 0 });
    expect(res.status(), from).toBe(307);
    expect(res.headers()['location'], from).toBe(to);
  }

  // Without client JavaScript: the HTTP redirect alone gets the browser there.
  const context = await browser.newContext({ javaScriptEnabled: false });
  const page = await context.newPage();
  const response = await page.goto('/batches?page=1');
  const hop = await response!.request().redirectedFrom()!.response();
  expect(hop?.status()).toBe(307);
  expect(response?.status()).toBe(200);
  expect(page.url()).toMatch(/\/bottles\/history\?page=1$/);
  await context.close();
});

test('unknown or malformed codes answer a real 404 with the friendly page', async ({ request }) => {
  const missing = [
    '/bottles/AYV-B-999999',
    '/bottles/null',
    '/batches/BC-999999',
    '/batches/nonsense',
    '/label-templates/00000000-0000-4000-8000-000000000000',
    '/label-templates/not-a-uuid',
    '/label-templates/00000000-0000-4000-8000-000000000000/new-version',
  ];
  for (const path of missing) {
    const res = await request.get(path);
    expect(res.status(), path).toBe(404);
    const body = await res.text();
    expect(body, path).toContain('Not found');
    expect(body, path).not.toMatch(/ApiError|stack|ECONNREFUSED|API 40\d/);
  }

  // Valid pages are unaffected.
  for (const path of [
    '/',
    '/bottles',
    '/bottles/history',
    '/bottles/new',
    '/label-templates',
    `/label-templates/${templateId}`,
    `/batches/${batchCode}`,
    `/bottles/${bottleCode}`,
  ]) {
    expect((await request.get(path)).status(), path).toBe(200);
  }
});

test('label PDF and public passport still work', async ({ request, page }) => {
  const pdf = await request.get(`/api/admin/label-print-jobs/${printJobCode}/pdf`);
  expect(pdf.status()).toBe(200);
  expect(pdf.headers()['content-type']).toContain('application/pdf');
  expect((await pdf.body()).subarray(0, 4).toString()).toBe('%PDF');

  const bottle = await json<{ publicUrl: string }>(
    await request.get(`/api/admin/bottles/${bottleCode}`),
  );
  expect(bottle.publicUrl).toMatch(/^http:\/\/localhost:3100\/q\/[A-Za-z0-9_-]{22}$/);
  const passport = await page.goto(bottle.publicUrl);
  expect(passport?.status()).toBe(200);
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(`Bottle ${bottleCode}`);
  await expect(page.locator('body')).not.toContainText('qr.ayvo.co');
});
