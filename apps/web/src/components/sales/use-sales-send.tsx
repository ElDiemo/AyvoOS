'use client';

import { prospectDetailSchema } from '@ayvo/types';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { useAttempt } from '@/components/catalog/form-kit';
import { salesCs } from '@/i18n/cs/sales';
import { apiSend } from '@/lib/client-api';
import { isStale, salesErrorText } from './sales-format';

/**
 * The error of a dialog (null without one, so the dialog shows no empty alert), with a reload link
 * when someone changed the record meanwhile. With `onReload` the reload refreshes the page data in
 * place, so the dialog keeps what was typed.
 */
export function dialogError(
  error: unknown,
  { text, onReload }: { text?: string; onReload?: () => void } = {},
): React.ReactNode {
  if (!error) return null;
  return (
    <>
      <p>{(isStale(error) && text) || salesErrorText(error)}</p>
      {isStale(error) && (
        <button
          type="button"
          className="mt-1 underline"
          onClick={onReload ?? (() => window.location.reload())}
          data-testid="dialog-reload"
        >
          {salesCs.form.reload}
        </button>
      )}
    </>
  );
}

/**
 * Sends one write of Obchod: one request id per attempt (a double click or a retry after a lost
 * answer continues the same operation), the page refreshed on success, the error kept for the
 * dialog (whose fields stay filled).
 */
export function useSalesSend() {
  const router = useRouter();
  const { busy, run } = useAttempt();
  const [error, setError] = useState<unknown>(null);
  async function send(path: string, body: object, onDone: () => void) {
    setError(null);
    const result = await run(path + JSON.stringify(body), (requestId) =>
      apiSend('POST', path, prospectDetailSchema, { requestId, ...body }),
    );
    if (result.ok) {
      onDone();
      router.refresh();
    } else if (result.error) setError(result.error);
  }
  return { busy, error, setError, send };
}
