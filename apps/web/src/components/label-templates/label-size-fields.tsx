'use client';

import { LABEL_SIZE_MAX_MM, LABEL_SIZE_MIN_MM, type LabelArtwork } from '@ayvo/types';
import { useState } from 'react';
import { NumberField } from '@/components/number-field';
import { ErrorNote } from '@/components/ui';
import { roundMm, type LabelSize } from '@/lib/label-geometry';

/** Clamp to the contract's physical limits (LABEL_SIZE_MIN_MM … LABEL_SIZE_MAX_MM). */
export function clampLabelSize(value: number): number {
  return roundMm(Math.min(Math.max(value, LABEL_SIZE_MIN_MM), LABEL_SIZE_MAX_MM));
}

/** Physical label size with an optional proportion lock to the artwork. */
export function LabelSizeFields({
  artwork,
  size,
  aspectRatioTolerance,
  onChange,
}: {
  artwork: LabelArtwork;
  size: LabelSize;
  aspectRatioTolerance: number;
  onChange: (size: LabelSize) => void;
}) {
  const [lockProportions, setLockProportions] = useState(true);
  const ratio = artwork.intrinsicWidth / artwork.intrinsicHeight;
  const mismatch = Math.abs(ratio / (size.widthMm / size.heightMm) - 1) > aspectRatioTolerance;

  const onWidth = (w: number) => {
    const widthMm = clampLabelSize(w);
    onChange({
      widthMm,
      heightMm: lockProportions ? clampLabelSize(widthMm / ratio) : size.heightMm,
    });
  };
  const onHeight = (h: number) => {
    const heightMm = clampLabelSize(h);
    onChange({
      heightMm,
      widthMm: lockProportions ? clampLabelSize(heightMm * ratio) : size.widthMm,
    });
  };

  return (
    <>
      <div className="flex flex-wrap items-end gap-4">
        <div className="w-36">
          <NumberField label="Width" value={size.widthMm} onCommit={onWidth} testId="label-width" />
        </div>
        <div className="w-36">
          <NumberField
            label="Height"
            value={size.heightMm}
            onCommit={onHeight}
            testId="label-height"
          />
        </div>
        <label className="mb-2 flex items-center gap-2 text-sm text-stone-600">
          <input
            type="checkbox"
            checked={lockProportions}
            onChange={(e) => setLockProportions(e.target.checked)}
          />
          Keep artwork proportions
        </label>
      </div>
      <p className="mt-3 text-xs text-stone-500">
        {artwork.suggestedSizeMm
          ? 'Size taken from the SVG file. '
          : artwork.format === 'SVG'
            ? 'Check the printed label size. '
            : 'Raster files do not state a reliable physical size: enter the printed label size. '}
        The artwork fills the whole label (no bleed in v0.1).
      </p>
      {mismatch && (
        <div className="mt-3">
          <ErrorNote>
            The label size does not match the artwork proportions (more than{' '}
            {aspectRatioTolerance * 100}% difference) — the artwork would be distorted. The server
            rejects such a layout.
          </ErrorNote>
        </div>
      )}
    </>
  );
}

/** Whether the label proportions match the artwork within the tolerance (save gate). */
export function proportionsMatch(
  artwork: LabelArtwork,
  size: LabelSize,
  tolerance: number,
): boolean {
  const ratio = artwork.intrinsicWidth / artwork.intrinsicHeight;
  return Math.abs(ratio / (size.widthMm / size.heightMm) - 1) <= tolerance;
}
