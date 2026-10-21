import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { expect, type APIRequestContext, type Page } from '@playwright/test';

/** Shared setup of the dispatch specs (printing, tracking): synthetic data only. */

type Res = Awaited<ReturnType<APIRequestContext['get']>>;
export async function json<T>(res: Res): Promise<T> {
  expect(res.ok(), `${res.url()} -> ${res.status()} ${await res.text()}`).toBe(true);
  return (await res.json()) as T;
}

export async function noOverflow(page: Page) {
  await expect
    .poll(() =>
      page.evaluate(
        () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
      ),
    )
    .toBeLessThanOrEqual(0);
}

export async function printedBottles(request: APIRequestContext, name: string, n: number) {
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
  const version = await json<{ versionId: string }>(
    await request.post('/api/admin/label-templates', {
      data: {
        name,
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
  const reg = await json<{ batch: { firstBottleCode: string }; printJob: { code: string } }>(
    await request.post('/api/admin/bottle-registrations', {
      data: {
        requestId: crypto.randomUUID(),
        labelTemplateVersionId: version.versionId,
        quantity: n,
      },
    }),
  );
  await json(await request.post(`/api/admin/label-print-jobs/${reg.printJob.code}/generate`));
  const first = Number(reg.batch.firstBottleCode.slice(6));
  const urls: string[] = [];
  for (let i = 0; i < n; i++) {
    const code = `AYV-B-${String(first + i).padStart(6, '0')}`;
    urls.push(
      (await json<{ publicUrl: string }>(await request.get(`/api/admin/bottles/${code}`)))
        .publicUrl,
    );
  }
  return { versionId: version.versionId, urls };
}
export const measurement = (extra: Record<string, unknown>) => ({
  requestId: crypto.randomUUID(),
  measuredOn: '2026-10-15',
  method: 'Plošinová váha (E2E, syntetické)',
  correctionOf: null,
  correctionReason: null,
  ...extra,
});
