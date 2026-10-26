import { fileURLToPath } from 'node:url';
import PDFDocument from 'pdfkit';
import { drawPaymentQr } from './payment-qr.js';
import { spayd } from './spayd.js';

/**
 * The PDF of an issued invoice, rendered ONLY from the invoice's own frozen snapshot (N3A-2b, doc
 * 040 §5/§8): the issuer, customer, hotel, lines, totals and payment instructions as they were at
 * issuing — a later change of any setting never changes it. Nothing is computed here: amounts are
 * the snapshot's exact decimal strings, only regrouped for print. Czech text with the embedded Noto
 * Sans (OFL, fonts/SOURCE.md). The same snapshot always gives the same bytes (fixed metadata), so
 * the stored file's hash identifies it. A TEST invoice (DEV, synthetic) carries an unmistakable
 * "TESTOVACÍ DOKLAD — NEPLATNÝ" on every page.
 */
export interface InvoicePdfSnapshot {
  environment: 'TEST' | 'LIVE';
  number: string;
  /** "YYYY-MM-DD" */
  issuedOn: string;
  taxPointOn: string | null;
  dueOn: string;
  /** "YYYY-MM": the billed month. */
  period: string;
  issuer: {
    legalName: string;
    address: string[];
    companyId: string;
    vatId: string | null;
    registration: string | null;
    email: string;
    phone: string | null;
    web: string | null;
  };
  customer: {
    legalName: string;
    address: string[];
    companyId: string | null;
    vatId: string | null;
  };
  hotel: { code: string; name: string };
  lines: {
    description: string;
    quantity: string;
    unit: string;
    unitPrice: string;
    amount: string;
  }[];
  /** Printed as given; null rows are left out. The accountant decides VAT (doc 040 §7). */
  totals: { base: string | null; vat: string | null; total: string; currency: string };
  /** E.g. the wording for a non-payer or reverse charge — as the accountant confirms it. */
  vatNote: string | null;
  payment: {
    /** Czech domestic form "prefix-number/bank", if any. */
    account: string | null;
    iban: string;
    bic: string | null;
    amount: string;
    currency: string;
    variableSymbol: string;
    dueOn: string;
    message: string | null;
  };
}

const FONT_DIR = fileURLToPath(new URL('./fonts/', import.meta.url));
const MARGIN = 50;
const A4 = { width: 595.28, height: 841.89 };

/** "2026-10-26" → "26. 10. 2026" */
export const czDate = (iso: string) => {
  const [y, m, d] = iso.split('-');
  return `${Number(d)}. ${Number(m)}. ${y}`;
};
/** "1500.5" / "-1668.59" → "1 500,50" (the exact decimal, only regrouped; never a float). */
export const czAmount = (amount: string) => {
  const negative = amount.startsWith('-');
  const [whole, fraction = ''] = amount.replace('-', '').split('.');
  const grouped = whole!.replace(/\B(?=(\d{3})+(?!\d))/g, '\u00a0');
  return `${negative ? '−' : ''}${grouped},${fraction.padEnd(2, '0').slice(0, 2)}`;
};

