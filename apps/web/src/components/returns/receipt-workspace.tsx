'use client';

import {
  returnBottleScanResultSchema,
  returnCrateScanResultSchema,
  returnIssueResultSchema,
  returnIssueSummarySchema,
  returnLineResultSchema,
  returnReceiptDetailSchema,
  type ReturnIssueSummary,
  type ReturnLineDetail,
  type ReturnReceiptDetail,
} from '@ayvo/types';
import { useState } from 'react';
import { Card, buttonClass, inputClass } from '@/components/ui';
import { formatDateTimeCs } from '@/i18n/cs/format';
import { returnsCs } from '@/i18n/cs/returns';
import { apiGet, apiSend } from '@/lib/client-api';
import { FailedScan, useScanField } from './scan-field';
import { errorText, useStableRequests } from './stable-requests';

const t = returnsCs;
type Message = { tone: 'ok' | 'error'; text: string } | null;
type Run = (key: string, action: (requestId: string) => Promise<string | null>) => Promise<boolean>;

/**
 * Příjem vratek (doc 047 §4.9): scan a returned crate or add a box, scan each bottle (good or
 * defective), count unreadable pieces and defective pumps, enter the physical count and empty
 * each container, close the receipt; resolve issues, also after the close. Every action is one
 * request with a stable id (a repeated attempt is the same request).
 */
export function ReceiptWorkspace({
  initial,
  canCorrect,
}: {
  initial: ReturnReceiptDetail;
  canCorrect: boolean;
}) {
  const [receipt, setReceipt] = useState(initial);
  const [message, setMessage] = useState<Message>(null);
  const [busy, setBusy] = useState(false);
  const send = useStableRequests();
  const open = receipt.state === 'OPEN';
  const base = `admin/returns/receipts/${receipt.code}`;

  // A confirmed write and the refresh of the detail are separate: when only the refresh fails,
  // the write stays done and the page offers "Obnovit" (a GET only) — never the action again.
  const [stale, setStale] = useState(false);
  const refresh = async () => {
    try {
      setReceipt(await apiGet(base, returnReceiptDetailSchema));
      setStale(false);
    } catch {
      setStale(true);
    }
  };
  const run: Run = async (key, action) => {
    setBusy(true);
    try {
      let text: string | null;
      try {
        text = await send(key, action);
      } catch (err) {
        setMessage({ tone: 'error', text: errorText(err) });
        return false;
      }
      setMessage({ tone: 'ok', text: text ?? t.saved });
      await refresh();
      return true;
    } finally {
      setBusy(false);
    }
  };
  const locked = busy || stale;

  const crateField = useScanField<{ scanned: string }>();
  const sendCrate = ({ scanned }: { scanned: string }) =>
    run(`crate:${scanned}`, async (requestId) => {
      const r = await apiSend('POST', `${base}/crates`, returnCrateScanResultSchema, {
        requestId,
        scannedValue: scanned,
      });
      return r.outcome === 'CRATE_RETURNED'
        ? t.result.crate(r.crateCode, r.orderCode)
        : t.result.crateAgain(r.crateCode);
    });
  const allEmptied = receipt.lineDetails.every((l) => l.emptiedAt);

  return (
    <div className="flex flex-col gap-6" data-testid="return-receipt">
      <Card>
        <div className="flex flex-wrap items-center justify-between gap-3 text-sm">
          <span data-testid="receipt-state">
            {t.state[receipt.state]} · {formatDateTimeCs(receipt.openedAt)}
          </span>
          <span data-testid="pump-count">{t.receipt.pumpsCount(receipt.defectivePumps)}</span>
        </div>
        {!open && <p className="mt-2 text-sm text-stone-600">{t.receipt.closed}</p>}
        {stale && (
          <div
            role="alert"
            data-testid="refresh-failed"
            className="mt-3 flex flex-col gap-2 text-sm text-amber-900 sm:flex-row sm:items-center sm:justify-between"
          >
            <span>{t.refreshFailed}</span>
            <button
              type="button"
              className={buttonClass.secondary}
              disabled={busy}
              onClick={refresh}
            >
              {t.refresh}
            </button>
          </div>
        )}
        {message && (
          <p
            role={message.tone === 'error' ? 'alert' : 'status'}
            data-testid="return-message"
            className={`mt-3 text-sm ${message.tone === 'error' ? 'text-red-700' : 'text-emerald-800'}`}
          >
            {message.text}
          </p>
        )}
      </Card>

      {open && (
        <Card title={t.receipt.scanCrate}>
          <form
            className="flex flex-col gap-3 sm:flex-row"
            onSubmit={async (e) => {
              e.preventDefault();
              const scanned = crateField.value.trim();
              if (!scanned) return;
              await crateField.submit({ scanned }, sendCrate);
            }}
          >
            <input
              className={inputClass}
              value={crateField.value}
              onChange={(e) => crateField.setValue(e.target.value)}
              placeholder={t.receipt.scanCratePlaceholder}
              aria-label={t.receipt.scanCrate}
              autoComplete="off"
              name="crate"
            />
            <button type="submit" className={buttonClass.primary} disabled={locked}>
              {t.receipt.addCrate}
            </button>
            <button
              type="button"
              className={buttonClass.secondary}
              disabled={locked}
              onClick={() =>
                run(`container:${receipt.lineDetails.length}`, async (requestId) => {
                  await apiSend('POST', `${base}/containers`, returnLineResultSchema, {
                    requestId,
                  });
                  return null;
                })
              }
            >
              {t.receipt.addContainer}
            </button>
          </form>
          {crateField.failed && (
            <div className="mt-3">
              <FailedScan
                scanned={crateField.failed.scanned}
                busy={locked}
                onRetry={() => crateField.retry(sendCrate)}
                onDismiss={crateField.dismiss}
              />
            </div>
          )}
        </Card>
      )}

      {receipt.lineDetails.map((line, index) => (
        <LineCard
          key={line.id}
          line={line}
          index={index}
          open={open}
          busy={locked}
          base={base}
          run={run}
          canCorrect={canCorrect}
        />
      ))}

      {open && (
        <Card>
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <button
              type="button"
              className={buttonClass.secondary}
              disabled={locked}
              onClick={() =>
                run(`pump:${receipt.defectivePumps}`, async (requestId) => {
                  await apiSend('POST', `${base}/pumps`, returnReceiptDetailSchema, {
                    requestId,
                    defective: 1,
                    reason: null,
                  });
                  return null;
                })
              }
            >
              {t.receipt.pumps}
            </button>
            <div className="flex flex-col items-start gap-1 sm:items-end">
              <button
                type="button"
                className={buttonClass.primary}
                disabled={locked || !allEmptied}
                onClick={() =>
                  run('close', async (requestId) => {
                    await apiSend('POST', `${base}/close`, returnReceiptDetailSchema, {
                      requestId,
                    });
                    return null;
                  })
                }
              >
                {t.receipt.close}
              </button>
              {!allEmptied && <span className="text-xs text-stone-500">{t.receipt.closeHint}</span>}
            </div>
          </div>
        </Card>
      )}
    </div>
  );
}

