'use client';

import { useRef, useState } from 'react';
import { buttonClass } from '@/components/ui';
import { returnsCs } from '@/i18n/cs/returns';

const t = returnsCs;

/**
 * A scan field whose code is taken out the moment it is sent: a keyboard scanner types the next
 * code into whatever the field holds, so the field must be empty before the answer arrives (two
 * codes are never glued together). A code that was not saved (a refusal or an uncertain answer)
 * comes back into the field when it is still empty; when the next code is already there, it is
 * kept and the failed one is offered for repeating as the same operation (`FailedScan`).
 */
export function useScanField<T extends { scanned: string }>() {
  const [value, setState] = useState('');
  const current = useRef('');
  const [failed, setFailed] = useState<T | null>(null);
  const setValue = (next: string) => {
    current.current = next;
    setState(next);
  };
  const settle = (attempt: T, done: boolean) => {
    if (done) return;
    if (current.current.trim() === '') setValue(attempt.scanned);
    else setFailed(attempt);
  };
  /** Sends the field's code: the field is emptied first. */
  async function submit(attempt: T, send: (attempt: T) => Promise<boolean>) {
    setValue('');
    setFailed(null);
    settle(attempt, await send(attempt));
  }
  /** Repeats the failed operation (the same payload), leaving the field as it is. */
  async function retry(send: (attempt: T) => Promise<boolean>) {
    if (!failed) return;
    const attempt = failed;
    setFailed(null);
    if (!(await send(attempt))) setFailed(attempt);
  }
  return { value, setValue, failed, submit, retry, dismiss: () => setFailed(null) };
}

/** The failed code kept beside a newer one: repeat it as the same operation, or drop it. */
export function FailedScan({
  scanned,
  busy,
  onRetry,
  onDismiss,
}: {
  scanned: string;
  busy: boolean;
  onRetry: () => void;
  onDismiss: () => void;
}) {
  return (
    <div
      className="flex flex-col gap-2 text-sm text-amber-900 sm:flex-row sm:items-center"
      data-testid="failed-scan"
    >
      <span className="wrap-anywhere">{t.failedScan(scanned)}</span>
      <div className="flex gap-2">
        <button type="button" className={buttonClass.secondary} disabled={busy} onClick={onRetry}>
          {t.retry}
        </button>
        <button type="button" className={buttonClass.secondary} disabled={busy} onClick={onDismiss}>
          {t.dismissFailed}
        </button>
      </div>
    </div>
  );
}
