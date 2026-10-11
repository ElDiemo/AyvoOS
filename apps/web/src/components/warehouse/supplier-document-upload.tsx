'use client';

import {
  supplierDocumentSchema,
  type SupplierDocument,
  type SupplierDocumentKind,
} from '@ayvo/types';
import { useState } from 'react';
import { buttonClass, ErrorNote, inputClass } from '@/components/ui';
import { warehouseCs } from '@/i18n/cs/warehouse';
import { apiSend, ClientApiError } from '@/lib/client-api';

const d = warehouseCs.documents;

export function apiErrorText(error: unknown): string {
  if (error instanceof ClientApiError && error.code && warehouseCs.apiErrors[error.code]) {
    return warehouseCs.apiErrors[error.code]!;
  }
  if (error instanceof ClientApiError && error.status < 500) return error.message;
  return warehouseCs.common.unexpectedError;
}

/** Uploads one supplier document (PDF/JPEG/PNG). Documents are immutable once uploaded. */
export function SupplierDocumentUpload({
  supplierId,
  onUploaded,
  submitLabel = d.upload,
}: {
  supplierId: string;
  onUploaded: (document: SupplierDocument) => void;
  submitLabel?: string;
}) {
  const [kind, setKind] = useState<SupplierDocumentKind>('DELIVERY_NOTE');
  const [number, setNumber] = useState('');
  const [issuedOn, setIssuedOn] = useState(() => new Date().toISOString().slice(0, 10));
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function upload() {
    if (!file) return;
    setBusy(true);
    setError(null);
    const form = new FormData();
    form.set('requestId', crypto.randomUUID());
    form.set('supplierId', supplierId);
    form.set('kind', kind);
    form.set('documentNumber', number.trim());
    form.set('issuedOn', issuedOn);
    form.set('file', file);
    try {
      onUploaded(await apiSend('POST', 'admin/supplier-documents', supplierDocumentSchema, form));
      setNumber('');
      setFile(null);
    } catch (e) {
      setError(apiErrorText(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="grid grid-cols-1 gap-3 rounded-md border border-stone-200 p-4 sm:grid-cols-2">
      <label className="flex flex-col gap-1 text-sm">
        {d.kind}
        <select
          value={kind}
          onChange={(e) => setKind(e.target.value as SupplierDocumentKind)}
          className={inputClass}
        >
          {(Object.keys(d.kinds) as SupplierDocumentKind[]).map((k) => (
            <option key={k} value={k}>
              {d.kinds[k]}
            </option>
          ))}
        </select>
      </label>
      <label className="flex flex-col gap-1 text-sm">
        {d.number}
        <input
          value={number}
          onChange={(e) => setNumber(e.target.value)}
          maxLength={64}
          className={inputClass}
        />
      </label>
      <label className="flex flex-col gap-1 text-sm">
        {d.issuedOn}
        <input
          type="date"
          value={issuedOn}
          onChange={(e) => setIssuedOn(e.target.value)}
          className={inputClass}
        />
      </label>
      <label className="flex flex-col gap-1 text-sm">
        {d.file}
        <input
          type="file"
          accept="application/pdf,image/jpeg,image/png"
          onChange={(e) => setFile(e.target.files?.[0] ?? null)}
          className="w-full min-w-0 text-sm"
        />
      </label>
      {error && (
        <div className="sm:col-span-2">
          <ErrorNote>{error}</ErrorNote>
        </div>
      )}
      <div className="sm:col-span-2">
        <button
          type="button"
          className={buttonClass.secondary}
          disabled={busy || !file || number.trim() === ''}
          onClick={() => void upload()}
        >
          {busy ? d.uploading : submitLabel}
        </button>
      </div>
    </div>
  );
}
