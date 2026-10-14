import { crateLabelLayout } from '@ayvo/types';
import { describe, expect, it } from 'vitest';
import { decodeQrOnPage, openPdf, pageText } from '../../test/support/pdf-inspect.js';
import { DEV_LABEL_MARKER } from '../common/qr-policy.js';
import { LabelTooSmallError, PdfLibCodeLabelRenderer } from './code-label-pdf.js';

const URL = 'https://dev.ayvo.co/q/AbCdEfGhIjKlMnOpQrStUv';
const label = { code: 'AYV-C-000123', detail: 'CRATE-40 · Kapacita 40', url: URL };

/**
 * Crate labels (doc 025 A1) at sizes a user may enter: exact page size, a decodable QR inside its
 * computed box, the code and detail text, the DEV band — and a refusal below the minimum QR.
 */
describe('artwork-free code labels', () => {
  const renderer = new PdfLibCodeLabelRenderer();

  for (const [w, h] of [
    [100, 50],
    [60, 60],
    [50, 30],
    [40, 70],
    [150, 100],
  ] as const) {
    it(`renders ${w} × ${h} mm with a readable QR inside its box`, async () => {
      const pdf = await openPdf(
        await renderer.render({
          title: 't',
          widthMm: w,
          heightMm: h,
          labels: [label],
          errorCorrection: 'Q',
          devMarker: true,
        }),
      );
      expect(pdf.pageSizesMm[0]!.widthMm).toBeCloseTo(w, 1);
      expect(pdf.pageSizesMm[0]!.heightMm).toBeCloseTo(h, 1);
      const layout = crateLabelLayout(w, h)!;
      const qr = await decodeQrOnPage(pdf, 1, 20);
      expect(qr?.data).toBe(URL);
      // The symbol lies inside the computed QR box (which includes the quiet zone).
      expect(qr!.symbolMm.left).toBeGreaterThanOrEqual(layout.qr.xMm - 0.5);
      expect(qr!.symbolMm.top).toBeGreaterThanOrEqual(layout.qr.yMm - 0.5);
      expect(qr!.symbolMm.right).toBeLessThanOrEqual(layout.qr.xMm + layout.qr.sizeMm + 0.5);
      expect(qr!.symbolMm.bottom).toBeLessThanOrEqual(layout.qr.yMm + layout.qr.sizeMm + 0.5);
      const text = await pageText(pdf, 1);
      expect(text).toContain('AYV-C-000123');
      expect(text).toContain('CRATE-40 · Kapacita 40');
      expect(text).toContain(DEV_LABEL_MARKER);
    });
  }

  it('never draws the DEV band in production and refuses a label too small for the QR', async () => {
    const pdf = await openPdf(
      await renderer.render({
        title: 't',
        widthMm: 100,
        heightMm: 50,
        labels: [label],
        errorCorrection: 'Q',
        devMarker: false,
      }),
    );
    expect(await pageText(pdf, 1)).not.toContain(DEV_LABEL_MARKER);
    expect(crateLabelLayout(20, 20)).toBeNull();
    await expect(
      renderer.render({
        title: 't',
        widthMm: 20,
        heightMm: 20,
        labels: [label],
        errorCorrection: 'Q',
        devMarker: true,
      }),
    ).rejects.toBeInstanceOf(LabelTooSmallError);
  });
});
