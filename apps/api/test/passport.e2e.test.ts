import { publicBottlePassportSchema } from '@ayvo/types';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTemplate, registerBottles } from './support/fixtures.js';
import { createTestApp, hasDatabase, type TestApp } from './support/test-app.js';

describe.skipIf(!hasDatabase)('public bottle passport', () => {
  let t: TestApp;
  let bottle: { id: string; code: string; publicToken: string; creationBatchId: string };

  beforeAll(async () => {
    t = await createTestApp();
    const version = await createTemplate(t.app);
    const { batch } = await registerBottles(t.app, version.versionId, 2);
    bottle = await t.prisma.bottle.findUniqueOrThrow({ where: { code: batch.firstBottleCode } });
  });
  afterAll(() => t?.close());

  const http = () => request(t.app.getHttpServer());

  it('resolves a valid public token to the whitelisted passport', async () => {
    const res = await http().get(`/api/public/bottles/${bottle.publicToken}`).expect(200);
    expect(res.body).toEqual({ bottleCode: bottle.code, reuseCycles: 0 });
    expect(publicBottlePassportSchema.parse(res.body)).toEqual(res.body);
    expect(res.headers['cache-control']).toBe('public, max-age=60');
  });

  it.each([
    ['unknown well-formed token', 'AAAAAAAAAAAAAAAAAAAAAA'],
    ['malformed token', 'not-a-token'],
    ['bottle code instead of token', 'AYV-B-000001'],
  ])('answers 404 for a %s', async (_case, token) => {
    const res = await http().get(`/api/public/bottles/${token}`).expect(404);
    expect(JSON.stringify(res.body)).not.toMatch(/prisma|sql|bottles|uuid/i);
  });

  it('cannot be resolved by internal id', async () => {
    await http().get(`/api/public/bottles/${bottle.id}`).expect(404);
  });

  it('exposes no internal or private fields', async () => {
    const res = await http().get(`/api/public/bottles/${bottle.publicToken}`).expect(200);
    expect(Object.keys(res.body as object).sort()).toEqual(['bottleCode', 'reuseCycles']);
    const text = JSON.stringify(res.body);
    for (const secret of [bottle.id, bottle.creationBatchId, bottle.publicToken])
      expect(text).not.toContain(secret);
    expect(text).not.toMatch(/batch|template|serial|status|created|co2|hotel|operator/i);
  });
});
