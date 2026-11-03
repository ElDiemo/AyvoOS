'use client';

import { contractDraftDetailSchema } from '@ayvo/types';
import { useRouter } from 'next/navigation';
import { useRef, useState } from 'react';
import { buttonClass, ErrorNote, inputClass } from '@/components/ui';
import { contractsCs as t } from '@/i18n/cs/contracts';
import { apiSend, ClientApiError } from '@/lib/client-api';

function useSend() {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const requestId = useRef(crypto.randomUUID());
  async function send(path: string, body: Record<string, unknown>) {
    setBusy(true);
    setError(null);
    try {
      await apiSend('POST', path, contractDraftDetailSchema, {
        requestId: requestId.current,
        ...body,
      });
      requestId.current = crypto.randomUUID();
      router.refresh();
    } catch (err) {
      const code = err instanceof ClientApiError ? err.code : null;
      setError((code && t.errors[code]) ?? (err instanceof Error ? err.message : String(err)));
      if (code === 'CONCURRENT_CHANGE') router.refresh();
    } finally {
      setBusy(false);
    }
  }
  return { busy, error, send, fresh: () => (requestId.current = crypto.randomUUID()) };
}

/**
 * Remove an unsigned draft, or restore a removed one (doc 045 §2): an explicit confirmation and a
 * reason; nothing is deleted — the draft and its history stay and can be restored.
 */
export function RemoveOrRestore({
  code,
  version,
  removed,
}: {
  code: string;
  version: number;
  removed: boolean;
}) {
  const [reason, setReason] = useState('');
  const [confirmed, setConfirmed] = useState(false);
  const { busy, error, send, fresh } = useSend();
  const tx = removed
    ? { reason: t.remove.restoreReason, confirm: t.remove.restoreConfirm, submit: t.remove.restore }
    : { reason: t.remove.reason, confirm: t.remove.confirm, submit: t.remove.submit };
  return (
    <form
      className="flex flex-col gap-3"
      data-testid={removed ? 'contract-restore' : 'contract-remove'}
      onSubmit={(e) => {
        e.preventDefault();
        void send(`admin/contracts/drafts/${code}/${removed ? 'restore' : 'remove'}`, {
          expectedVersion: version,
          reason: reason.trim(),
          confirm: true,
        });
      }}
    >
      <label className="flex flex-col gap-1 text-sm font-medium">
        {tx.reason}
        <input
          name="reason"
          className={inputClass}
          required
          value={reason}
          onChange={(e) => {
            setReason(e.target.value);
            fresh();
          }}
        />
      </label>
      <label className="flex items-start gap-2 text-sm">
        <input
          type="checkbox"
          className="mt-1"
          required
          checked={confirmed}
          onChange={(e) => setConfirmed(e.target.checked)}
          data-testid="contract-confirm"
        />
        <span>{tx.confirm}</span>
      </label>
      <div>
        <button
          type="submit"
          className={removed ? buttonClass.secondary : buttonClass.danger}
          disabled={busy || !confirmed || !reason.trim()}
          data-testid="contract-confirm-submit"
        >
          {tx.submit}
        </button>
      </div>
      {error && <ErrorNote>{error}</ErrorNote>}
    </form>
  );
}

/** Link an existing hotel by hand (sales:manage + hotels:read); never creates one. */
export function LinkHotel({
  code,
  version,
  hotels,
}: {
  code: string;
  version: number;
  hotels: { code: string; name: string }[];
}) {
  const [hotel, setHotel] = useState('');
  const [reason, setReason] = useState('');
  const { busy, error, send, fresh } = useSend();
  return (
    <form
      className="flex flex-col gap-3"
      data-testid="contract-link-hotel"
      onSubmit={(e) => {
        e.preventDefault();
        void send(`admin/contracts/drafts/${code}/hotel`, {
          expectedVersion: version,
          hotelCode: hotel,
          reason: reason.trim(),
        });
      }}
    >
      <p className="text-xs text-stone-500">{t.link.help}</p>
      <label className="flex flex-col gap-1 text-sm font-medium">
        {t.link.hotel}
        <select
          name="hotelCode"
          className={inputClass}
          required
          value={hotel}
          onChange={(e) => {
            setHotel(e.target.value);
            fresh();
          }}
        >
          <option value="">{t.choose}</option>
          {hotels.map((h) => (
            <option key={h.code} value={h.code}>
              {h.name} ({h.code})
            </option>
          ))}
        </select>
      </label>
      <label className="flex flex-col gap-1 text-sm font-medium">
        {t.link.reason}
        <input
          name="reason"
          className={inputClass}
          required
          value={reason}
          onChange={(e) => {
            setReason(e.target.value);
            fresh();
          }}
        />
      </label>
      <div>
        <button
          type="submit"
          className={buttonClass.secondary}
          disabled={busy || !hotel || !reason.trim()}
          data-testid="contract-link-submit"
        >
          {t.link.submit}
        </button>
      </div>
      {error && <ErrorNote>{error}</ErrorNote>}
    </form>
  );
}
