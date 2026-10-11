'use client';

import { supplierSchema } from '@ayvo/types';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { buttonClass, ErrorNote, inputClass } from '@/components/ui';
import { warehouseCs } from '@/i18n/cs/warehouse';
import { apiSend } from '@/lib/client-api';
import { apiErrorText } from './supplier-document-upload';

const s = warehouseCs.suppliers;

export function SupplierForm() {
  const router = useRouter();
  const [name, setName] = useState('');
  const [companyId, setCompanyId] = useState('');
  const [vatId, setVatId] = useState('');
  const [requestId, setRequestId] = useState(() => crypto.randomUUID());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const changed = (set: (v: string) => void) => (e: React.ChangeEvent<HTMLInputElement>) => {
    set(e.target.value);
    setRequestId(crypto.randomUUID());
  };
  return (
    <form
      className="grid grid-cols-1 gap-3 sm:grid-cols-[1fr_10rem_10rem_auto] sm:items-end"
      onSubmit={async (e) => {
        e.preventDefault();
        setBusy(true);
        setError(null);
        try {
          await apiSend('POST', 'admin/suppliers', supplierSchema, {
            requestId,
            name: name.trim(),
            companyId: companyId.trim() || null,
            vatId: vatId.trim() || null,
          });
          setName('');
          setCompanyId('');
          setVatId('');
          setRequestId(crypto.randomUUID());
          router.refresh();
        } catch (err) {
          setError(apiErrorText(err));
        } finally {
          setBusy(false);
        }
      }}
    >
      <label className="flex flex-col gap-1 text-sm">
        {s.name}
        <input value={name} onChange={changed(setName)} maxLength={120} className={inputClass} />
      </label>
      <label className="flex flex-col gap-1 text-sm">
        {s.companyId}
        <input
          value={companyId}
          onChange={changed(setCompanyId)}
          maxLength={32}
          className={inputClass}
        />
      </label>
      <label className="flex flex-col gap-1 text-sm">
        {s.vatId}
        <input value={vatId} onChange={changed(setVatId)} maxLength={32} className={inputClass} />
      </label>
      <button type="submit" className={buttonClass.primary} disabled={busy || name.trim() === ''}>
        {s.create}
      </button>
      {error && (
        <div className="sm:col-span-4">
          <ErrorNote>{error}</ErrorNote>
        </div>
      )}
    </form>
  );
}

export function ArchiveSupplierButton({ id }: { id: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  return (
    <button
      type="button"
      className="text-sm underline disabled:opacity-50"
      disabled={busy}
      onClick={async () => {
        setBusy(true);
        try {
          await apiSend('POST', `admin/suppliers/${id}/archive`, supplierSchema, {
            requestId: crypto.randomUUID(),
          });
          router.refresh();
        } finally {
          setBusy(false);
        }
      }}
    >
      {s.archive}
    </button>
  );
}
