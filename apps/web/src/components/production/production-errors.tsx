'use client';

import { DetailFact, Details, ErrorNote } from '@/components/ui';
import { productionCs, qrLabelErrorsCs } from '@/i18n/cs/production';
import { ClientApiError } from '@/lib/client-api';

const c = productionCs.common;

/** A failed request said in Czech; the server's own (English) text only for Podrobnosti. */
export interface ProductionError {
  text: string;
  detail: string | null;
}

/** Never the raw server message on the first layer (docs/002 principle 14). */
export function productionError(e: unknown): ProductionError {
  if (!(e instanceof ClientApiError) || e.status >= 500)
    return { text: c.networkError, detail: null };
  if (e.code && qrLabelErrorsCs[e.code])
    return { text: c.failed(qrLabelErrorsCs[e.code]!), detail: null };
  if (e.status === 403) return { text: c.forbidden, detail: null };
  if (e.status === 404) return { text: c.notFound, detail: null };
  const detail = e.message || null;
  if (e.status === 409) return { text: c.conflict, detail };
  if (e.status === 400 || e.status === 413 || e.status === 415 || e.status === 422)
    return { text: c.invalidData, detail };
  return { text: c.unexpectedError, detail };
}

export function ProductionErrorNote({
  error,
  testId,
}: {
  error: ProductionError;
  testId?: string;
}) {
  return (
    <>
      <ErrorNote>{error.text}</ErrorNote>
      {error.detail && (
        <Details testId={testId}>
          <dl>
            <DetailFact label={c.serverAnswer} value={error.detail} />
          </dl>
        </Details>
      )}
    </>
  );
}
