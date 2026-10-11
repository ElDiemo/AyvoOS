/**
 * Geometry of the label designer. The AUTHORITATIVE layout is in millimetres (top-left origin,
 * y downwards, like the stored template and the PDF renderer); pixels exist only on screen:
 * px = mm × scale, where scale is screen pixels per millimetre.
 */

export interface LabelSize {
  widthMm: number;
  heightMm: number;
}

/** A square QR box (quiet zone included). */
export interface QrBox {
  xMm: number;
  yMm: number;
  sizeMm: number;
}

export type Corner = 'nw' | 'ne' | 'sw' | 'se';

/** Values are stored with 0.01 mm precision. */
export function roundMm(value: number, step = 0.01): number {
  const rounded = Math.round(value / step) * step;
  return Math.round(rounded * 100) / 100;
}

export const mmToPx = (mm: number, scale: number) => mm * scale;
export const pxToMm = (px: number, scale: number) => px / scale;

/** Largest scale at which the label fits into maxWidthPx × maxHeightPx. */
export function fitScale(label: LabelSize, maxWidthPx: number, maxHeightPx: number): number {
  return Math.max(0.1, Math.min(maxWidthPx / label.widthMm, maxHeightPx / label.heightMm));
}

/** Keeps the box on the label and within [minSizeMm, shorter label side]. */
export function clampBox(box: QrBox, label: LabelSize, minSizeMm: number): QrBox {
  const maxSize = Math.min(label.widthMm, label.heightMm);
  const sizeMm = roundMm(Math.min(Math.max(box.sizeMm, Math.min(minSizeMm, maxSize)), maxSize));
  return {
    sizeMm,
    xMm: roundMm(Math.min(Math.max(box.xMm, 0), label.widthMm - sizeMm)),
    yMm: roundMm(Math.min(Math.max(box.yMm, 0), label.heightMm - sizeMm)),
  };
}

export function moveBox(
  start: QrBox,
  dxMm: number,
  dyMm: number,
  label: LabelSize,
  minSizeMm: number,
  step = 0.1,
): QrBox {
  return clampBox(
    { ...start, xMm: roundMm(start.xMm + dxMm, step), yMm: roundMm(start.yMm + dyMm, step) },
    label,
    minSizeMm,
  );
}

/**
 * Resizes by dragging `corner`; the opposite corner stays fixed and the box stays square.
 * The size follows the larger of the two pointer movements along the diagonal.
 */
export function resizeBox(
  start: QrBox,
  corner: Corner,
  dxMm: number,
  dyMm: number,
  label: LabelSize,
  minSizeMm: number,
  step = 0.1,
): QrBox {
  const growX = corner === 'ne' || corner === 'se' ? dxMm : -dxMm;
  const growY = corner === 'sw' || corner === 'se' ? dyMm : -dyMm;
  const anchorX = corner === 'nw' || corner === 'sw' ? start.xMm + start.sizeMm : start.xMm;
  const anchorY = corner === 'nw' || corner === 'ne' ? start.yMm + start.sizeMm : start.yMm;

  // Largest size that keeps the box on the label from the fixed anchor.
  const roomX = corner === 'nw' || corner === 'sw' ? anchorX : label.widthMm - anchorX;
  const roomY = corner === 'nw' || corner === 'ne' ? anchorY : label.heightMm - anchorY;
  const maxSize = Math.min(roomX, roomY);

  const wanted = start.sizeMm + (Math.abs(growX) > Math.abs(growY) ? growX : growY);
  const sizeMm = roundMm(Math.min(Math.max(wanted, Math.min(minSizeMm, maxSize)), maxSize), step);
  return clampBox(
    {
      sizeMm,
      xMm: corner === 'nw' || corner === 'sw' ? anchorX - sizeMm : anchorX,
      yMm: corner === 'nw' || corner === 'ne' ? anchorY - sizeMm : anchorY,
    },
    label,
    minSizeMm,
  );
}

/** Default QR placement for new artwork: bottom-right corner with a 5 mm margin. */
export function defaultBox(label: LabelSize, minSizeMm: number): QrBox {
  const sizeMm = Math.max(minSizeMm, Math.min(15, Math.min(label.widthMm, label.heightMm) / 3));
  return clampBox(
    { sizeMm, xMm: label.widthMm - sizeMm - 5, yMm: label.heightMm - sizeMm - 5 },
    label,
    minSizeMm,
  );
}
