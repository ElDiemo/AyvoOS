'use client';

import { useRouter } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';
import { buttonClass } from '@/components/ui';
import { shellCs } from '@/i18n/cs/shell';
import { guardedLinkTarget, registerLeaveGuard } from '@/lib/leave-guard';

const t = shellCs.unsaved;

/**
 * Protects a form with unsaved changes (issue #11, UI-01). While `dirty`: an in-app link or a site
 * switch asks "continue editing / discard changes" in a modal dialog; reload, closing the tab and
 * external navigation get the browser's standard `beforeunload` prompt (its text is the
 * browser's). Nothing is asked for a clean form. "Discard" calls `onDiscard` and then leaves.
 */
export function UnsavedChangesGuard({
  dirty,
  onDiscard,
}: {
  dirty: boolean;
  onDiscard: () => void;
}) {
  const router = useRouter();
  const dialog = useRef<HTMLDialogElement>(null);
  const answer = useRef<((leave: boolean) => void) | null>(null);
  const [open, setOpen] = useState(false);
  const discard = useRef(onDiscard);
  useEffect(() => {
    discard.current = onDiscard;
  });

  useEffect(() => {
    if (!dirty) return;
    const ask = () =>
      new Promise<boolean>((resolve) => {
        answer.current = resolve;
        setOpen(true);
      });
    const unregister = registerLeaveGuard(ask);
    const beforeUnload = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      // Legacy browsers need a value; the text shown is always the browser's own.
      e.returnValue = '';
    };
    const onClick = (e: MouseEvent) => {
      const a = e.target instanceof Element ? e.target.closest('a[href]') : null;
      const target = guardedLinkTarget(
        e,
        a instanceof HTMLAnchorElement
          ? { href: a.href, target: a.target, download: a.hasAttribute('download') }
          : null,
        window.location,
      );
      if (!target) return;
      // Capture phase on the document: before Next's <Link> handler and the browser's default.
      e.preventDefault();
      e.stopPropagation();
      void ask().then((leave) => {
        if (leave) router.push(target);
      });
    };
    window.addEventListener('beforeunload', beforeUnload);
    document.addEventListener('click', onClick, true);
    return () => {
      unregister();
      window.removeEventListener('beforeunload', beforeUnload);
      document.removeEventListener('click', onClick, true);
    };
  }, [dirty, router]);

  useEffect(() => {
    const d = dialog.current;
    if (!d) return;
    if (open && !d.open) d.showModal();
    if (!open && d.open) d.close();
  }, [open]);

  const close = (leave: boolean) => {
    if (leave) discard.current();
    setOpen(false);
    answer.current?.(leave);
    answer.current = null;
  };

  return (
    <dialog
      ref={dialog}
      aria-labelledby="unsaved-title"
      aria-describedby="unsaved-text"
      data-testid="unsaved-dialog"
      className="m-auto max-w-sm rounded-lg p-5 shadow-xl backdrop:bg-stone-900/40"
      onCancel={(e) => {
        // Escape keeps editing.
        e.preventDefault();
        close(false);
      }}
    >
      <h2 id="unsaved-title" className="text-base font-semibold">
        {t.title}
      </h2>
      <p id="unsaved-text" className="mt-2 text-sm text-stone-600">
        {t.text}
      </p>
      <div className="mt-4 flex flex-wrap justify-end gap-2">
        <button
          type="button"
          autoFocus
          className={buttonClass.primary}
          onClick={() => close(false)}
        >
          {t.stay}
        </button>
        <button type="button" className={buttonClass.danger} onClick={() => close(true)}>
          {t.discard}
        </button>
      </div>
    </dialog>
  );
}
