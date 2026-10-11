import type { LabelElement } from '@ayvo/types';
import { describe, expect, it } from 'vitest';
import { rasterArtwork, SVG_70x110 } from '../../test/support/artwork-fixtures.js';
import { decodeQrOnPage, openPdf, pageText } from '../../test/support/pdf-inspect.js';
import { DEV_LABEL_MARKER } from '../common/qr-policy.js';
import {
  PdfLibLabelRenderer,
  qrSymbolInfo,
  QR_QUIET_ZONE_MODULES,
  type QrErrorCorrection,
} from './label-pdf-renderer.js';

const renderer = new PdfLibLabelRenderer();
const qr: LabelElement = {
  type: 'QR_CODE',
  xMm: 48.2,
  yMm: 78.5,
  widthMm: 15,
  heightMm: 15,
  rotationDeg: 0,
};
const urls = ['AAAAAAAAAAAAAAAAAAAAAA', 'BBBBBBBBBBBBBBBBBBBBBB', 'CCCCCCCCCCCCCCCCCCCCCC'].map(
  (t) => `https://qr.example.test/${t}`,
);

function template(artwork: { format: 'SVG' | 'PNG' | 'JPEG'; bytes: Buffer }) {
  return { widthMm: 70, heightMm: 110, artwork, elements: [qr] };
}

const render = (
  opts: {
    format?: 'SVG' | 'PNG' | 'JPEG';
    bytes?: Buffer;
    errorCorrection?: QrErrorCorrection;
    devMarker?: boolean;
    labels?: { code: string; url: string }[];
  } = {},
) =>
  renderer.render({
    title: 'test',
    template: template({ format: opts.format ?? 'SVG', bytes: opts.bytes ?? SVG_70x110 }),
    labels: opts.labels ?? urls.map((url, i) => ({ code: `AYV-B-00000${i + 1}`, url })),
    errorCorrection: opts.errorCorrection ?? 'Q',
    devMarker: opts.devMarker ?? false,
  });

describe('PdfLibLabelRenderer', () => {
  it.each([
    ['SVG', SVG_70x110, 'Q'],
    ['PNG', rasterArtwork('png', 700, 1100), 'Q'],
    ['JPEG', rasterArtwork('jpeg', 700, 1100), 'M'],
  ] as const)(
    'renders one exact-size page per label with the right QR at the stored position (%s artwork, EC %s)',
    async (format, bytes, errorCorrection) => {
      const doc = await openPdf(await render({ format, bytes, errorCorrection }));

      // Page count = label count; every page is exactly 70 × 110 mm.
      expect(doc.pageCount).toBe(3);
      for (const size of doc.pageSizesMm) {
        expect(size.widthMm).toBeCloseTo(70, 2);
        expect(size.heightMm).toBeCloseTo(110, 2);
      }

      for (let page = 1; page <= 3; page++) {
        const decoded = await decodeQrOnPage(doc, page);
        // Page N encodes exactly label N's public URL and nothing else.
        expect(decoded?.data).toBe(urls[page - 1]);
        const want = qrSymbolInfo(urls[page - 1]!, qr.widthMm, errorCorrection);
        expect(decoded?.version).toBe(want.version);

        // The symbol sits where the designer put it (tolerance: one module).
        const inset = QR_QUIET_ZONE_MODULES * want.moduleMm;
        expect(Math.abs(decoded!.symbolMm.left - (qr.xMm + inset))).toBeLessThan(want.moduleMm);
        expect(Math.abs(decoded!.symbolMm.top - (qr.yMm + inset))).toBeLessThan(want.moduleMm);
        expect(Math.abs(decoded!.symbolMm.right - (qr.xMm + qr.widthMm - inset))).toBeLessThan(
          want.moduleMm,
        );
        expect(Math.abs(decoded!.symbolMm.bottom - (qr.yMm + qr.widthMm - inset))).toBeLessThan(
          want.moduleMm,
        );
      }
    },
  );

  it('uses the configured error correction level (Q needs a larger symbol than M)', () => {
    const url = 'https://qr.example.test/AAAAAAAAAAAAAAAAAAAAAA';
    expect(qrSymbolInfo(url, 15, 'Q').version).toBeGreaterThan(qrSymbolInfo(url, 15, 'M').version);
  });

  it('prints a visible DEV marker on every non-production label, and none on production labels', async () => {
    const dev = await openPdf(await render({ devMarker: true }));
    for (let page = 1; page <= 3; page++) {
      expect(await pageText(dev, page)).toContain(DEV_LABEL_MARKER);
      // The marker never covers the QR code.
      expect((await decodeQrOnPage(dev, page))?.data).toBe(urls[page - 1]);
    }
    const production = await openPdf(await render({ devMarker: false }));
    expect(await pageText(production, 1)).not.toContain('DEV');
  });

  it('embeds the artwork once and reuses it on every page (small files for 100 labels)', async () => {
    const labels = Array.from({ length: 100 }, (_, i) => ({
      code: `c${i}`,
      url: `https://qr.example.test/${String(i).padStart(22, 'x')}`,
    }));
    const one = await render({ labels: labels.slice(0, 1) });
    const hundred = await render({ labels });
    expect((await openPdf(hundred)).pageCount).toBe(100);
    // Each extra page costs only its QR path, not another copy of the artwork.
    expect((hundred.length - one.length) / 99).toBeLessThan(3_000);
  });

  it('refuses to render an empty print job', async () => {
    await expect(render({ labels: [] })).rejects.toThrow();
  });
});
