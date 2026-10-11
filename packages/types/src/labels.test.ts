import { describe, expect, it } from 'vitest';
import { labelLayoutSchema, qrGeometry, QR_QUIET_ZONE_MODULES } from './labels.js';

const artworkId = '01960d1e-0000-7000-8000-000000000000';
const qr = {
  type: 'QR_CODE' as const,
  xMm: 48.2,
  yMm: 78.5,
  widthMm: 15,
  heightMm: 15,
  rotationDeg: 0 as const,
};

describe('label layout contract', () => {
  it('accepts a valid layout and rejects geometry that breaks the physical rules', () => {
    expect(
      labelLayoutSchema.safeParse({ artworkId, widthMm: 70, heightMm: 110, elements: [qr] })
        .success,
    ).toBe(true);
    const bad = [
      { ...qr, xMm: 60 }, // off the label
      { ...qr, heightMm: 16 }, // not square
      { ...qr, xMm: 1.234 }, // finer than 0.01 mm
      { ...qr, rotationDeg: 90 }, // rotation not supported in v0.1
    ];
    for (const element of bad) {
      expect(
        labelLayoutSchema.safeParse({ artworkId, widthMm: 70, heightMm: 110, elements: [element] })
          .success,
      ).toBe(false);
    }
  });
});

describe('qrGeometry', () => {
  it('places the symbol inside the quiet zone of the element box', () => {
    const g = qrGeometry(qr, 33);
    expect(g.totalModules).toBe(33 + 2 * QR_QUIET_ZONE_MODULES);
    expect(g.moduleMm).toBeCloseTo(15 / 41, 10);
    expect(g.symbol.xMm).toBeCloseTo(48.2 + 4 * (15 / 41), 10);
    expect(g.symbol.yMm).toBeCloseTo(78.5 + 4 * (15 / 41), 10);
    expect(g.symbol.sizeMm).toBeCloseTo(33 * (15 / 41), 10);
    // Symbol + quiet zone on both sides = the element box.
    expect(g.symbol.sizeMm + 2 * QR_QUIET_ZONE_MODULES * g.moduleMm).toBeCloseTo(qr.widthMm, 10);
  });
});
