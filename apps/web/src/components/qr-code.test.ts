import { qrGeometry } from '@ayvo/types';
import QRCode from 'qrcode';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { QrCode } from './qr-code';

/**
 * Browser preview ↔ PDF comparison: both place the symbol with the shared `qrGeometry` contract.
 * The API test suite checks the PDF against the same contract by decoding the rendered QR.
 */
describe('QrCode preview geometry', () => {
  const url = 'http://localhost:3000/q/AAAAAAAAAAAAAAAAAAAAAA';

  it.each(['M', 'Q'] as const)('matches the shared QR geometry (EC %s)', (level) => {
    const html = renderToStaticMarkup(createElement(QrCode, { value: url, level }));
    const modules = QRCode.create(url, { errorCorrectionLevel: level }).modules.size;
    const total = qrGeometry({ xMm: 0, yMm: 0, widthMm: 1 }, modules).totalModules;
    expect(html).toContain(`viewBox="0 0 ${total} ${total}"`);
    expect(html).toContain(`data-qr-value="${url}"`);
    expect(html).toContain(`data-qr-level="${level}"`);

    // The first dark module (top-left finder pattern) sits exactly inside the quiet zone.
    const inset = (total - modules) / 2;
    expect(html).toMatch(new RegExp(`d="M${inset} ${inset}h1v1h-1z`));
    // The box (viewBox) is the quiet zone + symbol, like the PDF element box.
    const g = qrGeometry({ xMm: 0, yMm: 0, widthMm: total }, modules);
    expect(g.symbol).toEqual({ xMm: inset, yMm: inset, sizeMm: modules });
  });
});
