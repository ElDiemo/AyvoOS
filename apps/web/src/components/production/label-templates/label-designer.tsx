'use client';

import { useEffect, useRef, useState } from 'react';
import {
  clampBox,
  fitScale,
  mmToPx,
  moveBox,
  pxToMm,
  resizeBox,
  type Corner,
  type LabelSize,
  type QrBox,
} from '@/lib/label-geometry';
import { NumberField } from '@/components/number-field';
import { QrCode } from '@/components/qr-code';
import { productionCs } from '@/i18n/cs/production';

const t = productionCs.editor;

const CORNERS: Corner[] = ['nw', 'ne', 'sw', 'se'];
const HANDLE_POSITION: Record<Corner, string> = {
  nw: '-left-2 -top-2 cursor-nwse-resize',
  ne: '-right-2 -top-2 cursor-nesw-resize',
  sw: '-left-2 -bottom-2 cursor-nesw-resize',
  se: '-right-2 -bottom-2 cursor-nwse-resize',
};
const MAX_STAGE_PX = 640;

interface DragState {
  mode: 'move' | Corner;
  pointerId: number;
  startX: number;
  startY: number;
  startBox: QrBox;
}

/**
 * Visual label designer: the artwork is shown at its physical proportions; the QR box is dragged
 * and resized with the pointer (mouse, pen, touch). All values are converted to millimetres
 * immediately — pixels never leave this component. Numeric fields allow precise fine-tuning.
 */
export function LabelDesigner({
  artworkUrl,
  label,
  box,
  onChange,
  minSizeMm,
  qrPreviewUrl,
  qrLevel,
}: {
  artworkUrl: string;
  label: LabelSize;
  box: QrBox;
  onChange: (box: QrBox) => void;
  minSizeMm: number;
  qrPreviewUrl: string;
  qrLevel: 'L' | 'M' | 'Q' | 'H';
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const drag = useRef<DragState | null>(null);
  const [available, setAvailable] = useState({ width: 480, height: MAX_STAGE_PX });

  // The whole label stays visible while editing: limited by the column width and the window height.
  useEffect(() => {
    const element = containerRef.current;
    if (!element) return;
    const update = () =>
      setAvailable({
        width: element.clientWidth,
        height: Math.max(320, Math.min(MAX_STAGE_PX, window.innerHeight - 160)),
      });
    update();
    const observer = new ResizeObserver(update);
    observer.observe(element);
    window.addEventListener('resize', update);
    return () => {
      observer.disconnect();
      window.removeEventListener('resize', update);
    };
  }, []);

  const scale = fitScale(label, Math.min(available.width, MAX_STAGE_PX), available.height);

  // One handler for the box and its corner handles; `data-drag` says which one was grabbed.
  const startDrag = (event: React.PointerEvent<HTMLElement>) => {
    if (event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    const mode = event.currentTarget.dataset.drag as DragState['mode'];
    stageRef.current?.setPointerCapture(event.pointerId);
    drag.current = {
      mode,
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      startBox: box,
    };
  };

  const onPointerMove = (event: React.PointerEvent) => {
    const state = drag.current;
    if (!state || state.pointerId !== event.pointerId) return;
    const dx = pxToMm(event.clientX - state.startX, scale);
    const dy = pxToMm(event.clientY - state.startY, scale);
    onChange(
      state.mode === 'move'
        ? moveBox(state.startBox, dx, dy, label, minSizeMm)
        : resizeBox(state.startBox, state.mode, dx, dy, label, minSizeMm),
    );
  };

  const endDrag = (event: React.PointerEvent) => {
    if (drag.current?.pointerId === event.pointerId) drag.current = null;
  };

  const onKeyDown = (event: React.KeyboardEvent) => {
    const step = event.shiftKey ? 1 : 0.1;
    const delta: Record<string, [number, number]> = {
      ArrowLeft: [-step, 0],
      ArrowRight: [step, 0],
      ArrowUp: [0, -step],
      ArrowDown: [0, step],
    };
    const d = delta[event.key];
    if (!d) return;
    event.preventDefault();
    onChange(moveBox(box, d[0], d[1], label, minSizeMm));
  };

  const set = (patch: Partial<QrBox>) => onChange(clampBox({ ...box, ...patch }, label, minSizeMm));

  return (
    <div className="grid grid-cols-1 gap-6 lg:grid-cols-[1fr_16rem]">
      <div ref={containerRef} className="flex flex-col items-center gap-3">
        <div
          ref={stageRef}
          data-testid="designer-stage"
          className="relative touch-none select-none bg-white shadow-md ring-1 ring-stone-300"
          style={{ width: mmToPx(label.widthMm, scale), height: mmToPx(label.heightMm, scale) }}
          onPointerMove={onPointerMove}
          onPointerUp={endDrag}
          onPointerCancel={endDrag}
        >
          {/* The artwork fills the label exactly, as in the PDF (proportions validated). */}
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={artworkUrl}
            alt={t.artworkAlt}
            draggable={false}
            className="pointer-events-none absolute inset-0 h-full w-full"
            style={{ objectFit: 'fill' }}
          />
          <div
            data-testid="qr-box"
            role="group"
            aria-label={t.qrBoxLabel(box.xMm, box.yMm, box.sizeMm)}
            tabIndex={0}
            data-drag="move"
            onPointerDown={startDrag}
            onKeyDown={onKeyDown}
            className="absolute cursor-move outline-2 outline-offset-0 outline-sky-600 outline-dashed focus-visible:outline-solid"
            style={{
              left: mmToPx(box.xMm, scale),
              top: mmToPx(box.yMm, scale),
              width: mmToPx(box.sizeMm, scale),
              height: mmToPx(box.sizeMm, scale),
            }}
          >
            <QrCode
              value={qrPreviewUrl}
              level={qrLevel}
              className="pointer-events-none h-full w-full"
              title={t.qrPreview}
            />
            {CORNERS.map((corner) => (
              <span
                key={corner}
                data-testid={`qr-handle-${corner}`}
                data-drag={corner}
                onPointerDown={startDrag}
                className={`absolute h-4 w-4 rounded-sm border-2 border-sky-600 bg-white shadow ${HANDLE_POSITION[corner]}`}
              />
            ))}
          </div>
        </div>
        <p className="text-center text-xs text-stone-500">
          {t.stageHelp(label.widthMm, label.heightMm)}
        </p>
      </div>

      <div className="flex flex-col gap-4">
        <h3 className="text-sm font-medium text-stone-700">{t.qrPosition}</h3>
        <div className="grid grid-cols-2 gap-3">
          <NumberField label="X" value={box.xMm} onCommit={(xMm) => set({ xMm })} testId="qr-x" />
          <NumberField label="Y" value={box.yMm} onCommit={(yMm) => set({ yMm })} testId="qr-y" />
          <NumberField
            label={t.width}
            value={box.sizeMm}
            onCommit={(sizeMm) => set({ sizeMm })}
            testId="qr-width"
          />
          <NumberField
            label={t.height}
            value={box.sizeMm}
            onCommit={(sizeMm) => set({ sizeMm })}
            testId="qr-height"
            hint={t.qrSquare}
          />
        </div>
        <p className="text-xs text-stone-500">{t.minSize(minSizeMm)}</p>
      </div>
    </div>
  );
}
