import PDFDocument from 'pdfkit';
import SVGtoPDF from 'svg-to-pdfkit';

export const PT_PER_MM = 72 / 25.4;

/**
 * Converts SVG artwork into a one-page vector PDF of exactly widthPt × heightPt, so it can be
 * embedded once as a reusable Form XObject in every label page (see label-pdf-renderer). The
 * artwork is stretched to the page (proportions are validated to match within 1%).
 */
export function svgToPdf(svg: string, widthPt: number, heightPt: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: [widthPt, heightPt], margin: 0, autoFirstPage: true });
    const chunks: Buffer[] = [];
    doc.on('data', (chunk: Buffer) => chunks.push(chunk));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
    try {
      SVGtoPDF(doc, svg, 0, 0, {
        width: widthPt,
        height: heightPt,
        preserveAspectRatio: 'none',
        warningCallback: () => undefined,
      });
      doc.end();
    } catch (error) {
      reject(error instanceof Error ? error : new Error('SVG conversion failed'));
    }
  });
}
