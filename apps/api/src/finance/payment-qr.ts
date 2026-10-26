import { grayscale, type PDFPage } from 'pdf-lib';
import QRCode from 'qrcode';

/** The ČBA recommendation for printed QR Platba: error correction level M (about 15 %). */
const ERROR_CORRECTION = 'M';
/** Light margin around the symbol, in modules (the QR standard's quiet zone). */
const QUIET_MODULES = 4;

/**
 * Draws a QR Platba code into a PDF page as vector modules (sharp at any zoom or print size): an
 * opaque white square of `sizePt` (quiet zone included) with its top-left corner at (xPt, yTopPt)
 * in PDF points measured from the page bottom. Returns the module count for the caller's checks.
 */
export function drawPaymentQr(
  page: PDFPage,
  payload: string,
  box: { xPt: number; yTopPt: number; sizePt: number },
): { modules: number } {
  const qr = QRCode.create(payload, { errorCorrectionLevel: ERROR_CORRECTION });
  const size = qr.modules.size;
  const modulePt = box.sizePt / (size + 2 * QUIET_MODULES);
  page.drawRectangle({
    x: box.xPt,
    y: box.yTopPt - box.sizePt,
    width: box.sizePt,
    height: box.sizePt,
    color: grayscale(1),
  });
  // One path, horizontal runs of dark modules; drawSvgPath's y grows downwards from its origin.
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
    x: box.xPt + QUIET_MODULES * modulePt,
    y: box.yTopPt - QUIET_MODULES * modulePt,
    scale: modulePt,
    color: grayscale(0),
  });
  return { modules: size };
}
