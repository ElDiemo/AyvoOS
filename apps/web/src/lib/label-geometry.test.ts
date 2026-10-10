import { describe, expect, it } from 'vitest';
import {
  clampBox,
  defaultBox,
  fitScale,
  mmToPx,
  moveBox,
  pxToMm,
  resizeBox,
  roundMm,
} from './label-geometry';

const label = { widthMm: 70, heightMm: 110 };
const MIN = 10;

describe('label geometry (designer ↔ physical millimetres)', () => {
  it('round-trips millimetres through screen pixels at any scale', () => {
    for (const scale of [2.5, 4, 5.123, 8]) {
      for (const mm of [0, 15, 48.2, 78.5, 110])
        expect(roundMm(pxToMm(mmToPx(mm, scale), scale))).toBe(mm);
    }
  });

  it('fits the label into the available space keeping proportions', () => {
    expect(fitScale(label, 700, 2000)).toBe(10);
    expect(fitScale(label, 700, 550)).toBe(5);
  });

  it('moves by pointer deltas converted to mm, and never off the label', () => {
    const start = { xMm: 48.2, yMm: 78.5, sizeMm: 15 };
    expect(moveBox(start, pxToMm(-50, 5), pxToMm(25, 5), label, MIN)).toEqual({
      xMm: 38.2,
      yMm: 83.5,
      sizeMm: 15,
    });
    expect(moveBox(start, 100, 100, label, MIN)).toEqual({ xMm: 55, yMm: 95, sizeMm: 15 });
    expect(moveBox(start, -100, -100, label, MIN)).toEqual({ xMm: 0, yMm: 0, sizeMm: 15 });
  });

  it('resizes from any corner, keeps the opposite corner fixed and stays square', () => {
    const start = { xMm: 20, yMm: 30, sizeMm: 15 };
    expect(resizeBox(start, 'se', 5, 2, label, MIN)).toEqual({ xMm: 20, yMm: 30, sizeMm: 20 });
    expect(resizeBox(start, 'nw', -5, -1, label, MIN)).toEqual({ xMm: 15, yMm: 25, sizeMm: 20 });
    expect(resizeBox(start, 'ne', 1, -4, label, MIN)).toEqual({ xMm: 20, yMm: 26, sizeMm: 19 });
    expect(resizeBox(start, 'sw', -3, 0, label, MIN)).toEqual({ xMm: 17, yMm: 30, sizeMm: 18 });
  });

  it('never resizes below the minimum or beyond the label', () => {
    const start = { xMm: 20, yMm: 30, sizeMm: 15 };
    expect(resizeBox(start, 'se', -50, -50, label, MIN).sizeMm).toBe(MIN);
    const big = resizeBox(start, 'se', 500, 500, label, MIN);
    expect(big).toEqual({ xMm: 20, yMm: 30, sizeMm: 50 });
  });

  it('clamps typed values onto the label', () => {
    expect(clampBox({ xMm: 65, yMm: -3, sizeMm: 8 }, label, MIN)).toEqual({
      xMm: 60,
      yMm: 0,
      sizeMm: 10,
    });
    expect(clampBox({ xMm: 0, yMm: 0, sizeMm: 200 }, label, MIN)).toEqual({
      xMm: 0,
      yMm: 0,
      sizeMm: 70,
    });
  });

  it('places a default QR bottom-right', () => {
    expect(defaultBox(label, MIN)).toEqual({ xMm: 50, yMm: 90, sizeMm: 15 });
  });
});
