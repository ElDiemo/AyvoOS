'use client';

import {
  financeDocumentDetailSchema,
  type FinanceDocumentDetail,
  type FinanceSupplier,
} from '@ayvo/types';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { buttonClass, ErrorNote, inputClass } from '@/components/ui';
import { UnsavedChangesGuard } from '@/components/unsaved-changes-guard';
import { financeCs as t } from '@/i18n/cs/finance';
import { apiSend, ClientApiError } from '@/lib/client-api';
import { DocumentFields, toPayload, type DocumentFieldValues } from './document-fields';

const valuesOf = (d: FinanceDocumentDetail): DocumentFieldValues => ({
  supplierId: d.supplier.id,
  kind: d.kind,
  documentNumber: d.documentNumber,
  issuedOn: d.issuedOn,
  taxPointOn: d.taxPointOn ?? '',
  dueOn: d.dueOn ?? '',
  totalAmount: d.totalAmount ?? '',
  currency: d.currency ?? 'CZK',
  description: d.description ?? '',
});

/** Correct the metadata or void the document — each with a reason and the version it saw. */
export function DocumentActions({
  doc,
  suppliers,
}: {
  doc: FinanceDocumentDetail;
  suppliers: readonly FinanceSupplier[];
}) {
  const router = useRouter();
  const [mode, setMode] = useState<'none' | 'correct' | 'void'>('none');
  const [values, setValues] = useState(valuesOf(doc));
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const dirty =
    mode !== 'none' && (reason !== '' || JSON.stringify(values) !== JSON.stringify(valuesOf(doc)));
  // A supplier archived since stays selectable for this document.
  const options = suppliers.some((s) => s.id === doc.supplier.id)
    ? suppliers
    : [doc.supplier, ...suppliers];

  async function send(path: 'correct' | 'void', body: object) {
    setBusy(true);
    setError(null);
    try {
      await apiSend(
        'POST',
        `admin/finance/documents/${doc.code}/${path}`,
        financeDocumentDetailSchema,
        {
          ...body,
          expectedVersion: doc.version,
          reason,
        },
      );
      setMode('none');
      setReason('');
      router.refresh();
    } catch (err) {
      if (err instanceof ClientApiError && err.code === 'STALE_VERSION') {
        setError(t.errors.stale);
        router.refresh();
      } else setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  if (mode === 'none')
    return (
      <div className="flex flex-wrap gap-2">
        <button type="button" className={buttonClass.secondary} onClick={() => setMode('correct')}>
          {t.detail.correct}
        </button>
        <button type="button" className={buttonClass.danger} onClick={() => setMode('void')}>
          {t.detail.void}
        </button>
      </div>
    );

  const reasonField = (
    <label className="flex flex-col gap-1 text-sm font-medium">
      {t.detail.reason}
      <input
        required
        minLength={3}
        maxLength={500}
        className={inputClass}
        value={reason}
        onChange={(e) => setReason(e.target.value)}
      />
    </label>
  );
  return (
    <form
      className="flex flex-col gap-4"
      data-testid={`finance-${mode}`}
      onSubmit={(e) => {
        e.preventDefault();
        void (mode === 'correct' ? send('correct', toPayload(values)) : send('void', {}));
      }}
    >
      {mode === 'correct' && (
        <DocumentFields values={values} onChange={setValues} suppliers={options} />
      )}
      {reasonField}
      {error && <ErrorNote>{error}</ErrorNote>}
      <div className="flex flex-wrap gap-2">
        <button
          type="submit"
          disabled={busy}
          className={mode === 'void' ? buttonClass.danger : buttonClass.primary}
        >
          {mode === 'void' ? t.detail.voidSubmit : t.detail.correctSubmit}
        </button>
        <button
          type="button"
          className={buttonClass.secondary}
          onClick={() => {
            setMode('none');
            setValues(valuesOf(doc));
            setReason('');
            setError(null);
          }}
        >
          {t.detail.cancel}
        </button>
      </div>
      <UnsavedChangesGuard dirty={dirty && !busy} />
    </form>
  );
}
