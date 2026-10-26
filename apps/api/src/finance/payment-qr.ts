import QRCode from 'qrcode';

/** The ČBA recommendation for printed QR Platba: error correction level M (about 15 %). */
const ERROR_CORRECTION = 'M';
/** Light margin around the symbol, in modules (the QR standard's quiet zone). */
const QUIET_MODULES = 4;

/**
 * Draws a QR Platba code into a pdfkit page as vector modules (sharp at any zoom or print size): an
 * opaque white square of `size` points (quiet zone included) with its top-left corner at (x, y)
 * (pdfkit coordinates: points from the top-left of the page). Returns the module count.
 */
export function drawPaymentQr(
  doc: PDFKit.PDFDocument,
  payload: string,
  box: { x: number; y: number; size: number },
): { modules: number } {
  const qr = QRCode.create(payload, { errorCorrectionLevel: ERROR_CORRECTION });
  const size = qr.modules.size;
  const module = box.size / (size + 2 * QUIET_MODULES);
  doc.save();
  doc.rect(box.x, box.y, box.size, box.size).fill('#ffffff');
  const left = box.x + QUIET_MODULES * module;
  const top = box.y + QUIET_MODULES * module;
  // Horizontal runs of dark modules, one fill.
  for (let row = 0; row < size; row++) {
    let col = 0;
    while (col < size) {
      if (!qr.modules.get(row, col)) {
        col++;
        continue;
      }
      const start = col;
      while (col < size && qr.modules.get(row, col)) col++;
      doc.rect(left + start * module, top + row * module, (col - start) * module, module);
    }
  }
  doc.fill('#000000');
  doc.restore();
  return { modules: size };
}
