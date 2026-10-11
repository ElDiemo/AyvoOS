import { randomUUID } from 'node:crypto';
import type { LabelTemplateDetail, LabelTemplateSummary } from '@ayvo/types';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTemplate, layout, QR_DEFAULT, registerBottles } from './support/fixtures.js';
import { createTestApp, hasDatabase, type TestApp } from './support/test-app.js';

describe.skipIf(!hasDatabase)('template archiving and version selection', () => {
  let t: TestApp;
  beforeAll(async () => {
    t = await createTestApp();
  });
  afterAll(() => t?.close());
  const http = () => request(t.app.getHttpServer());

  it('new batches may only use the latest version; historical jobs keep their old version', async () => {
    const v1 = await createTemplate(t.app);
    const { printJob: oldJob } = await registerBottles(t.app, v1.versionId, 2);
    await http()
      .post(`/api/admin/label-templates/${v1.templateId}/versions`)
      .send({ layout: layout(v1.artwork.id, { elements: [{ ...QR_DEFAULT, xMm: 5 }] }) })
      .expect(200);

    const res = await http()
      .post('/api/admin/bottle-registrations')
      .send({ requestId: randomUUID(), labelTemplateVersionId: v1.versionId, quantity: 1 })
      .expect(400);
    expect(res.body.message).toMatch(/not the latest version/);

    const done = (
      await http().post(`/api/admin/label-print-jobs/${oldJob!.code}/generate`).expect(200)
    ).body;
    expect(done).toMatchObject({ status: 'COMPLETED', labelTemplate: { versionNumber: 1 } });
  });

  it('archived templates cannot be used for new batches or edited, but keep their history', async () => {
    const v1 = await createTemplate(t.app);
    const { batch, printJob } = await registerBottles(t.app, v1.versionId, 1);

    const archived = (
      await http().post(`/api/admin/label-templates/${v1.templateId}/archive`).expect(200)
    ).body as LabelTemplateDetail;
    expect(archived.archivedAt).not.toBeNull();
    const list = (await http().get('/api/admin/label-templates').expect(200))
      .body as LabelTemplateSummary[];
    expect(list.find((s) => s.id === v1.templateId)?.archivedAt).not.toBeNull();

    const refused = await http()
      .post('/api/admin/bottle-registrations')
      .send({ requestId: randomUUID(), labelTemplateVersionId: v1.versionId, quantity: 1 })
      .expect(400);
    expect(refused.body.message).toMatch(/archived/);
    await http()
      .post(`/api/admin/label-templates/${v1.templateId}/versions`)
      .send({ layout: layout(v1.artwork.id, { elements: [{ ...QR_DEFAULT, xMm: 6 }] }) })
      .expect(409);

    // History stays reproducible: the batch, its version and the print job still work.
    await http().get(`/api/admin/bottle-batches/${batch.code}`).expect(200);
    await http().get(`/api/admin/label-template-versions/${v1.versionId}`).expect(200);
    await http().post(`/api/admin/label-print-jobs/${printJob!.code}/generate`).expect(200);

    // Restoring makes it selectable again.
    const restored = (
      await http().post(`/api/admin/label-templates/${v1.templateId}/restore`).expect(200)
    ).body as LabelTemplateDetail;
    expect(restored.archivedAt).toBeNull();
    await registerBottles(t.app, v1.versionId, 1);
  });

  it('templates can never be deleted or renamed (database guards)', async () => {
    const v1 = await createTemplate(t.app);
    await expect(t.prisma.labelTemplate.delete({ where: { id: v1.templateId } })).rejects.toThrow();
    await expect(
      t.prisma.labelTemplate.update({ where: { id: v1.templateId }, data: { name: 'renamed' } }),
    ).rejects.toThrow();
    await http()
      .post('/api/admin/label-templates/00000000-0000-7000-8000-000000000000/archive')
      .expect(404);
  });
});
