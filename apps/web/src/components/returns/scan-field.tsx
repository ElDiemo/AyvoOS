'use client';

import { useState } from 'react';
import { buttonClass } from '@/components/ui';
import { returnsCs } from '@/i18n/cs/returns';
import type { RunResult } from './receipt-workspace';

const t = returnsCs;

/**
 * A scan field whose code is taken out the moment it is sent: a keyboard scanner types the next
 * code into whatever the field holds, so the field is empty before the answer arrives and two
 * codes are never glued together. A refused code is closed (the server saved nothing; the
 * message names it). An UNCERTAIN one (the server may have saved it) is kept apart with its
 * original payload — code and choice — and never put back into the field: until it is repeated
 * ("Zkusit znovu", the same request id) or explicitly dropped, the next code stays in the field
 * and is not sent (`held`).
 */
export function useScanField<T extends { scanned: string }>() {
  const [value, setValue] = useState('');
  const [unconfirmed, setUnconfirmed] = useState<T | null>(null);
  const [held, setHeld] = useState(false);
  /** Sends the field's code (the field is emptied first) — held while an earlier one is open. */
  async function submit(attempt: T, send: (attempt: T) => Promise<RunResult>) {
    if (unconfirmed) {
      setHeld(true);
      return;
    }
    setValue('');
    if ((await send(attempt)) === 'uncertain') setUnconfirmed(attempt);
  }
  /** Repeats the unconfirmed operation with its original payload; the field stays as it is. */
  async function retry(send: (attempt: T) => Promise<RunResult>) {
    if (!unconfirmed) return;
    if ((await send(unconfirmed)) !== 'uncertain') {
      setUnconfirmed(null);
      setHeld(false);
    }
  }
  function dismiss() {
    setUnconfirmed(null);
    setHeld(false);
  }
  return { value, setValue, unconfirmed, held, submit, retry, dismiss };
}

/** The unconfirmed scan kept apart: repeat it as the same operation, or drop it knowingly. */
export function UnconfirmedScan({
  label,
  held,
  busy,
  onRetry,
  onDismiss,
}: {
  /** The code and the original choice, as sent. */
  label: string;
  held: boolean;
  busy: boolean;
  onRetry: () => void;
  onDismiss: () => void;
}) {
  return (
    <div
      role="alert"
      className="flex flex-col gap-2 rounded-md border border-amber-300 bg-amber-50 p-3 text-sm text-amber-950"
      data-testid="unconfirmed-scan"
    >
      <p className="font-semibold">{t.unconfirmed.title}</p>
      <p className="wrap-anywhere" data-testid="unconfirmed-scan-code">
        {label}
      </p>
      <p>{t.unconfirmed.text}</p>
      {held && <p data-testid="unconfirmed-scan-held">{t.unconfirmed.held}</p>}
      <div className="flex flex-wrap gap-2">
        <button type="button" className={buttonClass.primary} disabled={busy} onClick={onRetry}>
          {t.retry}
        </button>
        <button type="button" className={buttonClass.secondary} disabled={busy} onClick={onDismiss}>
          {t.unconfirmed.dismiss}
        </button>
      </div>
    </div>
  );
}
