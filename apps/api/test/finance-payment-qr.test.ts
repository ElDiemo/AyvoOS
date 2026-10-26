import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { czAmount, renderInvoicePdf, type InvoicePdfSnapshot } from '../src/finance/invoice-pdf.js';
import { spayd, InvalidPaymentInstruction, type PaymentInstruction } from '../src/finance/spayd.js';
import { decodeQrOnPage, openPdf, pageText } from './support/pdf-inspect.js';

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
  hotel: { code: 'HT-000001', name: 'Testovací hotel Šumava' },
  lines: [
    {
      description: 'Služba AYVO — pokoje × měsíc 10/2026',
      quantity: '40',
      unit: 'pokojů',
      unitPrice: '37.51',
      amount: '1500.50',
    },
  ],
  totals: { base: null, vat: null, total: '1500.50', currency: 'CZK' },
  vatNote: null,
  payment: {
    account: '19-2000145399/0800',
    iban: 'CZ6508000000192000145399',
    bic: 'GIBACZPX',
    amount: '1500.50',
    currency: 'CZK',
    variableSymbol: '0012345',
    dueOn: '2026-11-14',
    message: 'FAKTURA 2026001',
    ...pay,
  },
  ...over,
});
const plain = (text: string) => text.replace(/\u00a0/g, ' ');

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

  it('read back from the rendered invoice like a phone: the QR equals the printed account, amount with haléře and VS', async () => {
    for (const pay of [
      {},
      { amount: '0.01', variableSymbol: '0000000001' },
      { amount: '9999999.99', bic: null, message: null, variableSymbol: '9' },
    ]) {
      const snapshot = invoice({}, pay);
      const pdf = await openPdf(await renderInvoicePdf(snapshot));
      const qr = await decodeQrOnPage(pdf, 1);
      expect(qr, JSON.stringify(pay)).not.toBeNull();
      const fields = parse(qr!.data);
      const printed = plain(await pageText(pdf, 1));
      const [iban] = fields.ACC!.split('+');
      expect(iban).toBe(snapshot.payment.iban);
      expect(printed).toContain(`IBAN: ${iban}`);
      expect(fields.CC).toBe('CZK');
      expect(fields.AM).toBe(snapshot.payment.amount);
      expect(printed).toContain(`Částka: ${plain(czAmount(fields.AM!))} CZK`);
      expect(fields['X-VS']).toBe(snapshot.payment.variableSymbol);
      expect(printed).toContain(`Variabilní symbol: ${fields['X-VS']}`);
      expect(fields.DT).toBe('20261114');
    }
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
      { totals: { base: null, vat: null, total: '61.00', currency: 'EUR' } },
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
