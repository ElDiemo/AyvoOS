import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PRODUCTION_QR_BASE_URL } from '../src/common/qr-policy.js';
import {
  CANDIDATE,
  SCAN_TEST_CHECKLIST,
  validationSheetVariants,
  validationUrl,
  VALIDATION_LEVELS,
  VALIDATION_SIZES_MM,
  variantId,
} from '../src/labels/calibration-pdf.js';
import { qrSymbolInfo } from '../src/labels/label-pdf-renderer.js';
import { createTemplate } from './support/fixtures.js';
import { decodeQrOnPage, openPdf, pageText } from './support/pdf-inspect.js';
import { createTestApp, hasDatabase, type TestApp } from './support/test-app.js';

const binary = (r: request.Response, cb: (err: Error | null, body: Buffer) => void) => {
  const chunks: Buffer[] = [];
  r.on('data', (c: Buffer) => chunks.push(c));
  r.on('end', () => cb(null, Buffer.concat(chunks)));
};

describe.skipIf(!hasDatabase)('calibration and QR validation PDFs', () => {
  let t: TestApp;
  beforeAll(async () => {
    t = await createTestApp();
  });
  afterAll(() => t?.close());

  it('validation sheet: A4, every size × EC variant scannable, labelled, with scale references', async () => {
    const res = await request(t.app.getHttpServer())
      .get('/api/admin/label-calibration/qr-validation-sheet.pdf')
      .buffer(true)
      .parse(binary)
      .expect(200);
    const pdf = await openPdf(res.body as Buffer);
    expect(pdf.pageCount).toBe(1);
    expect(pdf.pageSizesMm[0]!.widthMm).toBeCloseTo(210, 1);
    expect(pdf.pageSizesMm[0]!.heightMm).toBeCloseTo(297, 1);

    const text = await pageText(pdf, 1);
    expect(text).toContain('PRINT AT 100 %');
    expect(text).toContain('Page size: 210 x 297 mm');
    expect(text).toContain('exactly 10.0 mm');
    expect(variantId(CANDIDATE.sizeMm, CANDIDATE.level)).toBe('V15-Q');
    expect(text).toMatch(/V15-Q\s+- production candidate \(provisional\)/);

    for (const item of SCAN_TEST_CHECKLIST) expect(text).toContain(item);

    const variants = validationSheetVariants();
    expect(variants.map((v) => v.id)).toEqual(
      VALIDATION_SIZES_MM.flatMap((size) =>
        VALIDATION_LEVELS.map((level) => variantId(size, level)),
      ),
    );
    for (const v of variants) {
      expect(text).toContain(v.id);
      // Same structure and token length as the production URL, but never a production URL.
      expect(v.url).toMatch(/^https:\/\/qr\.invalid\/[A-Za-z0-9_-]{22}$/);
      expect(v.url.length).toBe(PRODUCTION_QR_BASE_URL.length + 1 + 22);
      const info = qrSymbolInfo(v.url, v.sizeMm, v.level);
      expect(text).toContain(
        `${info.modules} x ${info.modules} modules), module ${info.moduleMm.toFixed(3)} mm`,
      );
      const decoded = await decodeQrOnPage(pdf, 1, 16, {
        left: v.xMm - 3,
        top: v.yMm - 3,
        width: v.sizeMm + 6,
        height: v.sizeMm + 6,
      });
      expect(decoded?.data, v.id).toBe(v.url);
      expect(decoded?.version, v.id).toBe(info.version);
    }
  });

  it('template calibration: exact label size, 10 mm reference, scaling warning, DEV marker, QR at its place', async () => {
    const version = await createTemplate(t.app);
    const res = await request(t.app.getHttpServer())
      .get(`/api/admin/label-template-versions/${version.versionId}/calibration.pdf`)
      .buffer(true)
      .parse(binary)
      .expect(200);
    expect(res.headers['content-disposition']).toContain(
      `calibration_${version.templateName}-v1.pdf`,
    );
    const pdf = await openPdf(res.body as Buffer);
    expect(pdf.pageCount).toBe(1);
    expect(pdf.pageSizesMm[0]!.widthMm).toBeCloseTo(70, 2);
    expect(pdf.pageSizesMm[0]!.heightMm).toBeCloseTo(110, 2);

    const text = await pageText(pdf, 1);
    for (const s of [
      'Page 70 x 110 mm',
      '10 mm',
      'PRINT AT 100 % - NO SCALING',
      'QR V15-Q: 15 mm, EC Q',
      'DEV - NOT FOR PRODUCTION',
    ]) {
      expect(text).toContain(s);
    }
    const decoded = await decodeQrOnPage(pdf, 1);
    expect(decoded?.data).toBe(validationUrl('V15-Q'));
    expect(decoded!.symbolMm.left).toBeGreaterThan(48.2);
    expect(decoded!.symbolMm.left).toBeLessThan(48.2 + 3);
  });
});
