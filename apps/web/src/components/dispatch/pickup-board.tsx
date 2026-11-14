'use client';

import { pickupViewSchema, type PickupBoard as Board, type PickupView } from '@ayvo/types';
import { useRouter } from 'next/navigation';
import { useId, useState } from 'react';
import { ConfirmDialog, reasonError, ReasonField, useAttempt } from '@/components/catalog/form-kit';
import { buttonClass, Card, EmptyState } from '@/components/ui';
import { formatDateCs, formatDateTimeCs } from '@/i18n/cs/format';
import { pickupsCs as t } from '@/i18n/cs/pickups';
import { apiSend, ClientApiError } from '@/lib/client-api';

const errorText = (error: unknown) =>
  error instanceof ClientApiError
    ? ((error.code && t.errors[error.code]) ?? error.message)
    : 'Požadavek se nezdařil – zkuste to znovu.';

/**
 * Expedice → Svoz (doc 029 §11). Every eligible order is selected by default and can be left out;
 * one explicit, confirmed "Objednat svoz PPL" for this site. A waiting pickup blocks a new one.
 */
export function PickupBoard({
  board,
  canOrder,
  canResolve,
}: {
  board: Board;
  canOrder: boolean;
  canResolve: boolean;
}) {
  const router = useRouter();
  const id = useId();
  const eligible = board.candidates.filter((c) => c.eligible);
  const [selected, setSelected] = useState<Set<string>>(
    () => new Set(eligible.map((c) => c.orderCode)),
  );
  const [date, setDate] = useState(board.today);
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [open, setOpen] = useState(false);
  const [checked, setChecked] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { busy, run } = useAttempt();

  const chosen = eligible.filter((c) => selected.has(c.orderCode));
  // The pickup announces the parcels not yet with the carrier and not held by another pickup.
  const parcels = chosen.reduce((n, c) => n + c.eligibleParcels.length, 0);
  const max = board.carrier.maxParcels;
  const windowValid = (from === '' && to === '') || (from !== '' && to !== '' && from < to);
  const blocked = !!board.open || !board.carrier.available;
  const canSubmit =
    canOrder && !blocked && chosen.length > 0 && windowValid && (max === null || parcels <= max);

  function toggle(code: string) {
    setSelected((s) => {
      const next = new Set(s);
      if (next.has(code)) next.delete(code);
      else next.add(code);
      return next;
    });
  }

  async function submit() {
    const body = {
      date,
      window: from && to ? { from, to } : null,
      orders: chosen.map((c) => c.orderCode).sort(),
      confirmed: true as const,
    };
    const result = await run(JSON.stringify(body), (requestId) =>
      apiSend('POST', 'admin/dispatch/pickups', pickupViewSchema, { requestId, ...body }),
    );
    if (result.ok) {
      setOpen(false);
      setChecked(false);
      setError(null);
      router.refresh();
    } else if (result.error) setError(errorText(result.error));
  }

  return (
    <div className="space-y-4">
      <CarrierCard board={board} />
      {board.open && (
        <Card>
          <h2 className="mb-1 text-base font-semibold">{t.open}</h2>
          <p className="mb-3 text-sm text-stone-600">{t.openBlocks}</p>
          <PickupItem pickup={board.open} canOrder={canOrder} canResolve={canResolve} />
        </Card>
      )}
      <Card>
        <h2 className="mb-3 text-base font-semibold">{t.ready}</h2>
        {board.candidates.length === 0 ? (
          <EmptyState>{t.readyEmpty}</EmptyState>
        ) : (
          <ul className="divide-y divide-stone-200" data-testid="pickup-candidates">
            {board.candidates.map((c) => (
              <li key={c.orderCode} className="flex items-start gap-3 py-2">
                <input
                  id={`${id}-${c.orderCode}`}
                  type="checkbox"
                  className="mt-1 h-5 w-5"
                  checked={c.eligible && selected.has(c.orderCode)}
                  disabled={!c.eligible || !canOrder || blocked}
                  onChange={() => toggle(c.orderCode)}
                  data-testid={`pickup-select-${c.orderCode}`}
                />
                <label htmlFor={`${id}-${c.orderCode}`} className="min-w-0 flex-1 text-sm">
                  <span className="font-medium">{c.orderCode}</span> · {c.hotelName}, {c.city}
                  <span className="block text-xs text-stone-500">
                    {t.columns.shipDate}: {formatDateCs(c.requestedShipDate)} · {c.shipmentCode} ·{' '}
                    {t.columns.parcels}: {c.eligible ? c.eligibleParcels.length : 0}/{c.parcelCount}
                    {c.pickedUpCount > 0 && <> · {t.pickedUp(c.pickedUpCount)}</>}
                    {c.blockedBy === 'IN_PICKUP' && c.pickupCode && (
                      <> · {t.blocked.IN_PICKUP(c.pickupCode)}</>
                    )}
                    {c.blockedBy === 'OTHER_CARRIER' && <> · {t.blocked.OTHER_CARRIER}</>}
                  </span>
                </label>
              </li>
            ))}
          </ul>
        )}
        {canOrder && eligible.length > 0 && (
          <div className="mt-4 space-y-3 border-t border-stone-200 pt-4">
            <div className="flex flex-wrap gap-4">
              <label className="text-sm">
                <span className="block text-stone-700">{t.date}</span>
                <input
                  type="date"
                  className="mt-1 rounded border border-stone-300 px-2 py-1"
                  min={board.today}
                  value={date}
                  onChange={(e) => setDate(e.target.value)}
                  data-testid="pickup-date"
                />
              </label>
              <fieldset className="text-sm">
                <legend className="text-stone-700">{t.window}</legend>
                <div className="mt-1 flex items-center gap-2">
                  <input
                    type="time"
                    aria-label={t.windowFrom}
                    className="rounded border border-stone-300 px-2 py-1"
                    value={from}
                    onChange={(e) => setFrom(e.target.value)}
                    data-testid="pickup-from"
                  />
                  <span aria-hidden>–</span>
                  <input
                    type="time"
                    aria-label={t.windowTo}
                    className="rounded border border-stone-300 px-2 py-1"
                    value={to}
                    onChange={(e) => setTo(e.target.value)}
                    data-testid="pickup-to"
                  />
                </div>
                <p className="mt-1 text-xs text-stone-500">{t.windowNote}</p>
              </fieldset>
            </div>
            <p className="text-sm font-medium" data-testid="pickup-total">
              {t.total(chosen.length, parcels)}
            </p>
            {max !== null && parcels > max && (
              <p className="text-sm text-red-700">{t.tooMany(max)}</p>
            )}
            {error && !open && (
              <p role="alert" className="text-sm text-red-700">
                {error}
              </p>
            )}
            <button
              type="button"
              className={buttonClass.primary}
              disabled={!canSubmit}
              onClick={() => {
                setError(null);
                setOpen(true);
              }}
              data-testid="pickup-order"
            >
              {t.orderButton}
            </button>
          </div>
        )}
      </Card>
      <Card>
        <h2 className="mb-3 text-base font-semibold">{t.history}</h2>
        {board.pickups.length === 0 ? (
          <EmptyState>{t.historyEmpty}</EmptyState>
        ) : (
          <ul className="space-y-4" data-testid="pickup-history">
            {board.pickups.map((p) => (
              <li key={p.code}>
                <PickupItem pickup={p} canOrder={canOrder} canResolve={canResolve} />
              </li>
            ))}
          </ul>
        )}
      </Card>
      <ConfirmDialog
        open={open}
        title={t.confirmTitle}
        confirmLabel={t.confirmButton}
        busy={busy}
        confirmDisabled={!checked}
        onConfirm={submit}
        onCancel={() => setOpen(false)}
        testId="pickup-confirm"
      >
        <p>{t.confirmText(parcels, formatDateCs(date))}</p>
        <EnvironmentNote environment={board.carrier.environment} />
        <label className="mt-3 flex items-start gap-2 text-sm">
          <input
            type="checkbox"
            className="mt-0.5 h-5 w-5"
            checked={checked}
            onChange={(e) => setChecked(e.target.checked)}
            data-testid="pickup-confirm-check"
          />
          {t.confirmCheck}
        </label>
        {error && (
          <p role="alert" className="mt-2 text-sm text-red-700">
            {error}
          </p>
        )}
      </ConfirmDialog>
    </div>
  );
}

