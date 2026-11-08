'use client';

import type {
  FinancePortalAccess,
  FinancePortalGrantResult,
  PortalGrantListItem,
} from '@ayvo/types';
import { useRouter } from 'next/navigation';
import { useRef, useState } from 'react';
import { z } from 'zod';
import { buttonClass, ErrorNote, inputClass } from '@/components/ui';
import { portalAccessCs as t } from '@/i18n/cs/finance-portal';
import { formatDateTimeCs } from '@/i18n/cs/format';
import { apiSend, ClientApiError } from '@/lib/client-api';

type Hotel = FinancePortalAccess['payerHotels'][number];

/** One action's request id, kept for retries of the same input (a new one after any edit). */
function useAction() {
  const router = useRouter();
  const requestId = useRef(crypto.randomUUID());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const fresh = () => {
    requestId.current = crypto.randomUUID();
    setNote(null);
  };
  /** `idempotent: false` — the route takes no requestId (the core's revocation). */
  async function run(path: string, body: Record<string, unknown>, idempotent = true) {
    if (busy) return;
    setBusy(true);
    setError(null);
    setNote(null);
    try {
      const r = (await apiSend(
        'POST',
        path,
        z.unknown(),
        idempotent ? { requestId: requestId.current, ...body } : body,
      )) as Partial<FinancePortalGrantResult>;
      // An uncertain invitation keeps the id: saving again repeats the same request. Anything
      // else is settled, and the next action is a new one.
      if (r.invitation !== 'UNCERTAIN') fresh();
      setNote(r.invitation ? (t.invitation[r.invitation] ?? t.saved) : t.saved);
      router.refresh();
    } catch (err) {
      setError(
        err instanceof ClientApiError && err.code && t.errors[err.code]
          ? t.errors[err.code]!
          : err instanceof Error
            ? err.message
            : String(err),
      );
    } finally {
      setBusy(false);
    }
  }
  return { busy, error, note, run, fresh };
}

function HotelPicker({
  hotels,
  chosen,
  onChange,
}: {
  hotels: Hotel[];
  chosen: Set<string>;
  onChange: (next: Set<string>) => void;
}) {
  return (
    <fieldset className="flex flex-col gap-1">
      <legend className="text-sm font-medium">{t.hotels}</legend>
      {hotels.map((h) => (
        <label key={h.id} className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={chosen.has(h.id)}
            onChange={(e) => {
              const next = new Set(chosen);
              if (e.target.checked) next.add(h.id);
              else next.delete(h.id);
              onChange(next);
            }}
          />
          {h.name}
          {h.basis === 'INVOICE' && (
            <span className="text-xs text-stone-500">({t.invoiceOnly})</span>
          )}
        </label>
      ))}
    </fieldset>
  );
}

function NewAccess({ payerCustomerId, hotels }: { payerCustomerId: string; hotels: Hotel[] }) {
  const { busy, error, note, run, fresh } = useAction();
  const [email, setEmail] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [reason, setReason] = useState('');
  const [chosen, setChosen] = useState<Set<string>>(new Set());
  const edit =
    <T,>(set: (v: T) => void) =>
    (v: T) => {
      set(v);
      fresh();
    };
  return (
    <form
      className="flex flex-col gap-3"
      data-testid="portal-access-new"
      onSubmit={(e) => {
        e.preventDefault();
        if (chosen.size === 0) return;
        void run('admin/finance/portal-grants', {
          payerCustomerId,
          email,
          displayName,
          hotelIds: [...chosen],
          reason,
        });
      }}
    >
      <label className="flex flex-col gap-1 text-sm">
        {t.email}
        <input
          type="email"
          name="email"
          required
          value={email}
          onChange={(e) => edit(setEmail)(e.target.value)}
          className={inputClass}
        />
      </label>
      <label className="flex flex-col gap-1 text-sm">
        {t.displayName}
        <input
          name="displayName"
          required
          value={displayName}
          onChange={(e) => edit(setDisplayName)(e.target.value)}
          className={inputClass}
        />
      </label>
      <HotelPicker hotels={hotels} chosen={chosen} onChange={edit(setChosen)} />
      {chosen.size === 0 && <p className="text-xs text-stone-500">{t.pickHotel}</p>}
      <label className="flex flex-col gap-1 text-sm">
        {t.reason}
        <input
          name="reason"
          required
          minLength={3}
          value={reason}
          onChange={(e) => edit(setReason)(e.target.value)}
          className={inputClass}
        />
      </label>
      {error && <ErrorNote>{error}</ErrorNote>}
      {note && (
        <p role="status" className="text-sm text-emerald-700">
          {note}
        </p>
      )}
      <button
        type="submit"
        disabled={busy || chosen.size === 0}
        className={buttonClass.primary}
        data-testid="portal-access-save"
      >
        {t.save}
      </button>
    </form>
  );
}

