import { crateLabelLayout, type CrateLabelText, type QrErrorCorrection } from '@ayvo/types';
import { PDFDocument, rgb, StandardFonts, type PDFFont } from 'pdf-lib';
import { DEV_LABEL_MARKER } from '../common/qr-policy.js';
import { drawDevMarker, drawQrCode, mm } from './label-pdf-renderer.js';

export interface CodeLabelToRender extends CrateLabelText {
  /** The ONLY content of the QR code: the object's stable public URL. */
  url: string;
}

export interface CodeLabelPdfInput {
  title: string;
  widthMm: number;
  heightMm: number;
  labels: readonly CodeLabelToRender[];
  errorCorrection: QrErrorCorrection;
  /** Non-production jobs print the "DEV - NOT FOR PRODUCTION" band on every label. */
  devMarker: boolean;
  /** Preview only: a grey "PREVIEW" mark, so a preview page is never mistaken for a label. */
  previewMarker?: boolean;
}

export class LabelTooSmallError extends Error {}

/**
 * Renders simple artwork-free labels: a QR code plus a human-readable code and one auxiliary
 * line (crate labels, doc 025 A1). The label engine knows nothing about crates: callers pass
 * plain codes, texts and URLs. Injectable so tests can simulate rendering failures.
 */
export abstract class CodeLabelRenderer {
  abstract render(input: CodeLabelPdfInput): Promise<Uint8Array>;
}

/** One label = one PDF page of exactly the chosen size (no bleed, no crop marks; print at 100 %). */
export class PdfLibCodeLabelRenderer extends CodeLabelRenderer {
  async render(input: CodeLabelPdfInput): Promise<Uint8Array> {
    const { title, widthMm, heightMm, labels, errorCorrection, devMarker } = input;
    if (labels.length === 0) throw new Error('No labels to render');
    const layout = crateLabelLayout(widthMm, heightMm);
    if (!layout) throw new LabelTooSmallError('The label is too small for a readable QR code');
    const width = mm(widthMm);
    const height = mm(heightMm);

    const doc = await PDFDocument.create();
    doc.setTitle(devMarker ? `${title} · ${DEV_LABEL_MARKER}` : title);
    doc.setProducer('AYVO OS');
    doc.setCreator('AYVO OS');
    const bold = await doc.embedFont(StandardFonts.HelveticaBold);
    const regular = await doc.embedFont(StandardFonts.Helvetica);

    for (const label of labels) {
      const page = doc.addPage([width, height]);
      if (devMarker) drawDevMarker(page, bold);
      const { text } = layout;
      const centered = layout.orientation === 'stacked';
      const codeSize = fitText(
        bold,
        label.code,
        mm(text.widthMm),
        mm(Math.min(text.heightMm * 0.45, 9)),
      );
      const detailSize = fitText(regular, label.detail, mm(text.widthMm), codeSize * 0.6);
      const codeY = height - mm(text.yMm) - codeSize;
      drawLine(page, bold, label.code, codeSize, mm(text.xMm), mm(text.widthMm), codeY, centered);
      drawLine(
        page,
        regular,
        label.detail,
        detailSize,
        mm(text.xMm),
        mm(text.widthMm),
        codeY - detailSize * 1.4,
        centered,
      );
      if (input.previewMarker) {
        drawLine(page, bold, 'PREVIEW', codeSize * 0.6, 0, width, mm(1.5), true, 0.55);
      }
      // QR last, so nothing ever covers it.
      drawQrCode(
        page,
        { xMm: layout.qr.xMm, yMm: layout.qr.yMm, widthMm: layout.qr.sizeMm },
        label.url,
        height,
        errorCorrection,
      );
    }
    return doc.save({ useObjectStreams: true });
  }
}

/** Largest font size ≤ max at which the text fits the width. */
function fitText(font: PDFFont, value: string, widthPt: number, maxSize: number): number {
  return Math.min(maxSize, widthPt / Math.max(font.widthOfTextAtSize(value, 1), 1));
}

function drawLine(
  page: ReturnType<PDFDocument['addPage']>,
  font: PDFFont,
  value: string,
  size: number,
  x: number,
  widthPt: number,
  y: number,
  centered: boolean,
  gray = 0,
): void {
  const offset = centered ? (widthPt - font.widthOfTextAtSize(value, size)) / 2 : 0;
  page.drawText(value, { x: x + offset, y, size, font, color: rgb(gray, gray, gray) });
}
