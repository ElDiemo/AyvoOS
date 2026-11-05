import { fileURLToPath } from 'node:url';
import PDFDocument from 'pdfkit';
import { DRAFT_MARK, type ContractDocument } from './contract-template.js';

const FONT_DIR = fileURLToPath(new URL('./fonts/', import.meta.url));
const MARGIN = 56;
const A4 = { width: 595.28, height: 841.89 };
const WIDTH = A4.width - 2 * MARGIN;

/**
 * A printable A4 PDF of one contract-draft revision (doc 045): the draft mark on top and at the
 * foot of every page with the page number, the embedded Noto Sans (Czech exactly), fixed metadata
 * (as the invoice PDF). Rendered from the saved revision only; nothing is computed here.
 */
export async function renderContractPdf(d: ContractDocument): Promise<Buffer> {
  const doc = new PDFDocument({
    size: 'A4',
    margins: { top: MARGIN + 18, bottom: MARGIN + 18, left: MARGIN, right: MARGIN },
    bufferPages: true,
    info: {
      Title: `${d.title} — ${DRAFT_MARK}`,
      Producer: 'AYVO OS',
      Creator: 'AYVO OS',
      CreationDate: new Date(0),
      ModDate: new Date(0),
    },
  });
  const chunks: Buffer[] = [];
  doc.on('data', (c: Buffer) => chunks.push(c));
  const done = new Promise<Buffer>((resolve, reject) => {
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
  });
  doc.registerFont('regular', `${FONT_DIR}NotoSans-Regular.ttf`);
  doc.registerFont('bold', `${FONT_DIR}NotoSans-Bold.ttf`);

  doc.font('bold').fontSize(16).text(d.title, { width: WIDTH });
  doc.moveDown(0.3);
  doc.font('regular').fontSize(9).fillColor('#57534e');
  for (const line of d.meta) doc.text(line, { width: WIDTH });
  doc.moveDown(0.6);
  doc.fillColor('#92400e').font('bold').fontSize(9).text(d.notice, { width: WIDTH });
  doc.fillColor('#000000');
  for (const s of d.sections) {
    doc.moveDown(0.9);
    doc.font('bold').fontSize(11).text(s.heading, { width: WIDTH });
    doc.moveDown(0.25);
    doc.font('regular').fontSize(10);
    for (const p of s.paragraphs) doc.text(p, { width: WIDTH, paragraphGap: 3 });
  }
  doc.moveDown(2);
  doc.font('regular').fontSize(10);
  for (const s of d.signatures) {
    doc.text(s, { width: WIDTH });
    doc.moveDown(1.5);
  }

  // The mark on every page, top and bottom, with "strana x / n".
  const range = doc.bufferedPageRange();
  for (let i = range.start; i < range.start + range.count; i++) {
    doc.switchToPage(i);
    const bottom = doc.page.margins.bottom;
    doc.page.margins.bottom = 0;
    doc.font('bold').fontSize(9).fillColor('#b91c1c');
    doc.text(DRAFT_MARK, MARGIN, MARGIN - 10, { width: WIDTH, align: 'center', lineBreak: false });
    doc.font('regular').fontSize(8).fillColor('#57534e');
    doc.text(
      `${DRAFT_MARK} · strana ${i - range.start + 1} / ${range.count}`,
      MARGIN,
      A4.height - MARGIN + 8,
      { width: WIDTH, align: 'center', lineBreak: false },
    );
    doc.page.margins.bottom = bottom;
  }
  doc.fillColor('#000000');
  doc.end();
  return done;
}
