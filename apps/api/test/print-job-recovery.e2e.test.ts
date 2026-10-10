import type { LabelPrintJob, LabelTemplateVersion } from '@ayvo/types';
import { readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { STALE_GENERATION_MS } from '../src/label-production/label-print-jobs.service.js';
import { createTemplate, registerBottles } from './support/fixtures.js';
import { createTestApp, hasDatabase, type TestApp } from './support/test-app.js';

/** Failure and recovery paths of print-job rendering and stored files. */
describe.skipIf(!hasDatabase)('print job recovery', () => {
  let t: TestApp;
  let version: LabelTemplateVersion;
  beforeAll(async () => {
    t = await createTestApp();
    version = await createTemplate(t.app);
  });
  afterAll(() => t?.close());

  const http = () => request(t.app.getHttpServer());
  const generate = (code: string) => http().post(`/api/admin/label-print-jobs/${code}/generate`);

  it('a failed PDF write never marks the job COMPLETED; a retry recovers with the same items', async () => {
    const { printJob } = await registerBottles(t.app, version.versionId, 3);
    const itemsBefore = await t.prisma.labelPrintJobItem.findMany({
      where: { printJob: { code: printJob!.code } },
      orderBy: { position: 'asc' },
    });

    t.storage.failPutsRemaining = 1;
    const failed = (await generate(printJob!.code).expect(200)).body as LabelPrintJob;
    expect(failed).toMatchObject({ status: 'FAILED', downloadUrl: null, fileByteSize: null });
    expect(JSON.stringify(failed)).not.toMatch(/ENOSPC|\/var\/lib/);
    const row = await t.prisma.labelPrintJob.findUniqueOrThrow({ where: { code: printJob!.code } });
    expect(row.fileStorageKey).toBeNull();

    const done = (await generate(printJob!.code).expect(200)).body as LabelPrintJob;
    expect(done).toMatchObject({ status: 'COMPLETED', attempts: 2 });
    const itemsAfter = await t.prisma.labelPrintJobItem.findMany({
      where: { printJob: { code: printJob!.code } },
      orderBy: { position: 'asc' },
    });
    expect(itemsAfter).toEqual(itemsBefore);
  });

  it('a superseded (reclaimed) attempt cannot overwrite the newer outcome', async () => {
    const { printJob } = await registerBottles(t.app, version.versionId, 1);
    let release!: () => void;
    t.renderer.gate = new Promise<void>((resolve) => (release = resolve));
    t.renderer.failuresRemaining = 0;

    // Attempt 1 starts and hangs inside the renderer.
    const slow = generate(printJob!.code).then((r) => r);
    await new Promise((r) => setTimeout(r, 200));
    // It is considered abandoned once STALE_GENERATION_MS has passed (simulated in the DB).
    await t.prisma.labelPrintJob.update({
      where: { code: printJob!.code },
      data: { startedAt: new Date(Date.now() - STALE_GENERATION_MS - 1000) },
    });
    // Attempt 2 reclaims and completes.
    const second = (await generate(printJob!.code).expect(200)).body as LabelPrintJob;
    expect(second).toMatchObject({ status: 'COMPLETED', attempts: 2 });

    // Attempt 1 now fails late: it must not turn the COMPLETED job into FAILED.
    t.renderer.failuresRemaining = 1;
    release();
    await slow;
    const final = await t.prisma.labelPrintJob.findUniqueOrThrow({
      where: { code: printJob!.code },
    });
    expect(final).toMatchObject({ status: 'COMPLETED', attempts: 2 });
    t.renderer.failuresRemaining = 0;
  });

  it('a missing stored file gives a stable, safe 404 (no paths)', async () => {
    const { printJob } = await registerBottles(t.app, version.versionId, 1);
    const done = (await generate(printJob!.code).expect(200)).body as LabelPrintJob;
    const row = await t.prisma.labelPrintJob.findUniqueOrThrow({ where: { code: done.code } });
    await rm(join(t.storage.directory, row.fileStorageKey!));
    const res = await http().get(done.downloadUrl!).expect(404);
    expect(res.body).toEqual({
      statusCode: 404,
      error: 'Not Found',
      message: 'The stored file is not available',
    });

    const artwork = await t.prisma.labelArtwork.findUniqueOrThrow({
      where: { id: version.artwork.id },
    });
    await rm(join(t.storage.directory, artwork.storageKey));
    const art = await http().get(version.artwork.contentUrl).expect(404);
    expect(JSON.stringify(art.body)).not.toMatch(/label-artworks|\/tmp|\.svg/);
  });

  it('leaves no temporary files behind in storage', async () => {
    const all: string[] = [];
    const stack = [t.storage.directory];
    while (stack.length) {
      const dir = stack.pop()!;
      for (const e of await readdir(dir, { withFileTypes: true })) {
        if (e.isDirectory()) stack.push(join(dir, e.name));
        else all.push(e.name);
      }
    }
    expect(all.filter((n) => n.endsWith('.tmp'))).toEqual([]);
  });
});
