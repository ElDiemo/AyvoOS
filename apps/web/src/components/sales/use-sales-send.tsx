'use client';

import { prospectDetailSchema } from '@ayvo/types';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { useAttempt } from '@/components/catalog/form-kit';
import { salesCs } from '@/i18n/cs/sales';
import { apiSend } from '@/lib/client-api';
import { isStale, salesErrorText } from './sales-format';

/** The error of a dialog, with a reload link when someone changed the record meanwhile. */
export function DialogError({ error }: { error: unknown }) {
  if (!error) return null;
  return (
    <>
      <p>{salesErrorText(error)}</p>
      {isStale(error) && (
        <button type="button" className="mt-1 underline" onClick={() => window.location.reload()}>
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
