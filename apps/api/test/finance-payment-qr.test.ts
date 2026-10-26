import { PDFDocument, StandardFonts } from 'pdf-lib';
import { describe, expect, it } from 'vitest';
import { drawPaymentQr } from '../src/finance/payment-qr.js';
import { spayd, InvalidPaymentInstruction, type PaymentInstruction } from '../src/finance/spayd.js';
import { decodeQrOnPage, openPdf, pageText } from './support/pdf-inspect.js';

/**
 * QR Platba (N3A-2b, doc 040 §8): the descriptor built from an invoice's own payment details, drawn
 * into a real PDF, then read back the way a phone does (pdf.js raster + jsQR) and compared with the
 * text printed on the same page — the same account, exact amount with haléře, currency and the
 * variable symbol with its leading zeros. Synthetic accounts only.
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

/** A one-page PDF with the QR and the same facts as visible text (what an invoice will print). */
async function render(p: PaymentInstruction): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const page = doc.addPage([595.28, 841.89]);
  const font = await doc.embedFont(StandardFonts.Helvetica);
  drawPaymentQr(page, spayd(p), { xPt: 400, yTopPt: 780, sizePt: 130 });
  const lines = [
    `IBAN ${p.iban}`,
    `AMOUNT ${p.amount} ${p.currency}`,
    `VS ${p.variableSymbol ?? ''}`,
    `DUE ${p.dueDate ?? ''}`,
  ];
  lines.forEach((l, i) => page.drawText(l, { x: 50, y: 760 - i * 16, size: 11, font }));
  return doc.save();
}

describe('QR Platba (SPAYD) in a rendered PDF', () => {
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

  it('read back from the rendered page like a phone: equals the printed account, amount with haléře and VS', async () => {
    for (const p of [
      base,
      { ...base, amount: '0.01', variableSymbol: '0000000001' },
      { ...base, amount: '9999999.99', bic: null, message: null, variableSymbol: '9' },
    ]) {
      const pdf = await openPdf(await render(p));
      const qr = await decodeQrOnPage(pdf, 1);
      expect(qr, JSON.stringify(p)).not.toBeNull();
      const fields = parse(qr!.data);
      const printed = await pageText(pdf, 1);
      expect(fields.ACC!.split('+')[0]).toBe(p.iban);
      expect(printed).toContain(`IBAN ${fields.ACC!.split('+')[0]}`);
      expect(fields.AM).toBe(Number(p.amount) < 1 ? p.amount : p.amount.replace(/^0+/, ''));
      expect(printed).toContain(`AMOUNT ${fields.AM} CZK`);
      expect(fields.CC).toBe('CZK');
      expect(fields['X-VS']).toBe(p.variableSymbol);
      expect(printed).toContain(`VS ${fields['X-VS']}`);
    }
  });
});