/** An active grant: a new invitation after a failed one, a change of hotels, revocation. */
function ActiveGrant({ grant, hotels }: { grant: PortalGrantListItem; hotels: Hotel[] }) {
  const change = useAction();
  const revoke = useAction();
  const invite = useAction();
  const [chosen, setChosen] = useState<Set<string>>(new Set(grant.hotelIds));
  const [reason, setReason] = useState('');
  const [revokeReason, setRevokeReason] = useState('');
  return (
    <div className="mt-2 flex flex-col gap-3">
      {grant.account.invitation === 'FAILED' && (
        <div className="flex flex-col gap-1">
          <button
            type="button"
            disabled={invite.busy}
            className={buttonClass.secondary}
            data-testid={`portal-access-reinvite-${grant.id}`}
            onClick={() =>
              void invite.run(`admin/finance/portal-grants/${grant.id}/invitation`, {})
            }
          >
            {t.reinvite}
          </button>
          {invite.error && <ErrorNote>{invite.error}</ErrorNote>}
        </div>
      )}
      {hotels.length > 0 && (
        <details>
          <summary className="cursor-pointer text-sm font-medium">{t.change}</summary>
          <form
            className="mt-2 flex flex-col gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              if (chosen.size === 0) return;
              void change.run(`admin/finance/portal-grants/${grant.id}/replace`, {
                hotelIds: [...chosen],
                reason,
              });
            }}
          >
            <HotelPicker
              hotels={hotels}
              chosen={chosen}
              onChange={(n) => {
                setChosen(n);
                change.fresh();
              }}
            />
            <input
              required
              minLength={3}
              placeholder={t.reason}
              value={reason}
              onChange={(e) => {
                setReason(e.target.value);
                change.fresh();
              }}
              className={inputClass}
            />
            {change.error && <ErrorNote>{change.error}</ErrorNote>}
            <button
              type="submit"
              disabled={change.busy || chosen.size === 0}
              className={buttonClass.secondary}
            >
              {t.saveChange}
            </button>
          </form>
        </details>
      )}
      {/* Revocation is always offered for an active grant — also when no hotel is on offer now. */}
      <details>
        <summary
          className="cursor-pointer text-sm font-medium"
          data-testid={`portal-access-revoke-${grant.id}`}
        >
          {t.revoke}
        </summary>
        <form
          className="mt-2 flex flex-col gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            void revoke.run(
              `admin/identity/portal-grants/${grant.id}/revoke`,
              { reason: revokeReason },
              false,
            );
          }}
        >
          <input
            name="revokeReason"
            required
            minLength={3}
            placeholder={t.reason}
            value={revokeReason}
            onChange={(e) => setRevokeReason(e.target.value)}
            className={inputClass}
          />
          {revoke.error && <ErrorNote>{revoke.error}</ErrorNote>}
          <button
            type="submit"
            disabled={revoke.busy}
            className={buttonClass.secondary}
            data-testid={`portal-access-revoke-confirm-${grant.id}`}
          >
            {t.confirmRevoke}
          </button>
        </form>
      </details>
    </div>
  );
}

/** The payer's hotel portal access: its grants, a new one, a change of hotels, revocation. */
export function PortalAccess({
  payerCustomerId,
  access,
}: {
  payerCustomerId: string;
  access: FinancePortalAccess;
}) {
  const { grants, payerHotels: hotels, hotelNames } = access;
  return (
    <div className="flex flex-col gap-4">
      <p className="text-xs text-stone-500">{t.help}</p>
      {grants.length === 0 ? (
        <p className="text-sm text-stone-500">{t.none}</p>
      ) : (
        <ul className="divide-y divide-stone-100 text-sm" data-testid="portal-access-list">
          {grants.map((g) => (
            <li
              key={g.id}
              className="flex flex-col gap-1 py-2"
              data-testid={`portal-access-grant-${g.id}`}
            >
              <span className="font-medium break-all">
                {g.account.displayName} · {g.account.email}
              </span>
              <span className="text-stone-600">
                {g.revokedAt === null
                  ? `${t.active} · ${t.accountState[g.account.invitation]}`
                  : g.revokeReason === 'nahrazen'
                    ? t.replaced
                    : `${t.revoked}: ${g.revokeReason}`}
              </span>
              <span className="text-stone-600">
                {t.hotels}: {g.hotelIds.map((id) => hotelNames[id] ?? id).join(', ')}
              </span>
              <span className="text-xs text-stone-500">
                {t.granted(formatDateTimeCs(g.grantedAt))}
              </span>
              {g.revokedAt === null && <ActiveGrant grant={g} hotels={hotels} />}
            </li>
          ))}
        </ul>
      )}
      {hotels.length === 0 ? (
        <p className="text-sm text-stone-500">{t.noPayerHotels}</p>
      ) : (
        <details>
          <summary className="cursor-pointer text-sm font-medium" data-testid="portal-access-open">
            {t.newAccess}
          </summary>
          <div className="mt-3">
            <NewAccess payerCustomerId={payerCustomerId} hotels={hotels} />
          </div>
        </details>
      )}
    </div>
  );
}
