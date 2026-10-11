import { randomUUID } from 'node:crypto';
import type {
  BottleDetail,
  BottleListResponse,
  BottleRegistrationResponse,
  LabelTemplateVersion,
} from '@ayvo/types';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTemplate, registerBottles } from './support/fixtures.js';
import { createTestApp, hasDatabase, type TestApp } from './support/test-app.js';

describe.skipIf(!hasDatabase)('bottle registration (assets module)', () => {
  let t: TestApp;
  let version: LabelTemplateVersion;

  beforeAll(async () => {
    t = await createTestApp();
    version = await createTemplate(t.app);
  });
  afterAll(() => t?.close());

  const http = () => request(t.app.getHttpServer());

  async function batchRows(code: string) {
    const batch = await t.prisma.bottleCreationBatch.findUniqueOrThrow({
      where: { code },
      include: { bottles: { orderBy: { serial: 'asc' }, include: { events: true } } },
    });
    return batch;
  }

  it.each([1, 50, 100])(
    'creates %i bottle(s) with codes, tokens and one CREATED event each',
    async (quantity) => {
      const { batch } = await registerBottles(t.app, version.versionId, quantity);
      expect(batch.code).toMatch(/^BC-\d{6}$/);
      expect(batch.quantityRequested).toBe(quantity);
      expect(batch.quantityCreated).toBe(quantity);
      expect(batch.labelTemplate.label).toBe(version.label);

      const rows = await batchRows(batch.code);
      expect(rows.bottles).toHaveLength(quantity);
      // Contiguous code range, exactly as reported.
      expect(rows.bottles[0]!.code).toBe(batch.firstBottleCode);
      expect(rows.bottles.at(-1)!.code).toBe(batch.lastBottleCode);
      expect(rows.lastBottleSerial - rows.firstBottleSerial + 1n).toBe(BigInt(quantity));
      rows.bottles.forEach((b, i) => {
        expect(b.serial).toBe(rows.firstBottleSerial + BigInt(i));
        expect(b.code).toMatch(/^AYV-B-\d{6}$/);
        expect(b.publicToken).toMatch(/^[A-Za-z0-9_-]{22}$/);
        expect(b.status).toBe('CREATED');
        // Exactly one CREATED event, linked to the batch, at creation time.
        expect(b.events).toHaveLength(1);
        expect(b.events[0]).toMatchObject({ type: 'CREATED', creationBatchId: rows.id });
        expect(b.events[0]!.occurredAt.getTime()).toBe(b.createdAt.getTime());
      });
    },
  );

  it.each([0, -1, 1001, 1.5])('rejects quantity %s without creating anything', async (quantity) => {
    const before = await t.prisma.bottle.count();
    await http()
      .post('/api/admin/bottle-registrations')
      .send({ requestId: randomUUID(), labelTemplateVersionId: version.versionId, quantity })
      .expect(400);
    expect(await t.prisma.bottle.count()).toBe(before);
  });

  it('rejects an unknown label template version', async () => {
    await http()
      .post('/api/admin/bottle-registrations')
      .send({
        requestId: randomUUID(),
        labelTemplateVersionId: '00000000-0000-7000-8000-000000000000',
        quantity: 5,
      })
      .expect(400);
  });

  it('keeps bottle codes and public tokens unique across all bottles (also in the database)', async () => {
    await registerBottles(t.app, version.versionId, 200);
    const [stats] = await t.prisma.$queryRaw<{ total: bigint; codes: bigint; tokens: bigint }[]>`
      SELECT count(*) AS total, count(DISTINCT code) AS codes, count(DISTINCT public_token) AS tokens FROM bottles`;
    const { total, codes, tokens } = stats!;
    expect(codes).toBe(total);
    expect(tokens).toBe(total);
    // The public token is independent of the sequential code and of the internal id.
    const sample = await t.prisma.bottle.findFirstOrThrow();
    expect(sample.publicToken).not.toContain(sample.code);
    expect(sample.publicToken).not.toContain(sample.id.replaceAll('-', '').slice(0, 8));
  });

  it('enforces exactly one CREATED event per bottle at database level', async () => {
    const bottle = await t.prisma.bottle.findFirstOrThrow({ include: { events: true } });
    await expect(
      t.prisma.bottleEvent.create({
        data: {
          bottleId: bottle.id,
          type: 'CREATED',
          occurredAt: new Date(),
          creationBatchId: bottle.creationBatchId,
        },
      }),
    ).rejects.toThrow();
  });

  it('rolls back the WHOLE batch if one insert fails half-way (37th of 50)', async () => {
    const counters = () => t.prisma.codeCounter.findMany({ orderBy: { name: 'asc' } });
    const before = {
      bottles: await t.prisma.bottle.count(),
      events: await t.prisma.bottleEvent.count(),
      batches: await t.prisma.bottleCreationBatch.count(),
      counters: await counters(),
    };
    const failingSerial = before.counters.find((c) => c.name === 'bottle')!.lastValue + 37n;

    // Simulated failure inside the transaction: the database rejects the 37th bottle.
    await t.prisma.$executeRawUnsafe(`
      CREATE FUNCTION test_fail_bottle() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN IF NEW.serial = ${failingSerial} THEN RAISE EXCEPTION 'simulated failure'; END IF; RETURN NEW; END $$`);
    await t.prisma.$executeRawUnsafe(
      'CREATE TRIGGER test_fail_bottle BEFORE INSERT ON bottles FOR EACH ROW EXECUTE FUNCTION test_fail_bottle()',
    );
    try {
      const res = await http()
        .post('/api/admin/bottle-registrations')
        .send({ requestId: randomUUID(), labelTemplateVersionId: version.versionId, quantity: 50 });
      expect(res.status).toBe(500);
      // No database or filesystem details leak to the client.
      expect(JSON.stringify(res.body)).not.toMatch(/simulated|bottles|serial|prisma/i);
    } finally {
      await t.prisma.$executeRawUnsafe('DROP TRIGGER test_fail_bottle ON bottles');
      await t.prisma.$executeRawUnsafe('DROP FUNCTION test_fail_bottle()');
    }

    // 0 new bottles, events or batches — and the code counters were rolled back (no gaps).
    expect(await t.prisma.bottle.count()).toBe(before.bottles);
    expect(await t.prisma.bottleEvent.count()).toBe(before.events);
    expect(await t.prisma.bottleCreationBatch.count()).toBe(before.batches);
    expect(await counters()).toEqual(before.counters);

    // The next registration continues the sequence without a gap.
    const { batch } = await registerBottles(t.app, version.versionId, 1);
    expect((await batchRows(batch.code)).firstBottleSerial).toBe(
      before.counters.find((c) => c.name === 'bottle')!.lastValue + 1n,
    );
  });

  it('gives concurrent registrations disjoint, contiguous code ranges and distinct batch codes', async () => {
    const results = await Promise.all(
      Array.from({ length: 6 }, (_, i) => registerBottles(t.app, version.versionId, 40 + i * 10)),
    );
    const batchCodes = results.map((r) => r.batch.code);
    expect(new Set(batchCodes).size).toBe(6);

    const ranges = [];
    for (const { batch } of results) {
      const rows = await batchRows(batch.code);
      expect(rows.bottles).toHaveLength(batch.quantityCreated);
      ranges.push([rows.firstBottleSerial, rows.lastBottleSerial] as const);
    }
    ranges.sort((a, b) => (a[0] < b[0] ? -1 : 1));
    for (let i = 1; i < ranges.length; i++)
      expect(ranges[i]![0]).toBeGreaterThan(ranges[i - 1]![1]);

    const all = await t.prisma.bottle.findMany({ select: { code: true, publicToken: true } });
    expect(new Set(all.map((b) => b.code)).size).toBe(all.length);
    expect(new Set(all.map((b) => b.publicToken)).size).toBe(all.length);
  });

  it('is idempotent per requestId: a retry returns the same batch, bottles and print job', async () => {
    const body = {
      requestId: randomUUID(),
      labelTemplateVersionId: version.versionId,
      quantity: 7,
    };
    const before = {
      bottles: await t.prisma.bottle.count(),
      jobs: await t.prisma.labelPrintJob.count(),
    };
    const first = (await http().post('/api/admin/bottle-registrations').send(body).expect(201))
      .body as BottleRegistrationResponse;
    const retry = (await http().post('/api/admin/bottle-registrations').send(body).expect(201))
      .body as BottleRegistrationResponse;
    expect(first.replayed).toBe(false);
    expect(retry.replayed).toBe(true);
    expect(retry.batch).toEqual(first.batch);
    expect(retry.printJob?.code).toBe(first.printJob?.code);
    expect(await t.prisma.bottle.count()).toBe(before.bottles + 7);
    expect(await t.prisma.labelPrintJob.count()).toBe(before.jobs + 1);

    // Reusing the key for a different registration is refused.
    await http()
      .post('/api/admin/bottle-registrations')
      .send({ ...body, quantity: 8 })
      .expect(409);
    // A request without a key is invalid.
    await http()
      .post('/api/admin/bottle-registrations')
      .send({ labelTemplateVersionId: version.versionId, quantity: 1 })
      .expect(400);
  });

  it('concurrent duplicates of one request create exactly one batch', async () => {
    const body = {
      requestId: randomUUID(),
      labelTemplateVersionId: version.versionId,
      quantity: 30,
    };
    const before = await t.prisma.bottle.count();
    const results = await Promise.all(
      Array.from({ length: 5 }, () =>
        http().post('/api/admin/bottle-registrations').send(body).expect(201),
      ),
    );
    const codes = new Set(results.map((r) => (r.body as BottleRegistrationResponse).batch.code));
    expect(codes.size).toBe(1);
    expect(results.filter((r) => !(r.body as BottleRegistrationResponse).replayed)).toHaveLength(1);
    expect(await t.prisma.bottle.count()).toBe(before + 30);
  });

  it('formats codes beyond six digits identically in the database and the application', async () => {
    const rows = await t.prisma.$queryRaw<{ a: string; b: string; c: string }[]>`
      SELECT ayvo_format_code('AYV-B-', 7) AS a, ayvo_format_code('AYV-B-', 999999) AS b,
             ayvo_format_code('AYV-B-', 1234567) AS c`;
    expect(rows[0]).toEqual({ a: 'AYV-B-000007', b: 'AYV-B-999999', c: 'AYV-B-1234567' });
  });

  it('records batch membership correctly and exposes it in list and detail', async () => {
    const { batch } = await registerBottles(t.app, version.versionId, 20);
    const list = (
      await http().get('/api/admin/bottles').query({ batch: batch.code, pageSize: 100 }).expect(200)
    ).body as BottleListResponse;
    expect(list.total).toBe(20);
    expect(list.items.every((b) => b.creationBatchCode === batch.code)).toBe(true);
    expect(list.items.map((b) => b.code).sort()).toEqual(
      (await batchRows(batch.code)).bottles.map((b) => b.code),
    );

    const detail = (await http().get(`/api/admin/bottles/${batch.firstBottleCode}`).expect(200))
      .body as BottleDetail;
    expect(detail).toMatchObject({
      code: batch.firstBottleCode,
      status: 'CREATED',
      creationBatchCode: batch.code,
    });
    expect(detail.labelTemplate.label).toBe(version.label);
    expect(detail.events).toEqual([expect.objectContaining({ type: 'CREATED' })]);
    expect(detail.reuseCycles).toBe(0);
    expect(detail.publicUrl).toMatch(/^https:\/\/qr\.example\.test\/[A-Za-z0-9_-]{22}$/);
    // Internal ids are not part of the admin DTO either.
    expect(JSON.stringify(detail)).not.toMatch(/"id"|serial/);
  });

  it('lists with pagination, exact code search and template filter', async () => {
    const other = await createTemplate(t.app);
    const { batch } = await registerBottles(t.app, other.versionId, 3);

    const page = (
      await http().get('/api/admin/bottles').query({ pageSize: 2, page: 2 }).expect(200)
    ).body as BottleListResponse;
    expect(page.items).toHaveLength(2);
    expect(page.total).toBeGreaterThan(4);

    for (const search of [
      batch.firstBottleCode,
      batch.firstBottleCode.replace('AYV-B-', ''),
      String(Number(batch.firstBottleCode.slice(6))),
    ]) {
      const found = (await http().get('/api/admin/bottles').query({ search }).expect(200))
        .body as BottleListResponse;
      expect(found.items.map((b) => b.code)).toEqual([batch.firstBottleCode]);
    }
    expect(
      (
        (await http().get('/api/admin/bottles').query({ search: 'nonsense' }))
          .body as BottleListResponse
      ).total,
    ).toBe(0);

    const byTemplate = (
      await http().get('/api/admin/bottles').query({ templateId: other.templateId }).expect(200)
    ).body as BottleListResponse;
    expect(byTemplate.total).toBe(3);
    expect(byTemplate.items.every((b) => b.labelTemplate.templateId === other.templateId)).toBe(
      true,
    );

    await http().get('/api/admin/bottles').query({ pageSize: 101 }).expect(400);
    await http().get('/api/admin/bottles/AYV-B-999999').expect(404);
  });

  it('never deletes bottles or rewrites their identity or history (database guards)', async () => {
    const bottle = await t.prisma.bottle.findFirstOrThrow({ include: { events: true } });
    await expect(t.prisma.bottle.delete({ where: { id: bottle.id } })).rejects.toThrow();
    await expect(
      t.prisma.bottle.update({ where: { id: bottle.id }, data: { publicToken: 'x'.repeat(22) } }),
    ).rejects.toThrow();
    await expect(
      t.prisma.bottle.update({ where: { id: bottle.id }, data: { code: 'AYV-B-000000' } }),
    ).rejects.toThrow();
    await expect(
      t.prisma.bottleEvent.update({
        where: { id: bottle.events[0]!.id },
        data: { occurredAt: new Date(0) },
      }),
    ).rejects.toThrow();
    await expect(
      t.prisma.bottleEvent.delete({ where: { id: bottle.events[0]!.id } }),
    ).rejects.toThrow();
    await expect(
      t.prisma.bottleCreationBatch.delete({ where: { id: bottle.creationBatchId } }),
    ).rejects.toThrow();
    await expect(t.prisma.$executeRawUnsafe('TRUNCATE bottle_events')).rejects.toThrow();
  });
});
