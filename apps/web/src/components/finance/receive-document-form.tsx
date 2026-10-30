'use client';

import { financeDocumentDetailSchema, type FinanceSupplier } from '@ayvo/types';
import { useRouter } from 'next/navigation';
import { useRef, useState } from 'react';
import { buttonClass, ErrorNote } from '@/components/ui';
import { UnsavedChangesGuard } from '@/components/unsaved-changes-guard';
import { financeCs as t } from '@/i18n/cs/finance';
import { apiSend } from '@/lib/client-api';
import {
  DocumentFields,
  emptyFields,
  toPayload,
  type DocumentFieldValues,
} from './document-fields';

/** Receiving a document: the original + its metadata, one request id per attempt. */
export function ReceiveDocumentForm({
  suppliers,
  canOpenSuppliers,
}: {
  suppliers: readonly FinanceSupplier[];
  canOpenSuppliers: boolean;
}) {
  const router = useRouter();
  const [values, setValues] = useState<DocumentFieldValues>(emptyFields);
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // The same id for a retry of the same attempt (idempotent upload); a new one after success.
  const requestId = useRef(crypto.randomUUID());
  const dirty = !!file || JSON.stringify(values) !== JSON.stringify(emptyFields);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!file) return;
    setBusy(true);
    setError(null);
    const form = new FormData();
    form.set('requestId', requestId.current);
    for (const [key, value] of Object.entries(toPayload(values)))
      if (value !== null) form.set(key, value);
    form.set('file', file);
    try {
      const doc = await apiSend(
        'POST',
        'admin/finance/documents',
        financeDocumentDetailSchema,
        form,
      );
      requestId.current = crypto.randomUUID();
      setValues(emptyFields);
      setFile(null);
      router.push(`/finance/documents/${doc.code}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} className="flex flex-col gap-4" data-testid="receive-document">
      <label className="flex min-w-0 flex-col gap-1 text-sm font-medium">
        {t.receive.file}
        <input
          required
          type="file"
          accept="application/pdf"
          className="block w-full min-w-0 text-sm"
          onChange={(e) => {
            setFile(e.target.files?.[0] ?? null);
            requestId.current = crypto.randomUUID();
          }}
        />
      </label>
      <DocumentFields
        values={values}
        onChange={(next) => {
          setValues(next);
          requestId.current = crypto.randomUUID();
        }}
        suppliers={suppliers}
      />
      <p className="text-xs text-stone-500">{t.receive.draftHelp}</p>
      {/* A new tab: the unfinished document, its file included, stays here (doc 044 U7). */}
      <p className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-stone-500">
        <span>{t.receive.noSupplier}</span>
        {canOpenSuppliers ? (
          <>
            <a
              href="/warehouse/suppliers"
              target="_blank"
              rel="noopener"
              className="underline"
              data-testid="receive-open-suppliers"
            >
              {t.receive.openSuppliers}
            </a>
            <button
              type="button"
              className="underline"
              onClick={() => router.refresh()}
              data-testid="receive-refresh-suppliers"
            >
              {t.receive.refreshSuppliers}
            </button>
          </>
        ) : (
          <span>{t.receive.askForSupplier}</span>
        )}
      </p>
      {error && <ErrorNote>{error}</ErrorNote>}
      <div>
        <button type="submit" disabled={busy || !file} className={buttonClass.primary}>
          {busy ? t.receive.busy : t.receive.submit}
        </button>
      </div>
      <UnsavedChangesGuard dirty={dirty && !busy} />
    </form>
  );
}
