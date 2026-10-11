import { createHash } from 'node:crypto';
import { grayscale, PDFDocument, StandardFonts, type PDFFont, type PDFPage } from 'pdf-lib';
import type { RenderableTemplateVersion } from './label-templates.service.js';
import {
  drawDevMarker,
  drawQrCode,
  embedArtwork,
  mm,
  qrSymbolInfo,
  type QrErrorCorrection,
} from './label-pdf-renderer.js';

/**
 * Print calibration and QR validation documents (doc 016, "QR validation"). They are test prints,
 * not bottle labels: their QR codes use the reserved, never-resolving host `qr.invalid`, which has
 * exactly the same URL structure and length as the production QR URL
 * (`https://qr.invalid/<22 chars>` has the production host length), so the symbols have the production
 * module density without ever encoding a production URL.
 */
export const VALIDATION_URL_BASE = 'https://qr.invalid';

/** Variants on the validation sheet. 15 mm / Q is the current (provisional) candidate. */
export const VALIDATION_SIZES_MM = [10, 12, 15, 18] as const;
export const VALIDATION_LEVELS = ['M', 'Q'] as const satisfies readonly QrErrorCorrection[];
export const CANDIDATE = { sizeMm: 15, level: 'Q' as QrErrorCorrection };

/** Deterministic 22-character test token per variant (base64url, like a real token). */
export function validationUrl(variantId: string): string {
  const token = createHash('sha256')
    .update(`ayvo-qr-validation:${variantId}`)
    .digest()
    .subarray(0, 16);
  return `${VALIDATION_URL_BASE}/${token.toString('base64url')}`;
}

export const variantId = (sizeMm: number, level: QrErrorCorrection) => `V${sizeMm}-${level}`;

export const A4 = { widthMm: 210, heightMm: 297 };

export interface ValidationVariant {
  id: string;
  sizeMm: number;
  level: QrErrorCorrection;
  candidate: boolean;
  url: string;
  /** Top-left corner of the QR box (quiet zone included) on the A4 sheet, in mm. */
  xMm: number;
  yMm: number;
}

/**
 * Every variant on the validation sheet with its position — the single definition used by the
 * renderer, the tests and `pnpm label-artifacts` to locate and decode each QR code.
 */
export function validationSheetVariants(): ValidationVariant[] {
  const columnsMm = [20, 112];
  const variants: ValidationVariant[] = [];
  let rowTop = 62;
  for (const sizeMm of VALIDATION_SIZES_MM) {
    VALIDATION_LEVELS.forEach((level, column) => {
      const id = variantId(sizeMm, level);
      variants.push({
        id,
        sizeMm,
        level,
        candidate: sizeMm === CANDIDATE.sizeMm && level === CANDIDATE.level,
        url: validationUrl(id),
        xMm: columnsMm[column]!,
        yMm: rowTop,
      });
    });
    rowTop += Math.max(sizeMm, 16) + 34;
  }
  return variants;
}
/** Physical conditions every variant must pass before a production QR size/EC is approved. */
export const SCAN_TEST_CHECKLIST = [
  'Immediately after printing',
  'On the actual curved bottle',
  'Warehouse lighting',
  'Hotel lighting',
  'While wet',
  'After repeated washing (record cycles)',
  'Modern phone camera',
  'Older phone / handheld scanner',
] as const;

const SCALING_WARNING = 'PRINT AT 100 % (ACTUAL SIZE) - DISABLE "FIT TO PAGE" / ANY SCALING';

interface Fonts {
  regular: PDFFont;
  bold: PDFFont;
}

/** A4 sheet with every size × error-correction variant, a 10 mm reference and a 100 mm ruler. */
export async function renderQrValidationSheet(opts: {
  environment: string;
  generatedAt: Date;
}): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  doc.setTitle('AYVO OS - QR print validation sheet');
  doc.setProducer('AYVO OS');
  const fonts = await embedFonts(doc);
  const page = doc.addPage([mm(A4.widthMm), mm(A4.heightMm)]);
  const H = page.getHeight();
  const text = (s: string, xMm: number, yMm: number, size: number, bold = false) =>
    page.drawText(s, {
      x: mm(xMm),
      y: H - mm(yMm),
      size,
      font: bold ? fonts.bold : fonts.regular,
      color: grayscale(0),
    });

  text('AYVO OS - QR print validation sheet', 15, 18, 14, true);
  text(`Page size: ${A4.widthMm} x ${A4.heightMm} mm (A4)`, 15, 25, 9);
  text(SCALING_WARNING, 15, 31, 9, true);
  drawReference(page, fonts, 15, 38);

  for (const v of validationSheetVariants()) {
    drawQrCode(page, { xMm: v.xMm, yMm: v.yMm, widthMm: v.sizeMm }, v.url, H, v.level);
    // Thin outline = the box placed in the designer (quiet zone included).
    page.drawRectangle({
      x: mm(v.xMm),
      y: H - mm(v.yMm + v.sizeMm),
      width: mm(v.sizeMm),
      height: mm(v.sizeMm),
      borderColor: grayscale(0.6),
      borderWidth: 0.25,
    });
    const info = qrSymbolInfo(v.url, v.sizeMm, v.level);
    const cx = v.xMm + v.sizeMm + 4;
    text(
      v.id + (v.candidate ? '  - production candidate (provisional)' : ''),
      cx,
      v.yMm + 4,
      9,
      true,
    );
    text(`${v.sizeMm} mm incl. quiet zone - error correction ${v.level}`, cx, v.yMm + 9, 7);
    text(
      `QR version ${info.version} (${info.modules} x ${info.modules} modules), module ${info.moduleMm.toFixed(3)} mm`,
      cx,
      v.yMm + 13,
      7,
    );
  }

  text('Scan-test checklist (each variant, record results in ADR 0014):', 15, 246, 9, true);
  SCAN_TEST_CHECKLIST.forEach((item, i) =>
    text(`[  ] ${item}`, 15 + (i % 2) * 95, 252 + Math.floor(i / 2) * 5, 8),
  );
  const footer = [
    'Test URLs use the reserved host qr.invalid: same structure and 22-character token length as the',
    'production QR URL, so the symbols have the production module density; they intentionally do not resolve.',
    `Generated ${opts.generatedAt.toISOString()} by AYVO OS (${opts.environment}). Test print - not a bottle label.`,
  ];
  footer.forEach((line, i) => text(line, 15, 276 + i * 4.5, 7));
  return doc.save();
}

