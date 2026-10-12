'use client';

import { siteDetailSchema, suggestedWarehouseCode } from '@ayvo/types';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { buttonClass, ErrorNote, inputClass } from '@/components/ui';
import { identityCs } from '@/i18n/cs/identity';
import { apiSend, ClientApiError } from '@/lib/client-api';
import { errorText } from './create-user-form';

const t = identityCs.sites_admin;
const label = 'text-xs font-medium uppercase tracking-wide text-stone-500';

/**
 * Creates the site's warehouse (v0.1: one per site, always the default; doc 022 §2). The code is
 * globally unique and immutable — prefilled as `<SITE>-MAIN`. One attempt keeps its request id
 * across retries after a network error, so a repeated click never creates a second warehouse.
 */
export function SiteWarehouseForm({ siteId, siteCode }: { siteId: string; siteCode: string }) {
  const router = useRouter();
  const [code, setCode] = useState(suggestedWarehouseCode(siteCode) ?? '');
  const [name, setName] = useState(t.defaultWarehouseName);
  const [reason, setReason] = useState('');
  const [requestId, setRequestId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  return (
    <form
      className="flex flex-col gap-3"
      data-testid="site-warehouse-form"
      onSubmit={async (e) => {
        e.preventDefault();
        const id = requestId ?? crypto.randomUUID();
        setRequestId(id);
        setBusy(true);
        setError(null);
        try {
          await apiSend('POST', `admin/sites/${siteId}/warehouses`, siteDetailSchema, {
            requestId: id,
            code,
            name,
            reason,
          });
          router.refresh();
        } catch (err) {
          setError(errorText(err));
          // A definite answer ends the attempt; a network error keeps the id for a safe retry.
          if (err instanceof ClientApiError) setRequestId(null);
          setBusy(false);
        }
      }}
    >
      <h3 className={label}>{t.newWarehouse}</h3>
      <label className="flex min-w-0 flex-col gap-1">
        <span className={label}>{t.warehouseCode}</span>
        <input
          required
          value={code}
          onChange={(e) => {
            setCode(e.target.value.toUpperCase());
            setRequestId(null);
          }}
          pattern="[A-Z][A-Z0-9_\-]{1,19}"
          className={`${inputClass} font-mono`}
        />
      </label>
      <p className="text-xs text-stone-500">{t.warehouseCodeHelp}</p>
      <label className="flex min-w-0 flex-col gap-1">
        <span className={label}>{t.warehouseName}</span>
        <input
          required
          maxLength={80}
          value={name}
          onChange={(e) => {
            setName(e.target.value);
            setRequestId(null);
          }}
          className={inputClass}
        />
      </label>
      <label className="flex min-w-0 flex-col gap-1">
        <span className={label}>{identityCs.admin.reason}</span>
        <input
          required
          minLength={3}
          value={reason}
          onChange={(e) => {
            setReason(e.target.value);
            setRequestId(null);
          }}
          placeholder={identityCs.admin.reasonPlaceholder}
          className={inputClass}
        />
      </label>
      {error && <ErrorNote>{error}</ErrorNote>}
      <button
        type="submit"
        disabled={busy || reason.trim().length < 3 || !code || !name.trim()}
        className={`${buttonClass.primary} self-start whitespace-nowrap`}
      >
        {busy ? t.saving : t.createWarehouse}
      </button>
    </form>
  );
}
