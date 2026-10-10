import type {
  CreateLabelTemplateVersionResponse,
  LabelTemplateDetail,
  LabelTemplateSummary,
  LabelTemplateVersion,
} from '@ayvo/types';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { rasterArtwork, SVG_70x110 } from './support/artwork-fixtures.js';
import { layout, QR_DEFAULT, uniqueName, uploadArtwork } from './support/fixtures.js';
import { createTestApp, hasDatabase, type TestApp } from './support/test-app.js';

describe.skipIf(!hasDatabase)('label templates (labels module)', () => {
  let t: TestApp;
  beforeAll(async () => {
    t = await createTestApp();
  });
  afterAll(() => t?.close());

  const http = () => request(t.app.getHttpServer());

  describe('artwork upload', () => {
    it.each([
      ['SVG', SVG_70x110, 'mydlo1.svg', { widthMm: 70, heightMm: 110 }],
      ['PNG', rasterArtwork('png', 700, 1100), 'mydlo1.png', null],
      ['JPEG', rasterArtwork('jpeg', 700, 1100), 'mydlo1.jpg', null],
    ] as const)(
      'accepts %s artwork and serves it back unchanged',
      async (format, bytes, filename, suggested) => {
        const artwork = await uploadArtwork(t.app, bytes, filename);
        expect(artwork).toMatchObject({
          format,
          byteSize: bytes.length,
          originalFilename: filename,
          suggestedSizeMm: suggested,
        });
        expect(artwork.intrinsicWidth / artwork.intrinsicHeight).toBeCloseTo(70 / 110, 3);

        const res = await http().get(artwork.contentUrl).expect(200);
        expect(Buffer.compare(res.body as Buffer, bytes)).toBe(0);
        expect(res.headers['content-security-policy']).toContain('sandbox');
        expect(res.headers['x-content-type-options']).toBe('nosniff');
        // The storage path never appears in API responses.
        expect(JSON.stringify(artwork)).not.toMatch(/label-artworks\/\d{4}|storage/i);
      },
    );

    it('detects the type from the content, not the filename', async () => {
      const png = await uploadArtwork(t.app, rasterArtwork('png', 70, 110), 'innocent.svg');
      expect(png.format).toBe('PNG');
    });

    it.each([
      ['plain text renamed to .png', Buffer.from('hello world'), 'x.png'],
      ['truncated PNG', rasterArtwork('png', 70, 110).subarray(0, 40), 'x.png'],
      ['PDF', Buffer.from('%PDF-1.7\n%...'), 'x.pdf'],
      [
        'SVG with script',
        Buffer.from(
          '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><script>alert(1)</script></svg>',
        ),
        'x.svg',
      ],
      [
        'SVG with event handler',
        Buffer.from(
          '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10" onload="alert(1)"/>',
        ),
        'x.svg',
      ],
      [
        'SVG with external image',
        Buffer.from(
          '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><image href="https://evil.example/x.png"/></svg>',
        ),
        'x.svg',
      ],
      [
        'SVG with entity (XXE)',
        Buffer.from(
          '<?xml version="1.0"?><!DOCTYPE svg [<!ENTITY x SYSTEM "file:///etc/passwd">]><svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"/>',
        ),
        'x.svg',
      ],
      [
        'SVG without size',
        Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><rect width="1" height="1"/></svg>'),
        'x.svg',
      ],
      ['empty file', Buffer.alloc(0), 'x.png'],
    ])('rejects %s', async (_name, bytes, filename) => {
      const before = await t.prisma.labelArtwork.count();
      const res = await http().post('/api/admin/label-artworks').attach('file', bytes, filename);
      expect(res.status).toBe(400);
      expect(await t.prisma.labelArtwork.count()).toBe(before);
    });

    it('rejects files above the size limit with 413', async () => {
      await http()
        .post('/api/admin/label-artworks')
        .attach('file', Buffer.alloc(600 * 1024, 1), 'big.png')
        .expect(413);
    });

    it('requires a file', async () => {
      await http().post('/api/admin/label-artworks').expect(400);
    });
  });

  describe('templates and immutable versions', () => {
    it('creates a template with version 1 and round-trips the QR millimetre coordinates exactly', async () => {
      const artwork = await uploadArtwork(t.app);
      const name = uniqueName('mydlo');
      const res = await http()
        .post('/api/admin/label-templates')
        .send({ name, layout: layout(artwork.id) })
        .expect(201);
      const v1 = res.body as LabelTemplateVersion;
      expect(v1).toMatchObject({
        templateName: name,
        versionNumber: 1,
        label: `${name} v1`,
        widthMm: 70,
        heightMm: 110,
      });
      expect(v1.elements).toEqual([{ ...QR_DEFAULT }]);
      expect(v1.artwork.id).toBe(artwork.id);

      const detail = (await http().get(`/api/admin/label-templates/${v1.templateId}`).expect(200))
        .body as LabelTemplateDetail;
      expect(detail.versions).toHaveLength(1);
      expect(detail.versions[0]!.elements[0]).toEqual({ ...QR_DEFAULT });

      const list = (await http().get('/api/admin/label-templates').expect(200))
        .body as LabelTemplateSummary[];
      expect(list.find((s) => s.id === v1.templateId)).toMatchObject({ name, versionCount: 1 });
    });

    it('creates a new version for a changed layout and leaves the old one untouched', async () => {
      const artwork = await uploadArtwork(t.app);
      const v1 = (
        await http()
          .post('/api/admin/label-templates')
          .send({ name: uniqueName(), layout: layout(artwork.id) })
          .expect(201)
      ).body as LabelTemplateVersion;

      const moved = layout(artwork.id, {
        elements: [{ ...QR_DEFAULT, xMm: 10.25, yMm: 12.5, widthMm: 20, heightMm: 20 }],
      });
      const v2 = (
        await http()
          .post(`/api/admin/label-templates/${v1.templateId}/versions`)
          .send({ layout: moved })
          .expect(200)
      ).body as CreateLabelTemplateVersionResponse;
      expect(v2.created).toBe(true);
      expect(v2.version.versionNumber).toBe(2);
      expect(v2.version.elements[0]).toMatchObject({ xMm: 10.25, yMm: 12.5, widthMm: 20 });

      // Saving the same layout again creates nothing.
      const same = (
        await http()
          .post(`/api/admin/label-templates/${v1.templateId}/versions`)
          .send({ layout: moved })
          .expect(200)
      ).body as CreateLabelTemplateVersionResponse;
      expect(same).toMatchObject({ created: false, version: { versionNumber: 2 } });

      // New artwork and a new physical size are new versions too.
      const newArtwork = await uploadArtwork(t.app, rasterArtwork('png', 600, 900), 'b.png');
      const v3 = (
        await http()
          .post(`/api/admin/label-templates/${v1.templateId}/versions`)
          .send({
            layout: layout(newArtwork.id, {
              widthMm: 60,
              heightMm: 90,
              elements: [{ ...QR_DEFAULT, xMm: 5, yMm: 5 }],
            }),
          })
          .expect(200)
      ).body as CreateLabelTemplateVersionResponse;
      expect(v3.version).toMatchObject({ versionNumber: 3, widthMm: 60, heightMm: 90 });

      // v1 is exactly as it was.
      const v1Again = (
        await http().get(`/api/admin/label-template-versions/${v1.versionId}`).expect(200)
      ).body as LabelTemplateVersion;
      expect(v1Again).toEqual(v1);
    });

    it('rejects any change to a stored version at database level', async () => {
      const version = await t.prisma.labelTemplateVersion.findFirstOrThrow({
        include: { elements: true },
      });
      await expect(
        t.prisma.labelTemplateVersion.update({ where: { id: version.id }, data: { widthMm: 71 } }),
      ).rejects.toThrow();
      await expect(
        t.prisma.labelTemplateElement.update({
          where: { id: version.elements[0]!.id },
          data: { xMm: 1 },
        }),
      ).rejects.toThrow();
      await expect(
        t.prisma.labelTemplateVersion.delete({ where: { id: version.id } }),
      ).rejects.toThrow();
      await expect(
        t.prisma.labelArtwork.delete({ where: { id: version.artworkId } }),
      ).rejects.toThrow();
    });

    it('serialises concurrent saves into consecutive version numbers', async () => {
      const artwork = await uploadArtwork(t.app);
      const v1 = (
        await http()
          .post('/api/admin/label-templates')
          .send({ name: uniqueName(), layout: layout(artwork.id) })
          .expect(201)
      ).body as LabelTemplateVersion;
      const saves = await Promise.all(
        [11, 12, 13, 14].map((x) =>
          http()
            .post(`/api/admin/label-templates/${v1.templateId}/versions`)
            .send({ layout: layout(artwork.id, { elements: [{ ...QR_DEFAULT, xMm: x }] }) })
            .expect(200),
        ),
      );
      const numbers = saves
        .map((r) => (r.body as CreateLabelTemplateVersionResponse).version.versionNumber)
        .sort();
      expect(numbers).toEqual([2, 3, 4, 5]);
    });

    it('rejects a duplicate template name with 409', async () => {
      const artwork = await uploadArtwork(t.app);
      const name = uniqueName();
      await http()
        .post('/api/admin/label-templates')
        .send({ name, layout: layout(artwork.id) })
        .expect(201);
      await http()
        .post('/api/admin/label-templates')
        .send({ name, layout: layout(artwork.id) })
        .expect(409);
    });

    it.each([
      ['an invalid name', { name: 'Mýdlo 1!' }],
      ['a QR outside the label', { layout: { elements: [{ ...QR_DEFAULT, xMm: 60 }] } }],
      [
        'a QR below the minimum size',
        { layout: { elements: [{ ...QR_DEFAULT, widthMm: 8, heightMm: 8 }] } },
      ],
      ['a non-square QR', { layout: { elements: [{ ...QR_DEFAULT, heightMm: 16 }] } }],
      [
        'rotation (not supported in v0.1)',
        { layout: { elements: [{ ...QR_DEFAULT, rotationDeg: 90 }] } },
      ],
      ['no QR code', { layout: { elements: [] } }],
      ['sub-0.01 mm precision', { layout: { elements: [{ ...QR_DEFAULT, xMm: 1.234 }] } }],
      [
        'artwork proportions that do not match the label',
        { layout: { widthMm: 70, heightMm: 70 } },
      ],
      ['a label larger than 500 mm', { layout: { widthMm: 700, heightMm: 1100 } }],
      ['unknown artwork', { layout: { artworkId: '00000000-0000-7000-8000-000000000000' } }],
    ])('rejects %s', async (_case, patch: { name?: string; layout?: object }) => {
      const artwork = await uploadArtwork(t.app);
      const body = {
        name: patch.name ?? uniqueName(),
        layout: { ...layout(artwork.id), ...patch.layout },
      };
      const res = await http().post('/api/admin/label-templates').send(body);
      expect(res.status).toBe(400);
    });
  });

  it('exposes the designer settings', async () => {
    const res = await http().get('/api/admin/label-designer/settings').expect(200);
    expect(res.body).toEqual({
      qrMinSizeMm: 10,
      artworkMaxBytes: 512 * 1024,
      aspectRatioTolerance: 0.01,
      qrErrorCorrection: 'Q',
      qrPreviewUrl: 'https://qr.example.test/AAAAAAAAAAAAAAAAAAAAAA',
    });
  });
});
