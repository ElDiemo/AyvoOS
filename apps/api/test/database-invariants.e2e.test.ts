import type { LabelTemplateVersion } from '@ayvo/types';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PRODUCTION_QR_BASE_URL } from '../src/common/qr-policy.js';
import { createTemplate, registerBottles } from './support/fixtures.js';
import { createTestApp, hasDatabase, type TestApp, withPrivileged } from './support/test-app.js';
import { INITIAL_SITE_ID } from './support/sign-in.js';

/**
 * Invariants enforced by PostgreSQL itself (migration CHECKs, unique indexes, triggers),
 * exercised with direct writes that bypass the application.
 */
describe.skipIf(!hasDatabase)('database invariants', () => {
  let t: TestApp;
  let version: LabelTemplateVersion;
  let batchId: string;
  beforeAll(async () => {
    t = await createTestApp();
    version = await createTemplate(t.app);
    const { batch } = await registerBottles(t.app, version.versionId, 2);
    batchId = (
      await t.prisma.bottleCreationBatch.findUniqueOrThrow({ where: { code: batch.code } })
    ).id;
  });
  afterAll(() => t?.close());

  const sql = (query: string) => t.prisma.$executeRawUnsafe(query);

  it.each(['short', 'A'.repeat(23), 'has space aaaaaaaaaaaaa', 'bad/char+aaaaaaaaaaaaa'])(
    'rejects public token %s (22 URL-safe characters required)',
    async (token) => {
      await expect(
        t.prisma.bottle.create({
          data: {
            serial: 900_000n,
            code: 'AYV-B-900000',
            publicToken: token,
            status: 'CREATED',
            creationBatchId: batchId,
            siteId: INITIAL_SITE_ID,
          },
        }),
      ).rejects.toThrow();
    },
  );

  it('rejects a bottle code that does not match its serial, and duplicate codes or tokens', async () => {
    const existing = await t.prisma.bottle.findFirstOrThrow();
    const base = { status: 'CREATED' as const, creationBatchId: batchId, siteId: INITIAL_SITE_ID };
    await expect(
      t.prisma.bottle.create({
        data: { ...base, serial: 900_001n, code: 'AYV-B-900002', publicToken: 'B'.repeat(22) },
      }),
    ).rejects.toThrow();
    await expect(
      t.prisma.bottle.create({
        data: {
          ...base,
          serial: existing.serial,
          code: existing.code,
          publicToken: 'C'.repeat(22),
        },
      }),
    ).rejects.toThrow();
    await expect(
      t.prisma.bottle.create({
        data: {
          ...base,
          serial: 900_003n,
          code: 'AYV-B-900003',
          publicToken: existing.publicToken,
        },
      }),
    ).rejects.toThrow();
  });

  it.each([0, 1001])('rejects a creation batch of %i bottles', async (quantity) => {
    await expect(
      t.prisma.bottleCreationBatch.create({
        data: {
          serial: 900_000n + BigInt(quantity),
          code: `BC-${900_000 + quantity}`,
          quantityRequested: quantity,
          siteId: INITIAL_SITE_ID,
          quantityCreated: quantity,
          labelTemplateVersionId: version.versionId,
          firstBottleSerial: 1n,
          lastBottleSerial: BigInt(quantity),
        },
      }),
    ).rejects.toThrow();
  });

  it('keeps QR elements square and inside the label', async () => {
    const insert = (x: number, y: number, w: number, h: number, position: number) =>
      t.prisma.labelTemplateElement.create({
        data: {
          versionId: version.versionId,
          type: 'QR_CODE',
          position,
          xMm: x,
          yMm: y,
          widthMm: w,
          heightMm: h,
        },
      });
    await expect(insert(60, 10, 15, 15, 10)).rejects.toThrow(); // beyond the 70 mm width
    await expect(insert(10, 100, 15, 15, 11)).rejects.toThrow(); // beyond the 110 mm height
    await expect(insert(10, 10, 15, 16, 12)).rejects.toThrow(); // not square
    await expect(insert(-1, 10, 15, 15, 13)).rejects.toThrow(); // negative
  });

  it('rejects updates and deletes of immutable and append-only records', async () => {
    const bottle = await t.prisma.bottle.findFirstOrThrow({ include: { events: true } });
    const job = await t.prisma.labelPrintJob.findFirstOrThrow({ include: { items: true } });
    await expect(
      sql(`UPDATE bottle_events SET payload = '{"x":1}' WHERE id = '${bottle.events[0]!.id}'`),
    ).rejects.toThrow();
    await expect(
      sql(`DELETE FROM bottle_events WHERE id = '${bottle.events[0]!.id}'`),
    ).rejects.toThrow();
    await expect(
      sql(
        `UPDATE bottle_creation_batches SET quantity_created = quantity_created WHERE id = '${batchId}'`,
      ),
    ).rejects.toThrow();
    await expect(
      sql(
        `UPDATE label_template_versions SET created_at = now() WHERE id = '${version.versionId}'`,
      ),
    ).rejects.toThrow();
    await expect(
      sql(`UPDATE label_print_job_items SET position = position WHERE print_job_id = '${job.id}'`),
    ).rejects.toThrow();
    await expect(sql(`DELETE FROM label_print_jobs WHERE id = '${job.id}'`)).rejects.toThrow();
    await expect(
      sql(`UPDATE label_print_jobs SET qr_error_correction = 'L' WHERE id = '${job.id}'`),
    ).rejects.toThrow();
  });

  it('never removes a referenced template version, its artwork or its template', async () => {
    await expect(
      sql(`DELETE FROM label_template_versions WHERE id = '${version.versionId}'`),
    ).rejects.toThrow();
    await expect(
      sql(`DELETE FROM label_artworks WHERE id = '${version.artwork.id}'`),
    ).rejects.toThrow();
    await expect(
      sql(`DELETE FROM label_templates WHERE id = '${version.templateId}'`),
    ).rejects.toThrow();
    // Even the privileged account (the running core has no TRUNCATE right at all).
    await withPrivileged((db) =>
      expect(db.$executeRawUnsafe('TRUNCATE label_template_versions CASCADE')).rejects.toThrow(),
    );
  });

  it('enforces the DEV/production QR host rule by parsed host, like the application policy', async () => {
    const insertJob = (serial: number, env: 'development' | 'production', base: string) =>
      t.prisma.labelPrintJob.create({
        data: {
          serial: BigInt(serial),
          code: `PJ-${serial}`,
          creationBatchId: batchId,
          siteId: INITIAL_SITE_ID,
          labelTemplateVersionId: version.versionId,
          labelCount: 1,
          qrErrorCorrection: 'Q',
          appEnvironment: env,
          publicBaseUrl: base,
        },
      });
    let serial = 950_000;
    for (const base of [
      PRODUCTION_QR_BASE_URL,
      'http://QR.ayvo.co',
      'https://user@qr.ayvo.co/q',
      'https://qr.ayvo.co:8443',
      'https://qr.ayvo.co.',
      'https://eu.qr.ayvo.co',
    ]) {
      await expect(insertJob(serial++, 'development', base), base).rejects.toThrow();
    }
    await expect(insertJob(serial++, 'production', 'https://dev.ayvo.co/q')).rejects.toThrow();
    // Allowed: correct pairs and look-alike non-production hosts.
    await insertJob(serial++, 'production', PRODUCTION_QR_BASE_URL);
    await insertJob(serial++, 'development', 'https://dev.ayvo.co/q');
    await insertJob(serial++, 'development', 'https://qr.ayvo.com');
    const hosts = await t.prisma.$queryRaw<{ h: string }[]>`
      SELECT ayvo_url_host('https://User:pw@QR.Ayvo.Co.:443/q?x') AS h`;
    expect(hosts[0]!.h).toBe('qr.ayvo.co');
  });
});
