'use client';

import { goodsReceiptSchema } from '@ayvo/types';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { buttonClass, ErrorNote, inputClass } from '@/components/ui';
import { warehouseCs } from '@/i18n/cs/warehouse';
import { apiSend } from '@/lib/client-api';
import { apiErrorText, SupplierDocumentUpload } from './supplier-document-upload';

const r = warehouseCs.receipts;

/** Compensating correction of one receipt line (warehouse manager; reason required). */
export function CorrectionForm({ code, lineNo }: { code: string; lineNo: number }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [delta, setDelta] = useState('');
  const [reason, setReason] = useState('');
  const [requestId, setRequestId] = useState(() => crypto.randomUUID());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!open) {
    return (
      <button type="button" className="text-sm underline" onClick={() => setOpen(true)}>
        {r.correct}
      </button>
    );
  }
  const valid =
    /^-?(0|[1-9]\d{0,15})(\.\d{1,3})?$/.test(delta) &&
    !/^-?0(\.0+)?$/.test(delta) &&
    reason.trim().length >= 3;

  return (
    <form
      className="mt-2 flex flex-col gap-2 rounded-md border border-stone-200 p-3"
      data-testid={`correction-form-${lineNo}`}
      onSubmit={async (e) => {
        e.preventDefault();
        setBusy(true);
        setError(null);
        try {
          await apiSend('POST', `admin/goods-receipts/${code}/corrections`, goodsReceiptSchema, {
            requestId,
            lineNo,
            quantityDelta: delta,
            reason: reason.trim(),
          });
          setOpen(false);
          setDelta('');
          setReason('');
          setRequestId(crypto.randomUUID());
          router.refresh();
        } catch (err) {
          setError(apiErrorText(err));
        } finally {
          setBusy(false);
        }
      }}
    >
      <p className="text-xs text-stone-500">{r.correctionHelp}</p>
      <input
        aria-label={r.correctionDelta}
        placeholder={r.correctionDelta}
        inputMode="decimal"
        value={delta}
        onChange={(e) => {
          setDelta(e.target.value.trim());
          setRequestId(crypto.randomUUID());
        }}
        className={inputClass}
      />
      <input
        aria-label={r.correctionReason}
        placeholder={r.correctionReason}
        value={reason}
        maxLength={500}
        onChange={(e) => {
          setReason(e.target.value);
          setRequestId(crypto.randomUUID());
        }}
        className={inputClass}
      />
      {error && <ErrorNote>{error}</ErrorNote>}
      <div className="flex gap-2">
        <button type="submit" className={buttonClass.primary} disabled={busy || !valid}>
          {r.correctionSave}
        </button>
        <button type="button" className={buttonClass.secondary} onClick={() => setOpen(false)}>
          {warehouseCs.common.cancel}
        </button>
      </div>
    </form>
  );
}

/** Adds a document to a confirmed receipt (e.g. the invoice arriving later). Append-only. */
export function AttachDocument({ code, supplierId }: { code: string; supplierId: string }) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  return (
    <div className="flex flex-col gap-2">
      <SupplierDocumentUpload
        supplierId={supplierId}
        submitLabel={r.attach}
        onUploaded={async (document) => {
          setError(null);
          try {
            await apiSend('POST', `admin/goods-receipts/${code}/documents`, goodsReceiptSchema, {
              requestId: crypto.randomUUID(),
              documentId: document.id,
            });
            router.refresh();
          } catch (e) {
            setError(apiErrorText(e));
          }
        }}
      />
      {error && <ErrorNote>{error}</ErrorNote>}
    </div>
  );
}
