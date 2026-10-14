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
 *
 * Without `onDiscard` there is nothing that may be discarded (e.g. labelling scans whose result is
 * not known yet): the dialog only leads back to resolve them and the in-app navigation never
 * happens — the page stays mounted and a site switch is not even sent to the server.
 */
export function UnsavedChangesGuard({
  dirty,
  onDiscard,
  onStay,
  texts = t,
}: {
  dirty: boolean;
  onDiscard?: () => void;
  /** After "stay": e.g. return the focus to a scan field (the dialog gives it back to the link). */
  onStay?: () => void;
  texts?: { title: string; text: string; stay: string; discard?: string };
}) {
  const router = useRouter();
  const dialog = useRef<HTMLDialogElement>(null);
  const answer = useRef<((leave: boolean) => void) | null>(null);
  const [open, setOpen] = useState(false);
  const discard = useRef(onDiscard);
  const stay = useRef(onStay);
  useEffect(() => {
    discard.current = onDiscard;
    stay.current = onStay;
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
    if (leave) discard.current?.();
    setOpen(false);
    answer.current?.(leave);
    answer.current = null;
    // After the dialog has closed (and restored the focus to the link or select).
    if (!leave) setTimeout(() => stay.current?.(), 0);
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
        {texts.title}
      </h2>
      <p id="unsaved-text" className="mt-2 text-sm text-stone-600">
        {texts.text}
      </p>
      <div className="mt-4 flex flex-wrap justify-end gap-2">
        <button
          type="button"
          autoFocus
          className={buttonClass.primary}
          onClick={() => close(false)}
        >
          {texts.stay}
        </button>
        {onDiscard && (
          <button type="button" className={buttonClass.danger} onClick={() => close(true)}>
            {texts.discard ?? t.discard}
          </button>
        )}
      </div>
    </dialog>
  );
}