/**
 * One page at the template version's exact size: artwork, the QR at its designed position (test
 * URL, configured error correction), page dimensions, a 10 mm reference and the scaling warning.
 */
export async function renderTemplateCalibration(opts: {
  template: Pick<
    RenderableTemplateVersion,
    'ref' | 'widthMm' | 'heightMm' | 'artwork' | 'elements'
  >;
  errorCorrection: QrErrorCorrection;
  devMarker: boolean;
}): Promise<Uint8Array> {
  const { template, errorCorrection } = opts;
  const doc = await PDFDocument.create();
  doc.setTitle(`AYVO OS - calibration ${template.ref.label}`);
  doc.setProducer('AYVO OS');
  const fonts = await embedFonts(doc);
  const W = mm(template.widthMm);
  const H = mm(template.heightMm);
  const page = doc.addPage([W, H]);

  (await embedArtwork(doc, template.artwork, W, H))(page);
  if (opts.devMarker) drawDevMarker(page, fonts.bold);

  const qr = template.elements.find((e) => e.type === 'QR_CODE');
  const id = qr ? variantId(qr.widthMm, errorCorrection) : '-';
  const lines = [
    `CALIBRATION ${template.ref.label}`,
    `Page ${template.widthMm} x ${template.heightMm} mm`,
    qr ? `QR ${id}: ${qr.widthMm} mm, EC ${errorCorrection}` : 'No QR element',
    'PRINT AT 100 % - NO SCALING',
  ];
  const size = Math.max(3, Math.min(7, W / 32));
  const top = (opts.devMarker ? Math.min(mm(5), H * 0.15) : 0) + mm(2);
  const boxWidth = Math.max(...lines.map((l) => fonts.bold.widthOfTextAtSize(l, size))) + mm(2);
  page.drawRectangle({
    x: mm(1),
    y: H - top - lines.length * size * 1.3 - mm(1),
    width: boxWidth,
    height: lines.length * size * 1.3 + mm(1),
    color: grayscale(1),
  });
  lines.forEach((line, i) =>
    page.drawText(line, {
      x: mm(2),
      y: H - top - (i + 1) * size * 1.3,
      size,
      font: i === 0 ? fonts.bold : fonts.regular,
      color: grayscale(0),
    }),
  );

  // 10 mm reference bar along the bottom edge.
  const barTop = template.heightMm - 6;
  page.drawRectangle({
    x: mm(2) - 2,
    y: H - mm(barTop + 2) - 2,
    width: mm(10) + 4 + fonts.regular.widthOfTextAtSize('10 mm', size) + mm(2),
    height: mm(2) + 4,
    color: grayscale(1),
  });
  page.drawRectangle({
    x: mm(2),
    y: H - mm(barTop + 2),
    width: mm(10),
    height: mm(2),
    color: grayscale(0),
  });
  page.drawText('10 mm', {
    x: mm(13),
    y: H - mm(barTop + 1.7),
    size,
    font: fonts.regular,
    color: grayscale(0),
  });

  if (qr) drawQrCode(page, qr, validationUrl(id), H, errorCorrection);
  return doc.save();
}

/** 10 mm reference bar plus a 100 mm ruler with 10 mm ticks, starting at (xMm, yMm). */
function drawReference(page: PDFPage, fonts: Fonts, xMm: number, yMm: number): void {
  const H = page.getHeight();
  page.drawRectangle({
    x: mm(xMm),
    y: H - mm(yMm + 3),
    width: mm(10),
    height: mm(3),
    color: grayscale(0),
  });
  page.drawText('<- exactly 10.0 mm: measure it. Any other value means the print was scaled.', {
    x: mm(xMm + 13),
    y: H - mm(yMm + 2.3),
    size: 8,
    font: fonts.regular,
    color: grayscale(0),
  });
  const rulerY = yMm + 9;
  page.drawLine({
    start: { x: mm(xMm), y: H - mm(rulerY) },
    end: { x: mm(xMm + 100), y: H - mm(rulerY) },
    thickness: 0.5,
    color: grayscale(0),
  });
  for (let i = 0; i <= 10; i++) {
    const tick = i % 5 === 0 ? 3 : 1.5;
    page.drawLine({
      start: { x: mm(xMm + i * 10), y: H - mm(rulerY) },
      end: { x: mm(xMm + i * 10), y: H - mm(rulerY + tick) },
      thickness: 0.5,
      color: grayscale(0),
    });
  }
  page.drawText('0', {
    x: mm(xMm) - 1.5,
    y: H - mm(rulerY + 6),
    size: 7,
    font: fonts.regular,
    color: grayscale(0),
  });
  page.drawText('100 mm', {
    x: mm(xMm + 100) - 8,
    y: H - mm(rulerY + 6),
    size: 7,
    font: fonts.regular,
    color: grayscale(0),
  });
}

async function embedFonts(doc: PDFDocument): Promise<Fonts> {
  return {
    regular: await doc.embedFont(StandardFonts.Helvetica),
    bold: await doc.embedFont(StandardFonts.HelveticaBold),
  };
}