function EnvironmentNote({ environment }: { environment: 'TEST' | 'PRODUCTION' | null }) {
  if (!environment) return null;
  return (
    <p
      className={
        environment === 'TEST'
          ? 'mt-2 rounded bg-amber-50 px-2 py-1 text-xs text-amber-900'
          : 'mt-2 rounded bg-red-50 px-2 py-1 text-xs font-medium text-red-900'
      }
      data-testid="pickup-environment"
    >
      {environment === 'TEST' ? t.testEnvironment : t.productionEnvironment}
    </p>
  );
}

function CarrierCard({ board }: { board: Board }) {
  const c = board.carrier;
  return (
    <Card>
      <p className="text-sm">
        <span className="text-stone-600">{t.carrier}:</span> {c.name ?? '—'}
      </p>
      {!c.available && (
        <p className="mt-1 text-sm text-red-700" data-testid="pickup-unavailable">
          {(c.reason && t.unavailable[c.reason]) ?? c.reason}
        </p>
      )}
      <EnvironmentNote environment={c.environment} />
      {c.sender && (
        <p className="mt-2 text-xs text-stone-600">
          {t.senderAddress}: {c.sender.name}, {c.sender.street}, {c.sender.postalCode}{' '}
          {c.sender.city}, {c.sender.country}
        </p>
      )}
    </Card>
  );
}