export function renderInvoicePdf(s: InvoicePdfSnapshot): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    // Fixed metadata: the same snapshot renders the same bytes.
    const fixed = new Date(`${s.issuedOn}T00:00:00.000Z`);
    const doc = new PDFDocument({
      size: 'A4',
      margin: MARGIN,
      autoFirstPage: true,
      info: {
        Title: `Faktura ${s.number}`,
        Author: s.issuer.legalName,
        Creator: 'AYVO OS',
        Producer: 'AYVO OS',
        CreationDate: fixed,
        ModDate: fixed,
      },
    });
    const chunks: Buffer[] = [];
    doc.on('data', (c: Buffer) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
    doc.registerFont('regular', `${FONT_DIR}NotoSans-Regular.ttf`);
    doc.registerFont('bold', `${FONT_DIR}NotoSans-Bold.ttf`);

    const width = A4.width - 2 * MARGIN;
    const testMark = () => {
      if (s.environment !== 'TEST') return;
      doc.save();
      doc.rotate(-35, { origin: [A4.width / 2, A4.height / 2] });
      doc.font('bold').fontSize(46).fillColor('#d0d0d0').fillOpacity(0.6);
      doc.text('TESTOVACÍ DOKLAD', 0, A4.height / 2 - 60, { width: A4.width, align: 'center' });
      doc.text('NEPLATNÝ', 0, A4.height / 2, { width: A4.width, align: 'center' });
      doc.restore();
      doc.fillOpacity(1);
    };
    doc.on('pageAdded', testMark);
    testMark();

    // Header
    if (s.environment === 'TEST') {
      doc.rect(MARGIN, MARGIN - 30, width, 20).fill('#b42318');
      doc.font('bold').fontSize(10).fillColor('#ffffff');
      doc.text('TESTOVACÍ DOKLAD — NEPLATNÝ, NEPLATIT (AYVO OS DEV)', MARGIN, MARGIN - 25, {
        width,
        align: 'center',
      });
    }
    doc
      .fillColor('#000000')
      .font('bold')
      .fontSize(20)
      .text(`Faktura ${s.number}`, MARGIN, MARGIN + 4);
    doc.font('regular').fontSize(10).fillColor('#444444');
    doc.text(
      `Fakturované období: ${s.period.slice(5)}/${s.period.slice(0, 4)} · hotel ${s.hotel.code} ${s.hotel.name}`,
    );
    doc.moveDown(1);

    // Parties
    const top = doc.y;
    const col = width / 2 - 10;
    const party = (title: string, x: number, lines: (string | null)[]) => {
      doc
        .font('bold')
        .fontSize(9)
        .fillColor('#666666')
        .text(title.toUpperCase(), x, top, { width: col });
      doc.font('regular').fontSize(10).fillColor('#000000');
      for (const line of lines) if (line) doc.text(line, x, doc.y, { width: col });
      return doc.y;
    };
    const iss = s.issuer;
    const leftEnd = party('Dodavatel', MARGIN, [
      iss.legalName,
      ...iss.address,
      `IČO: ${iss.companyId}`,
      iss.vatId ? `DIČ: ${iss.vatId}` : null,
      iss.registration,
      iss.email,
      iss.phone,
      iss.web,
    ]);
    const c = s.customer;
    const rightEnd = party('Odběratel', MARGIN + col + 20, [
      c.legalName,
      ...c.address,
      c.companyId ? `IČO: ${c.companyId}` : null,
      c.vatId ? `DIČ: ${c.vatId}` : null,
    ]);
    doc.y = Math.max(leftEnd, rightEnd) + 14;

    // Dates
    const dates: [string, string][] = [
      ['Datum vystavení', czDate(s.issuedOn)],
      ...(s.taxPointOn ? ([['DUZP', czDate(s.taxPointOn)]] as [string, string][]) : []),
      ['Datum splatnosti', czDate(s.dueOn)],
      ['Variabilní symbol', s.payment.variableSymbol],
    ];
    doc.font('regular').fontSize(10);
    for (const [k, v] of dates) {
      const y = doc.y;
      doc.fillColor('#666666').text(k, MARGIN, y, { width: 140 });
      doc.fillColor('#000000').text(v, MARGIN + 140, y, { width: 200 });
    }
    doc.moveDown(1);

    // Lines
    const cols = [
      { title: 'Položka', w: width - 300, align: 'left' as const },
      { title: 'Množství', w: 80, align: 'right' as const },
      { title: 'Cena za jednotku', w: 110, align: 'right' as const },
      { title: `Celkem ${s.totals.currency}`, w: 110, align: 'right' as const },
    ];
    const row = (cells: string[], font: 'regular' | 'bold') => {
      const y = doc.y;
      let x = MARGIN;
      let bottom = y;
      doc.font(font).fontSize(10).fillColor('#000000');
      cells.forEach((cell, i) => {
        doc.text(cell, x, y, { width: cols[i]!.w - 6, align: cols[i]!.align });
        bottom = Math.max(bottom, doc.y);
        x += cols[i]!.w;
      });
      doc.y = bottom + 4;
    };
    row(
      cols.map((h) => h.title),
      'bold',
    );
    doc
      .moveTo(MARGIN, doc.y)
      .lineTo(MARGIN + width, doc.y)
      .strokeColor('#999999')
      .stroke();
    doc.y += 4;
    for (const l of s.lines)
      row(
        [
          l.description,
          `${l.quantity.replace('.', ',')} ${l.unit}`,
          czAmount(l.unitPrice),
          czAmount(l.amount),
        ],
        'regular',
      );
    doc
      .moveTo(MARGIN, doc.y)
      .lineTo(MARGIN + width, doc.y)
      .stroke();
    doc.y += 6;

    // Totals
    const total = (label: string, value: string, bold = false) => {
      const y = doc.y;
      doc.font(bold ? 'bold' : 'regular').fontSize(bold ? 12 : 10);
      doc.text(label, MARGIN + width - 330, y, { width: 210, align: 'right' });
      doc.text(`${czAmount(value)} ${s.totals.currency}`, MARGIN + width - 120, y, {
        width: 120,
        align: 'right',
      });
    };
    if (s.totals.base !== null) total('Základ', s.totals.base);
    if (s.totals.vat !== null) total('DPH', s.totals.vat);
    total('Celkem k úhradě', s.totals.total, true);
    if (s.vatNote) {
      doc.moveDown(0.5).font('regular').fontSize(9).fillColor('#444444');
      doc.text(s.vatNote, MARGIN, doc.y, { width });
    }
    doc.moveDown(1.5);

    // Payment
    const p = s.payment;
    const payTop = doc.y;
    doc.font('bold').fontSize(11).fillColor('#000000').text('Platební údaje', MARGIN, payTop);
    doc.font('regular').fontSize(10);
    for (const line of [
      p.account ? `Číslo účtu: ${p.account}` : null,
      `IBAN: ${p.iban}`,
      p.bic ? `BIC: ${p.bic}` : null,
      `Částka: ${czAmount(p.amount)} ${p.currency}`,
      `Variabilní symbol: ${p.variableSymbol}`,
      `Splatnost: ${czDate(p.dueOn)}`,
    ])
      if (line) doc.text(line, MARGIN, doc.y, { width: width - 160 });
    if (p.currency === 'CZK') {
      const code = spayd({
        iban: p.iban,
        bic: p.bic,
        amount: p.amount,
        currency: p.currency,
        variableSymbol: p.variableSymbol,
        dueDate: p.dueOn,
        message: p.message,
      });
      drawPaymentQr(doc, code, { x: MARGIN + width - 140, y: payTop, size: 140 });
      doc.font('regular').fontSize(8).fillColor('#444444');
      doc.text('QR Platba', MARGIN + width - 140, payTop + 142, { width: 140, align: 'center' });
    }
    doc.end();
  });
}
