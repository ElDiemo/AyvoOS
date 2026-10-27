import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  czAmount,
  InconsistentInvoiceSnapshot,
  renderInvoicePdf,
  type InvoicePdfSnapshot,
} from '../src/finance/invoice-pdf.js';
import { spayd, InvalidPaymentInstruction, type PaymentInstruction } from '../src/finance/spayd.js';
import { decodeQrOnPage, MM_PER_PT, openPdf, pageText } from './support/pdf-inspect.js';

/**
 * QR Platba and the invoice PDF (N3A-2b, doc 040 §8): the descriptor built from an invoice's own
 * payment details, the PDF rendered from the invoice snapshot only, then read back the way a phone
 * does (pdf.js raster + jsQR) and compared with the text printed on the same page — the same
 * account, exact amount with haléře, currency and the variable symbol with its leading zeros.
 * Czech text with the embedded Noto Sans; a TEST invoice says so on every page; the same snapshot
 * gives the same bytes. Synthetic companies and accounts only.
 */
const base: PaymentInstruction = {
  iban: 'CZ6508000000192000145399',
  bic: 'GIBACZPX',
  amount: '1500.50',
  currency: 'CZK',
  variableSymbol: '0012345',
  dueDate: '2026-11-10',
  message: 'FAKTURA 2026001',
};

/** Parses a descriptor back into its keys (values are %-encoded only for "*" and "%"). */
function parse(code: string): Record<string, string> {
  const [head, version, ...rest] = code.split('*');
  expect([head, version]).toEqual(['SPD', '1.0']);
  return Object.fromEntries(
    rest.map((p) => {
      const i = p.indexOf(':');
      return [p.slice(0, i), decodeURIComponent(p.slice(i + 1))];
    }),
  );
}

const invoice = (
  over: Partial<InvoicePdfSnapshot> = {},
  pay: Partial<InvoicePdfSnapshot['payment']> = {},
): InvoicePdfSnapshot => ({
  environment: 'TEST',
  number: '2026001',
  issuedOn: '2026-10-31',
  taxPointOn: '2026-10-31',
  dueOn: '2026-11-14',
  period: '2026-10',
  issuer: {
    legalName: 'Testovací vystavitel s.r.o.',
    address: ['Žluťoučká 1', '110 00 Praha', 'CZ'],
    companyId: '12345678',
    vatId: 'CZ12345678',
    registration: 'C 000000 vedená u testovacího soudu (syntetické)',
    email: 'fakturace@vystavitel.test',
    phone: null,
    web: null,
  },
  customer: {
    legalName: 'Hotelová společnost Říčany a.s.',
    address: ['Náměstí 2', '251 01 Říčany', 'CZ'],
    companyId: '87654321',
    vatId: null,
  },
  hotels: [{ code: 'HT-000001', name: 'Testovací hotel Šumava' }],
  lines: [
    {
      description: 'Služba AYVO — pokoje × měsíc 10/2026',
      quantity: '50',
      unit: 'pokojů',
      unitPrice: '37.51',
      amount: '1875.50',
    },
  ],
  totals: { base: null, vat: null, total: '1875.50', currency: 'CZK' },
  vatNote: null,
  payment: {
    account: '19-2000145399/0800',
    iban: 'CZ6508000000192000145399',
    bic: 'GIBACZPX',
    amount: '1875.50',
    currency: 'CZK',
    variableSymbol: '0012345',
    dueOn: '2026-11-14',
    message: 'FAKTURA 2026001',
    ...pay,
  },
  ...over,
});
/** Text as printed, with non-breaking spaces and column gaps as single spaces. */
const plain = (text: string) => text.replace(/\u00a0/g, ' ').replace(/\s+/g, ' ');

