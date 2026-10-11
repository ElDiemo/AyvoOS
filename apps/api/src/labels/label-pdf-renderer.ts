import { qrGeometry, type LabelElement, type QrErrorCorrection } from '@ayvo/types';
import { grayscale, PDFDocument, rgb, StandardFonts, type PDFFont, type PDFPage } from 'pdf-lib';
import QRCode from 'qrcode';
import { DEV_LABEL_MARKER } from '../common/qr-policy.js';
import { exactCopy } from './artwork-inspector.js';
import { PT_PER_MM, svgToPdf } from './artwork-pdf.js';
import type { RenderableTemplateVersion } from './label-templates.service.js';

export { QR_QUIET_ZONE_MODULES, type QrErrorCorrection } from '@ayvo/types';

export interface LabelToRender {
  /** Human-readable bottle code (not printed in v0.1; used for document structure/debugging). */
  code: string;
  /** The ONLY content of the QR code: the bottle's stable public URL. */
  url: string;
}

export interface LabelPdfInput {
  title: string;
  template: Pick<RenderableTemplateVersion, 'widthMm' | 'heightMm' | 'artwork' | 'elements'>;
  labels: readonly LabelToRender[];
  /** Error correction level of every QR code (snapshot on the print job). */
  errorCorrection: QrErrorCorrection;
  /** Non-production jobs print a visible "DEV - NOT FOR PRODUCTION" band on every label. */
  devMarker: boolean;
}

/** Renders print-ready label PDFs. Injectable so tests can simulate rendering failures. */
export abstract class LabelPdfRenderer {
  abstract render(input: LabelPdfInput): Promise<Uint8Array>;
}

export const mm = (value: number) => value * PT_PER_MM;

/**
 * One label = one PDF page of exactly the template's physical size (no bleed, no crop marks, no
 * imposition; print at 100 %). The artwork is embedded ONCE (image or vector Form XObject) and
 * reused on every page; each page adds its own vector QR code at the stored millimetre position.
 * Coordinates: the template uses a top-left origin with y downwards; PDF uses bottom-left.
 */
export class PdfLibLabelRenderer extends LabelPdfRenderer {
  async render({
    title,
    template,
    labels,
    errorCorrection,
    devMarker,
  }: LabelPdfInput): Promise<Uint8Array> {
    if (labels.length === 0) throw new Error('No labels to render');
    const width = mm(template.widthMm);
    const height = mm(template.heightMm);

    const doc = await PDFDocument.create();
    doc.setTitle(devMarker ? `${title} · ${DEV_LABEL_MARKER}` : title);
    doc.setProducer('AYVO OS');
    doc.setCreator('AYVO OS');

    const drawArtwork = await embedArtwork(doc, template.artwork, width, height);
    const font = devMarker ? await doc.embedFont(StandardFonts.HelveticaBold) : null;
    for (const label of labels) {
      const page = doc.addPage([width, height]);
      drawArtwork(page);
      if (font) drawDevMarker(page, font);
      // QR codes last, so nothing ever covers them.
      for (const element of template.elements) {
        if (element.type === 'QR_CODE') {
          drawQrCode(page, element, label.url, height, errorCorrection);
        }
      }
    }
    return doc.save({ useObjectStreams: true });
  }
}

export async function embedArtwork(
  doc: PDFDocument,
  artwork: RenderableTemplateVersion['artwork'],
  width: number,
  height: number,
): Promise<(page: PDFPage) => void> {
  const box = { x: 0, y: 0, width, height };
  switch (artwork.format) {
    case 'PNG': {
      const image = await doc.embedPng(exactCopy(artwork.bytes));
      return (page) => page.drawImage(image, box);
    }
    case 'JPEG': {
      const image = await doc.embedJpg(exactCopy(artwork.bytes));
      return (page) => page.drawImage(image, box);
    }
    case 'SVG': {
      const vector = await svgToPdf(artwork.bytes.toString('utf8'), width, height);
      const [embedded] = await doc.embedPdf(vector, [0]);
      if (!embedded) throw new Error('SVG artwork produced no page');
      return (page) => page.drawPage(embedded, box);
    }
  }
}

/**
 * Red "DEV - NOT FOR PRODUCTION" band across the top of a label (non-production jobs only).
 * Drawn over the artwork and under the QR code.
 */
export function drawDevMarker(page: PDFPage, font: PDFFont): void {
  const { width, height } = page.getSize();
  const bandHeight = Math.min(mm(5), height * 0.15);
  const fontSize = Math.min(
    bandHeight * 0.6,
    (width * 0.9) / font.widthOfTextAtSize(DEV_LABEL_MARKER, 1),
  );
  page.drawRectangle({
    x: 0,
    y: height - bandHeight,
    width,
    height: bandHeight,
    color: rgb(0.86, 0.15, 0.15),
  });
  page.drawText(DEV_LABEL_MARKER, {
    x: (width - font.widthOfTextAtSize(DEV_LABEL_MARKER, fontSize)) / 2,
    y: height - bandHeight + (bandHeight - fontSize * 0.7) / 2,
    size: fontSize,
    font,
    color: rgb(1, 1, 1),
  });
}

/** QR symbol facts for a URL, e.g. for captions on calibration sheets. */
export function qrSymbolInfo(url: string, boxMm: number, errorCorrection: QrErrorCorrection) {
  const qr = QRCode.create(url, { errorCorrectionLevel: errorCorrection });
  const modules = qr.modules.size;
  return {
    version: qr.version,
    modules,
    moduleMm: qrGeometry({ xMm: 0, yMm: 0, widthMm: boxMm }, modules).moduleMm,
  };
}

/**
 * Draws the QR code as vector rectangles in solid black (DeviceGray 0, device-independent) on an
 * opaque white square (DeviceGray 1) covering the whole element box, so the quiet zone stays
 * light whatever the artwork underneath. Whether the printer workflow maps this to pure K black
 * must be verified with the actual printer (doc 016). The element box (xMm, yMm, widthMm)
 * includes the quiet zone; the module size follows from the symbol version.
 */
export function drawQrCode(
  page: PDFPage,
  element: Pick<LabelElement, 'xMm' | 'yMm' | 'widthMm'>,
  url: string,
  pageHeightPt: number,
  errorCorrection: QrErrorCorrection,
): void {
  const qr = QRCode.create(url, { errorCorrectionLevel: errorCorrection });
  const size = qr.modules.size;
  // Shared geometry (packages/types): the browser preview places the symbol identically.
  const geometry = qrGeometry(element, size);
  const modulePt = mm(geometry.moduleMm);

  const left = mm(element.xMm);
  const top = pageHeightPt - mm(element.yMm);
  const boxPt = mm(element.widthMm);
  page.drawRectangle({ x: left, y: top - boxPt, width: boxPt, height: boxPt, color: grayscale(1) });

  // One path for all dark modules; horizontal runs keep it compact. drawSvgPath uses SVG
  // orientation (y downwards from the given origin), matching the module matrix.
  let path = '';
  for (let row = 0; row < size; row++) {
    let col = 0;
    while (col < size) {
      if (!qr.modules.get(row, col)) {
        col++;
        continue;
      }
      const start = col;
      while (col < size && qr.modules.get(row, col)) col++;
      path += `M${start} ${row}h${col - start}v1h${start - col}z`;
    }
  }
  page.drawSvgPath(path, {
    x: mm(geometry.symbol.xMm),
    y: pageHeightPt - mm(geometry.symbol.yMm),
    scale: modulePt,
    color: grayscale(0),
  });
}