function LineCard({
  line,
  index,
  open,
  busy,
  base,
  run,
  canCorrect,
}: {
  line: ReturnLineDetail;
  index: number;
  open: boolean;
  busy: boolean;
  base: string;
  run: Run;
  canCorrect: boolean;
}) {
  const field = useScanField<{ scanned: string; outcome: 'GOOD' | 'DEFECTIVE' }>();
  const [outcome, setOutcome] = useState<'GOOD' | 'DEFECTIVE'>('GOOD');
  const [count, setCount] = useState('');
  const active = open && !line.emptiedAt;
  const title = line.crateCode ? t.line.crate(line.crateCode) : `${t.line.container} ${index + 1}`;
  const path = `${base}/lines/${line.id}`;
  const sendBottle = (a: { scanned: string; outcome: 'GOOD' | 'DEFECTIVE' }) =>
    run(`bottle:${line.id}:${a.scanned}:${a.outcome}`, async (requestId) => {
      const r = await apiSend('POST', `${path}/bottles`, returnBottleScanResultSchema, {
        requestId,
        scannedValue: a.scanned,
        outcome: a.outcome,
      });
      if (r.outcome === 'ISSUE_RECORDED') {
        return t.result.issue(t.issue.kind[r.issue!.kind] ?? r.issue!.kind, r.issue!.code);
      }
      return r.repeated
        ? t.result.repeated(r.bottleCode!)
        : t.result.identified(r.bottleCode!, t.outcome[r.result!] ?? r.result!);
    });

  return (
    <Card title={title} testId={`return-line-${line.crateCode ?? `box-${index + 1}`}`}>
      <div className="flex flex-col gap-4 text-sm">
        {line.orderCode && (
          <p className="text-stone-600">{t.line.order(line.orderCode, line.hotelName)}</p>
        )}
        {line.history && (
          <p className="text-stone-500" data-testid="line-history">
            {t.line.history(
              line.history.shipped,
              line.history.identified,
              line.history.withoutConfirmedReturn,
            )}
          </p>
        )}
        <p className="font-medium" data-testid="line-recorded">
          {line.emptiedAt ? t.line.emptied(line.physicalCount ?? 0) + ' · ' : ''}
          {t.line.recorded(line.recordedCount)}
        </p>

        {active && (
          <form
            className="flex flex-col gap-3"
            onSubmit={async (e) => {
              e.preventDefault();
              const scanned = field.value.trim();
              if (!scanned) return;
              await field.submit({ scanned, outcome }, sendBottle);
            }}
          >
            <input
              className={inputClass}
              value={field.value}
              onChange={(e) => field.setValue(e.target.value)}
              placeholder={t.line.scanBottlePlaceholder}
              aria-label={`${t.line.scanBottle} – ${title}`}
              autoComplete="off"
              name="bottle"
            />
            <fieldset className="flex flex-wrap gap-4">
              {(['GOOD', 'DEFECTIVE'] as const).map((o) => (
                <label key={o} className="flex items-center gap-2">
                  <input
                    type="radio"
                    name={`outcome-${line.id}`}
                    checked={outcome === o}
                    onChange={() => setOutcome(o)}
                  />
                  {o === 'GOOD' ? t.line.good : t.line.defective}
                </label>
              ))}
            </fieldset>
            <div className="flex flex-wrap gap-2">
              <button type="submit" className={buttonClass.primary} disabled={busy}>
                {t.line.submitBottle}
              </button>
              <button
                type="button"
                className={buttonClass.secondary}
                disabled={busy}
                onClick={() =>
                  run(`unreadable:${line.id}:${line.recordedCount}`, async (requestId) => {
                    const r = await apiSend('POST', `${path}/unreadable`, returnIssueResultSchema, {
                      requestId,
                    });
                    return t.result.issue(t.issue.kind.UNREADABLE!, r.issue.code);
                  })
                }
              >
                {t.line.unreadable}
              </button>
            </div>
            {field.failed && (
              <FailedScan
                scanned={field.failed.scanned}
                busy={busy}
                onRetry={() => field.retry(sendBottle)}
                onDismiss={field.dismiss}
              />
            )}
          </form>
        )}

        {active && (
          <form
            className="flex flex-col gap-2 sm:flex-row sm:items-end"
            onSubmit={async (e) => {
              e.preventDefault();
              const n = Number(count);
              if (count === '' || !Number.isInteger(n) || n < 0) return;
              await run(`empty:${line.id}:${n}`, async (requestId) => {
                await apiSend('POST', `${path}/empty`, returnReceiptDetailSchema, {
                  requestId,
                  physicalCount: n,
                });
                return null;
              });
            }}
          >
            <label className="flex flex-col gap-1">
              <span className="text-stone-700">{t.line.physical}</span>
              <input
                className={inputClass}
                inputMode="numeric"
                value={count}
                onChange={(e) => setCount(e.target.value.replace(/[^0-9]/g, ''))}
                name="physicalCount"
              />
            </label>
            <button type="submit" className={buttonClass.secondary} disabled={busy || count === ''}>
              {t.line.empty}
            </button>
          </form>
        )}

        <div>
          <h3 className="mb-1 font-medium text-stone-700">{t.line.bottles}</h3>
          {line.bottles.length === 0 ? (
            <p className="text-stone-500">{t.line.noBottles}</p>
          ) : (
            <ul className="flex flex-col gap-1" data-testid="line-bottles">
              {line.bottles.map((b) => (
                <li key={b.bottleCode + b.at} className="flex flex-wrap justify-between gap-2">
                  <span>
                    <span className="font-medium">{b.bottleCode}</span> · {t.outcome[b.outcome]}
                  </span>
                  <span className="text-stone-500">
                    {t.line.fromCrate(b.crateCode, b.orderCode)}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>

        {line.issues.length > 0 && (
          <ul className="flex flex-col gap-3" data-testid="line-issues">
            {line.issues.map((issue) => (
              <IssueRow
                key={issue.code}
                issue={issue}
                busy={busy}
                run={run}
                canCorrect={canCorrect}
              />
            ))}
          </ul>
        )}
      </div>
    </Card>
  );
}

function IssueRow({
  issue,
  busy,
  run,
  canCorrect,
}: {
  issue: ReturnIssueSummary;
  busy: boolean;
  run: Run;
  canCorrect: boolean;
}) {
  const field = useScanField<{ scanned: string; outcome: 'GOOD' | 'DEFECTIVE' }>();
  const [outcome, setOutcome] = useState<'GOOD' | 'DEFECTIVE'>('GOOD');
  const [reason, setReason] = useState('');
  const path = `admin/returns/issues/${issue.code}`;
  const sendIdentify = (a: { scanned: string; outcome: 'GOOD' | 'DEFECTIVE' }) =>
    run(`identify:${issue.code}:${a.scanned}:${a.outcome}`, async (requestId) => {
      const r = await apiSend('POST', `${path}/identify`, returnBottleScanResultSchema, {
        requestId,
        scannedValue: a.scanned,
        outcome: a.outcome,
      });
      return t.result.identified(r.bottleCode!, t.outcome[r.result!] ?? '');
    });
  const mismatch = issue.kind === 'COUNT_MISMATCH';
  const identifiable =
    !issue.resolution && ['UNREADABLE', 'NOT_DELIVERED', 'NOT_IN_CIRCULATION'].includes(issue.kind);
  const closable = !issue.resolution && !mismatch && canCorrect;
  const details = issue.details as { physical?: number; recorded?: number };

  return (
    <li
      className="rounded-md border border-amber-200 bg-amber-50 p-3"
      data-testid={`issue-${issue.code}`}
    >
      <p>
        <span className="font-medium">{issue.code}</span> · {t.issue.kind[issue.kind]}
        {issue.bottleCode ? ` · ${issue.bottleCode}` : ''}
        {mismatch && details.physical !== undefined
          ? ` · ${t.issue.mismatch(details.physical, details.recorded ?? 0)}`
          : ''}
        {issue.resolution ? ` · ${t.issue.resolution[issue.resolution]}` : ''}
        {issue.resolutionReason ? ` (${issue.resolutionReason})` : ''}
      </p>
      {identifiable && (
        <form
          className="mt-2 flex flex-col gap-2 sm:flex-row"
          onSubmit={async (e) => {
            e.preventDefault();
            const scanned = field.value.trim();
            if (!scanned) return;
            await field.submit({ scanned, outcome }, sendIdentify);
          }}
        >
          <input
            className={inputClass}
            value={field.value}
            onChange={(e) => field.setValue(e.target.value)}
            placeholder={t.line.scanBottlePlaceholder}
            aria-label={`${t.issue.identify} ${issue.code}`}
            autoComplete="off"
          />
          <fieldset className="flex flex-wrap items-center gap-4">
            {(['GOOD', 'DEFECTIVE'] as const).map((o) => (
              <label key={o} className="flex items-center gap-2">
                <input
                  type="radio"
                  name={`issue-outcome-${issue.code}`}
                  checked={outcome === o}
                  onChange={() => setOutcome(o)}
                />
                {o === 'GOOD' ? t.line.good : t.line.defective}
              </label>
            ))}
          </fieldset>
          <button type="submit" className={buttonClass.secondary} disabled={busy}>
            {t.issue.identifySubmit}
          </button>
        </form>
      )}
      {identifiable && field.failed && (
        <div className="mt-2">
          <FailedScan
            scanned={field.failed.scanned}
            busy={busy}
            onRetry={() => field.retry(sendIdentify)}
            onDismiss={field.dismiss}
          />
        </div>
      )}
      {closable && (
        <form className="mt-2 flex flex-col gap-2 sm:flex-row" onSubmit={(e) => e.preventDefault()}>
          <input
            className={inputClass}
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder={t.issue.reason}
            aria-label={`${t.issue.reason} ${issue.code}`}
          />
          {(issue.kind === 'OTHER_SITE'
            ? (['WRITTEN_OFF'] as const)
            : (['NOT_AYVO', 'WRITTEN_OFF'] as const)
          ).map((resolution) => (
            <button
              key={resolution}
              type="button"
              className={buttonClass.secondary}
              disabled={busy || reason.trim().length < 3}
              onClick={() =>
                run(`closeout:${issue.code}:${resolution}:${reason.trim()}`, async (requestId) => {
                  await apiSend('POST', `${path}/close-out`, returnIssueSummarySchema, {
                    requestId,
                    resolution,
                    reason: reason.trim(),
                  });
                  return null;
                })
              }
            >
              {resolution === 'NOT_AYVO' ? t.issue.notAyvo : t.issue.writtenOff}
            </button>
          ))}
        </form>
      )}
    </li>
  );
}