describe('QR Platba (SPAYD) and the invoice PDF', () => {
  it('the descriptor: only the keys every Czech bank processes; exact amount; leading zeros kept', () => {
    expect(spayd(base)).toBe(
      'SPD*1.0*ACC:CZ6508000000192000145399+GIBACZPX*AM:1500.50*CC:CZK*DT:20261110*MSG:FAKTURA 2026001*X-VS:0012345',
    );
    expect(
      spayd({
        ...base,
        amount: '7',
        bic: null,
        dueDate: null,
        message: null,
        variableSymbol: null,
      }),
    ).toBe('SPD*1.0*ACC:CZ6508000000192000145399*AM:7.00*CC:CZK');
    expect(spayd({ ...base, amount: '0.5' })).toContain('*AM:0.50*');
    expect(spayd({ ...base, message: 'A*B 100%' })).toContain('*MSG:A%2AB 100%25*');
  });

  it('refuses what does not fit instead of changing it', () => {
    for (const bad of [
      { currency: 'EUR' },
      { iban: 'CZ6508000000192000145398' },
      { amount: '1500.505' },
      { amount: '10000000.00' },
      { amount: '0.00' },
      { amount: '-1.00' },
      { variableSymbol: '12345678901' },
      { variableSymbol: '12-34' },
      { message: 'Faktura č. 1' },
      { message: 'X'.repeat(61) },
      { dueDate: '10.11.2026' },
    ])
      expect(() => spayd({ ...base, ...bad }), JSON.stringify(bad)).toThrow(
        InvalidPaymentInstruction,
      );
  });

  /** An invoice of one line, consistent by construction: quantity × unit price = amount = total. */
  const oneLine = (
    quantity: string,
    unitPrice: string,
    amount: string,
    pay: Partial<InvoicePdfSnapshot['payment']> = {},
  ) =>
    invoice(
      {
        lines: [
          {
            description: 'Služba AYVO — pokoje × měsíc 10/2026',
            quantity,
            unit: 'pokojů',
            unitPrice,
            amount,
          },
        ],
        totals: { base: null, vat: null, total: amount, currency: 'CZK' },
      },
      { amount, ...pay },
    );
  /** quantity × unit price in haléře, computed here independently (BigInt, never a float). */
  const product = (quantity: string, unitPrice: string) => {
    const [qw, qf = ''] = quantity.split('.');
    const [pw, pf = ''] = unitPrice.split('.');
    const q = BigInt(qw + qf.padEnd(3, '0'));
    const p = BigInt(pw + pf.padEnd(2, '0'));
    const v = q * p; // 10^-5
    if (v % 1000n !== 0n) return null; // not a whole haléř: no rounding rule is decided
    return v / 1000n;
  };
  const halere = (amount: string) => BigInt(amount.replace('.', '').replace(/^(-?)0+(?=\d)/, '$1'));

  it('read back from the rendered invoice like a phone: the QR equals the printed account, the computed total with haléře and VS', async () => {
    for (const [quantity, unitPrice, amount, pay] of [
      ['50', '37.51', '1875.50', {}],
      ['1', '0.01', '0.01', { variableSymbol: '0000000001' }],
      ['1', '9999999.99', '9999999.99', { bic: null, message: null, variableSymbol: '9' }],
      ['3', '333.33', '999.99', {}],
    ] as const) {
      // The test's own arithmetic: quantity × unit price is exactly the amount and the total.
      expect(product(quantity, unitPrice), `${quantity} × ${unitPrice}`).toBe(halere(amount));
      const snapshot = oneLine(quantity, unitPrice, amount, pay);
      const pdf = await openPdf(await renderInvoicePdf(snapshot));
      const qr = await decodeQrOnPage(pdf, 1);
      expect(qr, amount).not.toBeNull();
      const fields = parse(qr!.data);
      const printed = plain(await pageText(pdf, 1));
      const [iban] = fields.ACC!.split('+');
      expect(iban).toBe(snapshot.payment.iban);
      expect(printed).toContain(`IBAN: ${iban}`);
      expect(fields.CC).toBe('CZK');
      // The QR asks for exactly the computed total, which is also what the page prints.
      expect(halere(fields.AM!)).toBe(product(quantity, unitPrice));
      expect(printed).toContain(`Částka: ${plain(czAmount(fields.AM!))} CZK`);
      expect(printed).toContain(`Celkem k úhradě ${plain(czAmount(amount))} CZK`);
      expect(fields['X-VS']).toBe(snapshot.payment.variableSymbol);
      expect(printed).toContain(`Variabilní symbol: ${fields['X-VS']}`);
      expect(fields.DT).toBe('20261114');
    }
  });

  it('a long invoice over several pages (review BILL86-R4): every line whole on one page, the payment block with a readable QR on the last, text unchanged by the TEST mark', async () => {
    for (const n of [20, 45]) {
      const amount = (37.51 * n).toFixed(2);
      const snapshot = invoice(
        {
          hotels: Array.from({ length: n }, (_, i) => ({
            code: `HT-${String(i + 1).padStart(6, '0')}`,
            name: `Testovací hotel ${i + 1}`,
          })),
          lines: Array.from({ length: n }, (_, i) => ({
            description: `POLOZKA-${String(i + 1).padStart(2, '0')} Služba AYVO za hotel ${i + 1} — pokoje × měsíc 10/2026`,
            quantity: '1',
            unit: 'pok.',
            unitPrice: '37.51',
            amount: '37.51',
          })),
          totals: { base: null, vat: null, total: amount, currency: 'CZK' },
        },
        { amount },
      );
      const pdf = await openPdf(await renderInvoicePdf(snapshot));
      expect(pdf.pageCount, `${n} lines`).toBeGreaterThan(1);
      type Item = { text: string; page: number; y: number; size: number; font: string };
      const items: Item[] = [];
      const qrs: { page: number; data: string; bottomMm: number }[] = [];
      for (let p = 1; p <= pdf.pageCount; p++) {
        const page = await pdf.pdf.getPage(p);
        for (const it of (await page.getTextContent()).items)
          if ('str' in it && it.str.trim())
            items.push({
              text: it.str,
              page: p,
              y: it.transform[5] as number,
              size: Math.hypot(it.transform[0] as number, it.transform[1] as number),
              font: it.fontName,
            });
        expect(plain(await pageText(pdf, p))).toContain('NEPLATNÝ');
        const qr = await decodeQrOnPage(pdf, p, 6);
        if (qr) qrs.push({ page: p, data: qr.data, bottomMm: qr.symbolMm.bottom });
      }
      // Exactly one QR, whole and readable, above the bottom margin, on the payment page.
      expect(qrs.map((q) => q.page)).toEqual([pdf.pageCount]);
      expect(qrs[0]!.bottomMm).toBeLessThan(pdf.pageSizesMm[0]!.heightMm - 50 * MM_PER_PT);
      expect(parse(qrs[0]!.data).AM).toBe(amount);
      const last = plain(await pageText(pdf, pdf.pageCount));
      expect(last).toContain(`Částka: ${plain(czAmount(amount))} CZK`);
      expect(last).toContain(`Celkem k úhradě ${plain(czAmount(amount))} CZK`);
      // The TEST mark of a new page leaves the text as it was: the heading is 11 pt like on one page.
      const heading = items.find((i) => i.text === 'Platební údaje')!;
      expect([heading.page, Math.round(heading.size)]).toEqual([pdf.pageCount, 11]);
      const marks = new Set(['TESTOVACÍ DOKLAD', 'NEPLATNÝ']);
      expect(items.filter((i) => !marks.has(i.text) && i.size > 12.5).map((i) => i.text)).toEqual([
        `Faktura ${snapshot.number}`,
      ]);
      // Every line: description, unit price and amount on the same page at the same height.
      for (let i = 1; i <= n; i++) {
        const d = items.find((x) => x.text.startsWith(`POLOZKA-${String(i).padStart(2, '0')} `))!;
        const rowItems = items.filter((x) => x.page === d.page && Math.abs(x.y - d.y) < 0.5);
        expect(
          rowItems.map((x) => plain(x.text)),
          `line ${i}`,
        ).toEqual(expect.arrayContaining(['1 pok.', plain(czAmount('37.51'))]));
        expect(Math.round(d.size), `line ${i}`).toBe(10);
      }
    }
  });

  it('an inconsistent snapshot is refused before rendering — never corrected: lines, VAT, total, payment', async () => {
    const vat = (base: string, v: string, total: string) =>
      invoice(
        {
          lines: [
            { description: 'x', quantity: '2', unit: 'ks', unitPrice: '500.00', amount: '1000.00' },
          ],
          totals: { base, vat: v, total, currency: 'CZK' },
        },
        { amount: total },
      );
    // Consistent: 2 × 500.00 = 1000.00 base, + 210.00 VAT (a synthetic value) = 1210.00.
    await expect(renderInvoicePdf(vat('1000.00', '210.00', '1210.00'))).resolves.toBeInstanceOf(
      Buffer,
    );
    for (const [why, snapshot] of [
      ['40 × 37.51 is 1500.40, not 1500.50', oneLine('40', '37.51', '1500.50')],
      ['a product with a fraction of a haléř (no rounding rule)', oneLine('1.5', '0.33', '0.50')],
      ['base is not the lines', vat('999.99', '210.00', '1209.99')],
      ['total is not base + VAT', vat('1000.00', '210.00', '1210.01')],
      ['payment amount is not the total', invoice({}, { amount: '1875.51' })],
      ['payment due date differs', invoice({}, { dueOn: '2026-11-15' })],
      ['payment currency differs', invoice({}, { currency: 'EUR' })],
      ['more than 2 decimals', oneLine('1', '1.005', '1.005')],
    ] as const)
      await expect(renderInvoicePdf(snapshot), why).rejects.toThrow(InconsistentInvoiceSnapshot);
  });

  it('Czech text prints exactly (embedded Noto Sans); a TEST invoice says so; a LIVE one does not', async () => {
    const test = await pageText(await openPdf(await renderInvoicePdf(invoice())), 1);
    for (const text of [
      'ODBĚRATEL',
      'Hotelová společnost Říčany a.s.',
      'Žluťoučká 1',
      'Datum splatnosti',
      'Testovací hotel Šumava',
    ])
      expect(test).toContain(text);
    expect(test).toContain('TESTOVACÍ DOKLAD');
    expect(test).toContain('NEPLATNÝ');
    const live = await pageText(
      await openPdf(await renderInvoicePdf(invoice({ environment: 'LIVE' }))),
      1,
    );
    expect(live).not.toContain('TESTOVACÍ');
  });

  it('the same snapshot renders the same bytes; another value renders other bytes', async () => {
    const a = await renderInvoicePdf(invoice());
    const b = await renderInvoicePdf(invoice());
    const sha = (x: Buffer) => createHash('sha256').update(x).digest('hex');
    expect(sha(a)).toBe(sha(b));
    const c = await renderInvoicePdf(invoice({}, { variableSymbol: '0012346' }));
    expect(sha(c)).not.toBe(sha(a));
  });

  it('no QR Platba for another currency (no contract); the payment details are still printed', async () => {
    const eur = invoice(
      {
        lines: [
          { description: 'x', quantity: '1', unit: 'ks', unitPrice: '61.00', amount: '61.00' },
        ],
        totals: { base: null, vat: null, total: '61.00', currency: 'EUR' },
      },
      {
        currency: 'EUR',
        amount: '61.00',
        account: null,
        iban: 'DE89370400440532013000',
        bic: null,
      },
    );
    const pdf = await openPdf(await renderInvoicePdf(eur));
    expect(await decodeQrOnPage(pdf, 1)).toBeNull();
    expect(await pageText(pdf, 1)).toContain('IBAN: DE89370400440532013000');
  });

  it('the embedded fonts are exactly the recorded Noto Sans 2.015 files (OFL)', () => {
    const dir = resolve(import.meta.dirname, '../src/finance/fonts');
    const source = readFileSync(`${dir}/SOURCE.md`, 'utf8');
    for (const f of ['NotoSans-Regular.ttf', 'NotoSans-Bold.ttf', 'OFL.txt']) {
      const sha = createHash('sha256')
        .update(readFileSync(`${dir}/${f}`))
        .digest('hex');
      expect(source, f).toContain(`\`${f}\` \`${sha}\``);
    }
    expect(readFileSync(`${dir}/OFL.txt`, 'utf8')).toContain('SIL Open Font License, Version 1.1');
  });
});
