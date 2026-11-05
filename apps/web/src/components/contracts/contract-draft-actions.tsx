'use client';

import { contractDraftDetailSchema, hotelIdentityMatches, type HotelIdentity } from '@ayvo/types';
import { HotelMismatch } from '@/components/contracts/contract-draft-wizard';
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

/**
 * Link an existing hotel by hand, or correct a wrong link (sales:manage + hotels:read); never
 * creates one. The draft's hotel and the chosen one are shown side by side; a difference needs an
 * explicit acknowledgement — or the draft is edited first (review CD121-1).
 */
export function LinkHotel({
  code,
  version,
  hotels,
  draft,
  linked,
  signed = false,
}: {
  code: string;
  version: number;
  hotels: (HotelIdentity & { code: string })[];
  /** The hotel the draft names — for a signed draft, the one its signed revision names. */
  draft: HotelIdentity;
  linked: string | null;
  signed?: boolean;
}) {
  const [hotel, setHotel] = useState('');
  const [reason, setReason] = useState('');
  const [ack, setAck] = useState(false);
  const chosen = hotels.find((h) => h.code === hotel) ?? null;
  const mismatch = !!chosen && !hotelIdentityMatches(draft, chosen);
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
          acknowledgeMismatch: !signed && mismatch && ack,
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
            setAck(false);
            fresh();
          }}
        >
          <option value="">{t.choose}</option>
          {hotels
            .filter((h) => h.code !== linked)
            .map((h) => (
              <option key={h.code} value={h.code}>
                {h.name} ({h.code})
              </option>
            ))}
        </select>
      </label>
      {mismatch && chosen && (
        <HotelMismatch
          draft={draft}
          hotel={chosen}
          acknowledged={ack}
          onAcknowledge={setAck}
          signed={signed}
        />
      )}
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
          disabled={busy || !hotel || !reason.trim() || (mismatch && (signed || !ack))}
          data-testid="contract-link-submit"
        >
          {t.link.submit}
        </button>
      </div>
      {error && <ErrorNote>{error}</ErrorNote>}
    </form>
  );
}

/**
 * Upload the already signed PDF of the CURRENT revision (doc 045 §7): a file, the signed day and an
 * explicit confirmation that it locks the revision. The server checks the version seen and that the
 * revision is still the current one (a concurrent edit or removal wins → nothing stored).
 */
export function UploadSigned({
  code,
  version,
  revision,
}: {
  code: string;
  version: number;
  revision: number;
}) {
  const router = useRouter();
  const [file, setFile] = useState<File | null>(null);
  const [signedOn, setSignedOn] = useState('');
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const requestId = useRef(crypto.randomUUID());
  const fresh = () => (requestId.current = crypto.randomUUID());
  return (
    <form
      className="flex flex-col gap-3"
      data-testid="contract-upload-signed"
      onSubmit={async (e) => {
        e.preventDefault();
        if (!file) return;
        const body = new FormData();
        body.set('requestId', requestId.current);
        body.set('expectedVersion', String(version));
        body.set('revision', String(revision));
        body.set('signedOn', signedOn);
        body.set('confirm', 'true');
        body.set('file', file);
        setBusy(true);
        setError(null);
        try {
          await apiSend(
            'POST',
            `admin/contracts/drafts/${code}/signed`,
            contractDraftDetailSchema,
            body,
          );
          fresh();
          router.refresh();
        } catch (err) {
          const c = err instanceof ClientApiError ? err.code : null;
          setError((c && t.errors[c]) ?? (err instanceof Error ? err.message : String(err)));
          if (c === 'CONCURRENT_CHANGE') router.refresh();
        } finally {
          setBusy(false);
        }
      }}
    >
      <label className="flex flex-col gap-1 text-sm font-medium">
        {t.signed.file}
        <input
          type="file"
          name="file"
          accept="application/pdf,.pdf"
          required
          className="text-sm"
          onChange={(e) => {
            setFile(e.target.files?.[0] ?? null);
            fresh();
          }}
        />
      </label>
      <label className="flex flex-col gap-1 text-sm font-medium">
        {t.signed.signedOn}
        <input
          type="date"
          name="signedOn"
          required
          className={inputClass}
          value={signedOn}
          onChange={(e) => {
            setSignedOn(e.target.value);
            fresh();
          }}
        />
      </label>
      <label className="flex items-start gap-2 text-sm">
        <input
          type="checkbox"
          className="mt-1"
          checked={confirmed}
          onChange={(e) => setConfirmed(e.target.checked)}
          data-testid="contract-upload-confirm"
        />
        <span>{t.signed.confirm(revision)}</span>
      </label>
      <div>
        <button
          type="submit"
          className={buttonClass.primary}
          disabled={busy || !file || !signedOn || !confirmed}
          data-testid="contract-upload-submit"
        >
          {t.signed.submit}
        </button>
      </div>
      {error && <ErrorNote>{error}</ErrorNote>}
    </form>
  );
}
