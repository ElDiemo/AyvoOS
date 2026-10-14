'use client';

import {
  API_BASE_PATH,
  CRATE_LABEL_SIZE_MM,
  crateLabelLayout,
  managedWorkstationSchema,
  type ManagedWorkstation,
} from '@ayvo/types';
import { useRouter } from 'next/navigation';
import { useId, useState } from 'react';
import { ConfirmDialog, ReasonField, reasonError, useAttempt } from '@/components/catalog/form-kit';
import { parseMm } from '@/components/crates/crate-form-kit';
import { buttonClass, inputClass } from '@/components/ui';
import { formatDateTimeCs } from '@/i18n/cs/format';
import { workstationsCs } from '@/i18n/cs/workstations';
import { apiSend } from '@/lib/client-api';
import { workstationErrorText } from './workstation-errors';

const t = workstationsCs.manage;

/** One station: state, who works there, (de)activation with reason, QR label download. */
export function WorkstationRow({
  station,
  timeZone,
}: {
  station: ManagedWorkstation;
  timeZone: string;
}) {
  const router = useRouter();
  const id = useId();
  const [dialog, setDialog] = useState(false);
  const [reason, setReason] = useState('');
  const [reasonErr, setReasonErr] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [width, setWidth] = useState('');
  const [height, setHeight] = useState('');
  const { busy, run } = useAttempt();
  const active = station.status === 'ACTIVE';

  async function confirm() {
    const r = reasonError(reason);
    setReasonErr(r);
    if (r) return;
    const action = active ? 'deactivate' : 'reactivate';
    const result = await run(`${action}:${reason.trim()}`, (requestId) =>
      apiSend('POST', `admin/workstations/${station.code}/${action}`, managedWorkstationSchema, {
        requestId,
        reason: reason.trim(),
      }),
    );
    setDialog(false);
    if (result.ok) {
      setError(null);
      router.refresh();
    } else if (result.error) setError(workstationErrorText(result.error));
  }

  const w = parseMm(width, CRATE_LABEL_SIZE_MM.min, CRATE_LABEL_SIZE_MM.max);
  const h = parseMm(height, CRATE_LABEL_SIZE_MM.min, CRATE_LABEL_SIZE_MM.max);
  const fits = w && h ? !!crateLabelLayout(w, h) : null;

  return (
    <li
      className="flex flex-col gap-3 border-t border-stone-100 py-4 first:border-t-0"
      data-testid={`workstation-${station.code}`}
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="font-medium wrap-anywhere">
            {station.name} <span className="font-mono text-xs text-stone-500">{station.code}</span>
          </p>
          <p className="text-sm text-stone-700">
            {workstationsCs.mode[station.mode]}
            {station.category ? ` · ${station.category.name}` : ''} · {t.warehouse}:{' '}
            {station.warehouse.name}
          </p>
          <p className="text-sm" data-testid="workstation-state">
            <span className={active ? 'text-emerald-800' : 'text-red-800'}>
              {workstationsCs.status[station.status]}
            </span>
            {' · '}
            {station.activeSession
              ? `${t.occupiedBy(station.activeSession.user)} (${formatDateTimeCs(station.activeSession.lastActivityAt, timeZone)}${station.activeSession.leaseExpired ? `, ${t.leaseExpired}` : ''})`
              : t.free}
          </p>
        </div>
        <button
          type="button"
          className={active ? buttonClass.danger : buttonClass.secondary}
          onClick={() => {
            setReason('');
            setReasonErr(null);
            setDialog(true);
          }}
        >
          {active ? t.deactivate : t.reactivate}
        </button>
      </div>
      <div className="flex flex-wrap items-end gap-2">
        <label className="flex flex-col gap-1 text-xs text-stone-500" htmlFor={`${id}-w`}>
          {t.width}
          <input
            id={`${id}-w`}
            inputMode="numeric"
            value={width}
            onChange={(e) => setWidth(e.target.value)}
            className={`${inputClass} w-24`}
          />
        </label>
        <label className="flex flex-col gap-1 text-xs text-stone-500" htmlFor={`${id}-h`}>
          {t.height}
          <input
            id={`${id}-h`}
            inputMode="numeric"
            value={height}
            onChange={(e) => setHeight(e.target.value)}
            className={`${inputClass} w-24`}
          />
        </label>
        {w && h && fits ? (
          <a
            href={`${API_BASE_PATH}/admin/workstations/${encodeURIComponent(station.code)}/qr-label?widthMm=${w}&heightMm=${h}`}
            className={buttonClass.secondary}
          >
            {t.download}
          </a>
        ) : (
          <span
            className={`${buttonClass.secondary} pointer-events-none opacity-50`}
            aria-disabled="true"
          >
            {t.download}
          </span>
        )}
      </div>
      {(width || height) && (!w || !h) && <p className="text-xs text-red-800">{t.sizeInvalid}</p>}
      {fits === false && <p className="text-xs text-red-800">{t.tooSmall}</p>}
      {error && (
        <p role="alert" className="text-sm text-red-800">
          {error}
        </p>
      )}
      <ConfirmDialog
        open={dialog}
        title={active ? t.deactivateTitle(station.code) : t.reactivateTitle(station.code)}
        confirmLabel={active ? t.deactivate : t.reactivate}
        danger={active}
        busy={busy}
        onConfirm={() => void confirm()}
        onCancel={() => setDialog(false)}
        testId="workstation-dialog"
      >
        {active && <p>{t.deactivateText}</p>}
        <ReasonField
          id={`${id}-reason`}
          value={reason}
          onChange={setReason}
          error={reasonErr}
          label={t.reason}
        />
      </ConfirmDialog>
    </li>
  );
}
