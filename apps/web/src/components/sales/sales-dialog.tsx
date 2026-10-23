'use client';

import { useEffect, useRef } from 'react';
import { buttonClass } from '@/components/ui';
import { catalogCs } from '@/i18n/cs/catalog';

/**
 * A modal form (native <dialog>: focus trap, Escape closes). The fields stay filled after an
 * error — closing is the only thing that discards them.
 */
export function FormDialog({
  open,
  title,
  submitLabel,
  busy,
  error,
  onSubmit,
  onClose,
  children,
  testId,
  wide = false,
}: {
  open: boolean;
  title: string;
  submitLabel: string;
  busy: boolean;
  error: React.ReactNode;
  onSubmit: () => void;
  onClose: () => void;
  children: React.ReactNode;
  testId: string;
  wide?: boolean;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) d.showModal();
    if (!open && d.open) d.close();
  }, [open]);
  return (
    <dialog
      ref={ref}
      aria-labelledby={`${testId}-title`}
      data-testid={testId}
      className={`m-auto max-h-[calc(100dvh-2rem)] rounded-lg p-0 shadow-xl backdrop:bg-stone-900/40 ${
        wide ? 'w-[min(40rem,calc(100vw-2rem))]' : 'w-[min(32rem,calc(100vw-2rem))]'
      }`}
      onCancel={(e) => {
        e.preventDefault();
        if (!busy) onClose();
      }}
    >
      <form
        noValidate
        className="flex flex-col gap-4 p-5"
        onSubmit={(e) => {
          e.preventDefault();
          onSubmit();
        }}
      >
        <h2 id={`${testId}-title`} className="text-base font-semibold">
          {title}
        </h2>
        {open && <div className="flex flex-col gap-4 text-sm">{children}</div>}
        {error && (
          <div
            role="alert"
            className="rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-900"
            data-testid={`${testId}-error`}
          >
            {error}
          </div>
        )}
        <div className="flex flex-wrap justify-end gap-2">
          <button type="button" className={buttonClass.secondary} onClick={onClose} disabled={busy}>
            {catalogCs.common.cancel}
          </button>
          <button
            type="submit"
            className={buttonClass.primary}
            disabled={busy}
            data-testid={`${testId}-submit`}
          >
            {busy ? catalogCs.common.saving : submitLabel}
          </button>
        </div>
      </form>
    </dialog>
  );
}
