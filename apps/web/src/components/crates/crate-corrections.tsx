'use client';

import { cycleCorrectionResultSchema, type CrateCycleStatus } from '@ayvo/types';
import { useRouter } from 'next/navigation';
import { useId, useState } from 'react';
import { ConfirmDialog, ReasonField, reasonError, useAttempt } from '@/components/catalog/form-kit';
import { buttonClass, Card, inputClass } from '@/components/ui';
import { crateCorrectionsCs } from '@/i18n/cs/filling';
import { labelingCs } from '@/i18n/cs/labeling';
import { apiSend, ClientApiError } from '@/lib/client-api';

const t = crateCorrectionsCs;
type Action = 'remove-bottle' | 'add-bottle' | 'reopen' | 'abort-cycle';

function errorText(error: unknown): string {
  if (error instanceof ClientApiError) {
    if (error.code && t.errors[error.code]) return t.errors[error.code]!;
    if (error.status === 404) return t.errors.NOT_FOUND!;
    if (error.status === 403) return t.errors.FORBIDDEN!;
    if (error.status < 500) return labelingCs.failed;
  }
  return labelingCs.network;
}

/**
 * Supervised corrections of one crate (doc 025 §4.2; `production:cycle_correct`): Vyjmout and
 * Doplnit / přeložit lahev (scanned QR or code), Vrátit do rozpracování, Zrušit oběh — each with a
 * reason. One attempt keeps its request id until a definite answer, so a retry after a lost
 * response never repeats the correction. The page reloads the server state afterwards.
 */
export function CrateCorrections({
  crateCode,
  status,
}: {
  crateCode: string;
  status: CrateCycleStatus | null;
}) {
  const id = useId();
  const router = useRouter();
  const [bottle, setBottle] = useState('');
  const [reason, setReason] = useState('');
  const [reasonErr, setReasonErr] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<'reopen-confirm' | 'abort-confirm' | null>(null);
  const [notice, setNotice] = useState<{ tone: 'ok' | 'error'; text: string } | null>(null);
  const { busy, run } = useAttempt();

  async function act(action: Action) {
    const err = reasonError(reason);
    setReasonErr(err);
    if (err) return;
    const body: Record<string, string> = { reason: reason.trim() };
    if (action === 'remove-bottle' || action === 'add-bottle') {
      if (!bottle.trim()) return;
      body.bottle = bottle.trim();
    }
    const res = await run(`${action}:${JSON.stringify(body)}`, (requestId) =>
      apiSend('POST', `admin/crates/${crateCode}/${action}`, cycleCorrectionResultSchema, {
        requestId,
        ...body,
      }),
    );
    setConfirm(null);
    if (!res.ok) {
      if (res.error) setNotice({ tone: 'error', text: errorText(res.error) });
      return;
    }
    const done =
      action === 'remove-bottle'
        ? t.done.remove(body.bottle!)
        : action === 'add-bottle'
          ? t.done.add(body.bottle!)
          : action === 'reopen'
            ? t.done.reopen
            : t.done.abort;
    setNotice({ tone: 'ok', text: done });
    setBottle('');
    setReason('');
    router.refresh();
  }

  return (
    <Card title={t.title} testId="crate-corrections" className="border-l-4 border-l-amber-400">
      <div className="flex flex-col gap-3">
        <p className="text-xs text-stone-500">{t.help}</p>
        <label className="flex flex-col gap-1 text-sm" htmlFor={`${id}-bottle`}>
          {t.bottle}
          <input
            id={`${id}-bottle`}
            value={bottle}
            onChange={(e) => setBottle(e.target.value)}
            autoComplete="off"
            spellCheck={false}
            className={inputClass}
          />
        </label>
        <ReasonField
          id={`${id}-reason`}
          value={reason}
          onChange={setReason}
          error={reasonErr}
          label={t.reason}
        />
        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            className={buttonClass.secondary}
            disabled={busy || !bottle.trim() || status === 'FILLED' || status === null}
            onClick={() => void act('remove-bottle')}
          >
            {t.remove}
          </button>
          <button
            type="button"
            className={buttonClass.secondary}
            disabled={busy || !bottle.trim() || status === 'FILLED'}
            onClick={() => void act('add-bottle')}
          >
            {t.add}
          </button>
          {status === 'FILLED' && (
            <button
              type="button"
              className={buttonClass.secondary}
              disabled={busy}
              onClick={() => setConfirm('reopen-confirm')}
            >
              {t.reopen}
            </button>
          )}
          {status !== null && status !== 'FILLED' && (
            <button
              type="button"
              className={buttonClass.danger}
              disabled={busy}
              onClick={() => setConfirm('abort-confirm')}
            >
              {t.abort}
            </button>
          )}
        </div>
        {notice && (
          <p
            role={notice.tone === 'error' ? 'alert' : 'status'}
            data-testid="correction-notice"
            className={
              notice.tone === 'ok'
                ? 'rounded-md border border-emerald-300 bg-emerald-50 p-3 text-sm text-emerald-950'
                : 'rounded-md border border-red-300 bg-red-50 p-3 text-sm text-red-900'
            }
          >
            {notice.text}
          </p>
        )}
      </div>
      <ConfirmDialog
        open={confirm === 'abort-confirm'}
        title={t.abortTitle}
        confirmLabel={t.abort}
        danger
        busy={busy}
        onConfirm={() => void act('abort-cycle')}
        onCancel={() => setConfirm(null)}
        testId="abort-dialog"
      >
        {t.abortText}
      </ConfirmDialog>
      <ConfirmDialog
        open={confirm === 'reopen-confirm'}
        title={t.reopenTitle}
        confirmLabel={t.reopen}
        busy={busy}
        onConfirm={() => void act('reopen')}
        onCancel={() => setConfirm(null)}
        testId="reopen-dialog"
      >
        {t.reopenText}
      </ConfirmDialog>
    </Card>
  );
}