function PickupItem({
  pickup: p,
  canOrder,
  canResolve,
}: {
  pickup: PickupView;
  canOrder: boolean;
  canResolve: boolean;
}) {
  const router = useRouter();
  const id = useId();
  const [error, setError] = useState<string | null>(null);
  const [closing, setClosing] = useState(false);
  const [reason, setReason] = useState('');
  const [checked, setChecked] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [cancelReason, setCancelReason] = useState('');
  const [cancelChecked, setCancelChecked] = useState(false);
  const { busy, run } = useAttempt();
  const c = p.cancellation;
  const cancelOpen =
    !!c && (c.status === 'PREPARED' || c.status === 'SENT' || c.status === 'ACCEPTED');
  const lookable =
    p.status === 'ACCEPTED' ||
    p.status === 'SENT' ||
    (p.status === 'CONFIRMED' && !p.carrierOrderNumber) ||
    cancelOpen;
  // One cancellation at a time; a refused one may be followed by a new request.
  const cancellable =
    p.status === 'CONFIRMED' && p.carrierState !== 'Canceled' && (!c || c.status === 'REJECTED');

  async function requestCancel() {
    const invalid = reasonError(cancelReason);
    setError(invalid);
    if (invalid) return;
    const body = { reason: cancelReason.trim(), confirmed: true as const };
    const result = await run(`cancel:${JSON.stringify(body)}`, (requestId) =>
      apiSend('POST', `admin/dispatch/pickups/${p.code}/cancel`, pickupViewSchema, {
        requestId,
        ...body,
      }),
    );
    if (result.ok) {
      setCancelling(false);
      router.refresh();
    } else if (result.error) setError(errorText(result.error));
  }

  async function lookup() {
    const result = await run(`lookup:${p.code}`, (requestId) =>
      apiSend('POST', `admin/dispatch/pickups/${p.code}/lookup`, pickupViewSchema, { requestId }),
    );
    if (result.ok) router.refresh();
    else if (result.error) setError(errorText(result.error));
  }

  async function close() {
    const invalid = reasonError(reason);
    setError(invalid);
    if (invalid) return;
    const body = { reason: reason.trim(), checkedWithCarrier: true as const };
    const result = await run(JSON.stringify(body), (requestId) =>
      apiSend('POST', `admin/dispatch/pickups/${p.code}/resolve`, pickupViewSchema, {
        requestId,
        ...body,
      }),
    );
    if (result.ok) {
      setClosing(false);
      router.refresh();
    } else if (result.error) setError(errorText(result.error));
  }

  return (
    <div className="text-sm" data-testid={`pickup-${p.code}`}>
      <p className="font-medium">
        {p.code} · {formatDateCs(p.date)}
        {p.window && ` · ${p.window.from}–${p.window.to}`} · {p.parcelCount} bal. ·{' '}
        <span data-testid={`pickup-status-${p.code}`}>{t.status[p.status] ?? p.status}</span>
        {p.carrier.environment === 'TEST' && ' · TEST'}
      </p>
      {p.carrierOrderNumber && (
        <p className="text-xs text-stone-600">
          {t.carrierNumber}: {p.carrierOrderNumber}
          {p.carrierState && ` (${p.carrierState})`}
        </p>
      )}
      {p.errorMessage && <p className="text-xs text-red-700">{p.errorMessage}</p>}
      {p.resolutionReason && <p className="text-xs text-stone-600">{p.resolutionReason}</p>}
      {c && (
        <p className="text-xs" data-testid={`pickup-cancel-${p.code}`}>
          <span className={c.status === 'CONFIRMED' ? 'text-stone-700' : 'text-amber-800'}>
            {t.cancelStatus[c.status] ?? c.status}
          </span>
          {' · '}
          {c.reason}
          {c.errorMessage && <span className="block text-red-700">{c.errorMessage}</span>}
        </p>
      )}
      <p className="mt-1 text-xs text-stone-500">{t.plan}:</p>
      <ul className="text-xs text-stone-700">
        {p.parcels.map((x) => (
          <li key={x.carrierParcelNumber}>
            {x.orderCode} · {x.hotelName} · {t.parcel} {x.parcelNo} ({x.carrierParcelNumber}) ·{' '}
            {x.pickedUp ? t.parcelPickedUp : (t.orderStatus[x.orderStatus] ?? x.orderStatus)}
          </li>
        ))}
      </ul>
      <p className="text-xs text-stone-400">{formatDateTimeCs(p.createdAt)}</p>
      {canOrder && cancellable && (
        <div className="mt-2">
          <button
            type="button"
            className={buttonClass.secondary}
            onClick={() => {
              setError(null);
              setCancelling(true);
            }}
            data-testid={`pickup-cancel-button-${p.code}`}
          >
            {t.cancel}
          </button>
        </div>
      )}
      {canOrder && lookable && (
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <button
            type="button"
            className={buttonClass.secondary}
            disabled={busy}
            onClick={lookup}
            data-testid={`pickup-lookup-${p.code}`}
          >
            {t.lookup}
          </button>
          {(p.lookupFrom ?? c?.lookupFrom) && (
            <span className="text-xs text-stone-500">
              {t.lookupFrom(formatDateTimeCs(p.lookupFrom ?? c?.lookupFrom))}
            </span>
          )}
          {/* Too early is refused by the API (PICKUP_IN_FLIGHT) and said so. */}
          {canResolve && p.status === 'SENT' && (
            <button
              type="button"
              className={buttonClass.secondary}
              onClick={() => setClosing(true)}
              data-testid={`pickup-resolve-${p.code}`}
            >
              {t.resolve}
            </button>
          )}
        </div>
      )}
      {error && !closing && !cancelling && (
        <p role="alert" className="mt-1 text-xs text-red-700">
          {error}
        </p>
      )}
      <ConfirmDialog
        open={closing}
        title={t.resolveTitle}
        confirmLabel={t.resolveConfirm}
        danger
        busy={busy}
        confirmDisabled={!checked}
        onConfirm={close}
        onCancel={() => setClosing(false)}
        testId={`pickup-resolve-dialog-${p.code}`}
      >
        <p>{t.resolveText}</p>
        <ReasonField id={`${id}-reason`} value={reason} onChange={setReason} error={error} />
        <label className="mt-3 flex items-start gap-2 text-sm">
          <input
            type="checkbox"
            className="mt-0.5 h-5 w-5"
            checked={checked}
            onChange={(e) => setChecked(e.target.checked)}
          />
          {t.resolveCheck}
        </label>
      </ConfirmDialog>
      <ConfirmDialog
        open={cancelling}
        title={t.cancelTitle}
        confirmLabel={t.cancelConfirm}
        danger
        busy={busy}
        confirmDisabled={!cancelChecked}
        onConfirm={requestCancel}
        onCancel={() => setCancelling(false)}
        testId={`pickup-cancel-dialog-${p.code}`}
      >
        <p>{t.cancelText}</p>
        <ReasonField
          id={`${id}-cancel-reason`}
          value={cancelReason}
          onChange={setCancelReason}
          error={error}
        />
        <label className="mt-3 flex items-start gap-2 text-sm">
          <input
            type="checkbox"
            className="mt-0.5 h-5 w-5"
            checked={cancelChecked}
            onChange={(e) => setCancelChecked(e.target.checked)}
            data-testid={`pickup-cancel-check-${p.code}`}
          />
          {t.cancelCheck}
        </label>
      </ConfirmDialog>
    </div>
  );
}
