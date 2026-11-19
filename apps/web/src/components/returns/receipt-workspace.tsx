'use client';

import {
  returnBottleScanResultSchema,
  returnCrateScanResultSchema,
  returnIssueResultSchema,
  returnIssueSummarySchema,
  returnReceiptDetailSchema,
  type ReturnIssueSummary,
  type ReturnLineDetail,
  type ReturnReceiptDetail,
} from '@ayvo/types';
import { useRef, useState } from 'react';
import { Card, buttonClass, inputClass } from '@/components/ui';
import { formatDateTimeCs } from '@/i18n/cs/format';
import { returnsCs } from '@/i18n/cs/returns';
import { apiGet, apiSend } from '@/lib/client-api';
import { UnconfirmedScan, useScanField } from './scan-field';
import { errorText, isUncertain, useStableRequests } from './stable-requests';

const t = returnsCs;
type Message = { tone: 'ok' | 'error'; text: string } | null;
/** How an action ended: saved, refused (definite, nothing saved) or uncertain (maybe saved). */
export type RunResult = 'done' | 'refused' | 'uncertain';
type Run = (
  key: string,
  action: (requestId: string) => Promise<string | null>,
  /** Named in a refusal or an uncertain answer (e.g. the scanned code). */
  subject?: string,
) => Promise<RunResult>;

/**
 * Příjem vratek (doc 047 §4.9, R1.1 §6.3): scan a returned crate — it is freed at once, no bottle
 * confirmed; scan each really returned bottle on its own (good or defective), in any order and
 * independent of any crate; count unreadable pieces and defective pumps; close the receipt — no
 * physical count. An older line from before R1.1 keeps its Vyprázdněno. Resolve issues, also after
 * the close. Every action is one request with a stable id (a repeated attempt is the same request).
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
  // A large receipt: after each scan only the latest bottles of each line come back; the counts,
  // the lines and every issue are always complete and current (also another operator's scans).
  const [allBottles, setAllBottles] = useState(false);

  // A confirmed write and the refresh of the detail are separate: when only the refresh fails,
  // the write stays done and the page offers "Obnovit" (a GET only) — never the action again.
  const [stale, setStale] = useState(false);
  // Refreshes can overlap (a repeated "Obnovit"). Only the latest one started may change the
  // screen: an older answer that arrives later (an earlier read, maybe another view) is dropped.
  const latestRefresh = useRef(0);
  const refresh = async (all = allBottles) => {
    const mine = ++latestRefresh.current;
    try {
      const next = await apiGet(
        `${base}?bottles=${all ? 'all' : 'recent'}`,
        returnReceiptDetailSchema,
      );
      if (mine !== latestRefresh.current) return;
      setReceipt(next);
      setStale(false);
    } catch {
      if (mine === latestRefresh.current) setStale(true);
    }
  };
  const showAll = async () => {
    setBusy(true);
    try {
      setAllBottles(true);
      await refresh(true);
    } finally {
      setBusy(false);
    }
  };
  const run: Run = async (key, action, subject) => {
    setBusy(true);
    try {
      let text: string | null;
      try {
        text = await send(key, action);
      } catch (err) {
        const reason = errorText(err);
        setMessage({ tone: 'error', text: subject ? `${subject}: ${reason}` : reason });
        return isUncertain(err) ? 'uncertain' : 'refused';
      }
      setMessage({ tone: 'ok', text: text ?? t.saved });
      await refresh();
      return 'done';
    } finally {
      setBusy(false);
    }
  };
  const locked = busy || stale;

  const crateField = useScanField<{ scanned: string }>();
  const sendCrate = ({ scanned }: { scanned: string }) =>
    run(
      `crate:${scanned}`,
      async (requestId) => {
        const r = await apiSend('POST', `${base}/crates`, returnCrateScanResultSchema, {
          requestId,
          scannedValue: scanned,
        });
        return r.outcome === 'CRATE_RETURNED'
          ? t.result.crate(r.crateCode, r.orderCode, r.freed)
          : t.result.crateAgain(r.crateCode);
      },
      scanned,
    );
  // The BOTTLES line is never emptied (R1.1); only an older crate or box line waits for it.
  const allEmptied = receipt.lineDetails.every((l) => l.kind === 'BOTTLES' || l.emptiedAt);
  const lines = [...receipt.lineDetails].sort(
    (a, b) => Number(b.kind === 'BOTTLES') - Number(a.kind === 'BOTTLES'),
  );

  return (
    <div className="flex flex-col gap-6" data-testid="return-receipt">
      <Card>
        <div className="flex flex-wrap items-center justify-between gap-3 text-sm">
          <span data-testid="receipt-state">
            {t.state[receipt.state]} · {formatDateTimeCs(receipt.openedAt)}
          </span>
          <span data-testid="pump-count">{t.receipt.pumpsCount(receipt.defectivePumps)}</span>
        </div>
        <p className="mt-2 text-sm font-medium" data-testid="receipt-counts">
          {t.receipt.counts(
            receipt.counts.crates,
            receipt.counts.identified,
            receipt.counts.defective,
            receipt.counts.unreadable,
          )}
        </p>
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
              onClick={() => refresh()}
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
          <p className="mb-3 text-sm text-stone-600">{t.receipt.scanCrateHint}</p>
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
          </form>
          {crateField.unconfirmed && (
            <div className="mt-3">
              <UnconfirmedScan
                label={crateField.unconfirmed.scanned}
                held={crateField.held}
                busy={locked}
                onRetry={() => crateField.retry(sendCrate)}
                onDismiss={crateField.dismiss}
              />
            </div>
          )}
        </Card>
      )}

      {open && (
        <BottleScanCard
          base={base}
          busy={locked}
          run={run}
          unreadableKey={`unreadable:${receipt.counts.unreadable}`}
        />
      )}

      {lines.map((line, index) => (
        <LineCard
          key={line.id}
          line={line}
          index={index}
          open={open}
          busy={locked}
          base={base}
          run={run}
          canCorrect={canCorrect}
          onShowAll={showAll}
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

/** The bottle scan of the whole receipt (R1.1): no crate scan or choice is needed. */
function BottleScanCard({
  base,
  busy,
  run,
  unreadableKey,
}: {
  base: string;
  busy: boolean;
  run: Run;
  unreadableKey: string;
}) {
  const field = useScanField<{ scanned: string; outcome: 'GOOD' | 'DEFECTIVE' }>();
  const [outcome, setOutcome] = useState<'GOOD' | 'DEFECTIVE'>('GOOD');
  const sendBottle = (a: { scanned: string; outcome: 'GOOD' | 'DEFECTIVE' }) =>
    run(
      `bottle:${a.scanned}:${a.outcome}`,
      async (requestId) => {
        const r = await apiSend('POST', `${base}/bottles`, returnBottleScanResultSchema, {
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
      },
      a.scanned,
    );
  return (
    <Card title={t.receipt.scanBottles} testId="return-bottle-scan">
      <p className="mb-3 text-sm text-stone-600">{t.receipt.scanBottlesHint}</p>
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
          aria-label={t.line.scanBottle}
          autoComplete="off"
          name="bottle"
        />
        <fieldset className="flex flex-wrap gap-4">
          {(['GOOD', 'DEFECTIVE'] as const).map((o) => (
            <label key={o} className="flex items-center gap-2">
              <input
                type="radio"
                name="outcome"
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
              run(unreadableKey, async (requestId) => {
                const r = await apiSend('POST', `${base}/unreadable`, returnIssueResultSchema, {
                  requestId,
                });
                return t.result.issue(t.issue.kind.UNREADABLE!, r.issue.code);
              })
            }
          >
            {t.line.unreadable}
          </button>
        </div>
        {field.unconfirmed && (
          <UnconfirmedScan
            label={`${field.unconfirmed.scanned} · ${t.line[field.unconfirmed.outcome === 'GOOD' ? 'good' : 'defective']}`}
            held={field.held}
            busy={busy}
            onRetry={() => field.retry(sendBottle)}
            onDismiss={field.dismiss}
          />
        )}
      </form>
    </Card>
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
  onShowAll,
}: {
  line: ReturnLineDetail;
  index: number;
  open: boolean;
  busy: boolean;
  base: string;
  run: Run;
  canCorrect: boolean;
  onShowAll: () => void;
}) {
  const [count, setCount] = useState('');
  // Only an older crate or box line (from before R1.1) still waits for Vyprázdněno.
  const legacy = open && line.kind !== 'BOTTLES' && !line.emptiedAt;
  const title =
    line.kind === 'BOTTLES'
      ? t.line.bottlesTitle
      : line.crateCode
        ? t.line.crate(line.crateCode)
        : `${t.line.container} ${index + 1}`;
  const path = `${base}/lines/${line.id}`;

  return (
    <Card
      title={title}
      testId={`return-line-${line.kind === 'BOTTLES' ? 'bottles' : (line.crateCode ?? `box-${index + 1}`)}`}
    >
      <div className="flex flex-col gap-4 text-sm">
        {line.orderCode && (
          <p className="text-stone-600">{t.line.order(line.orderCode, line.hotelName)}</p>
        )}
        {line.kind === 'CRATE' && line.emptiedAt && line.physicalCount === null && (
          <p className="font-medium" data-testid="line-freed">
            {t.line.freed(line.freedWithCrate ?? 0)}
          </p>
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
        {line.kind !== 'CRATE' || line.physicalCount !== null || line.bottles.length > 0 ? (
          <p className="font-medium" data-testid="line-recorded">
            {line.emptiedAt && line.physicalCount !== null
              ? t.line.emptied(line.physicalCount) + ' · '
              : ''}
            {t.line.recorded(line.recordedCount)}
          </p>
        ) : null}

        {legacy && (
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
            <p className="text-stone-600 sm:basis-full">{t.line.legacy}</p>
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

        {(line.kind === 'BOTTLES' || line.bottles.length > 0) && (
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
            {line.bottleCount > line.bottles.length && (
              <div className="mt-2 flex flex-wrap items-center gap-3 text-stone-500">
                <span data-testid="line-bottles-recent">
                  {t.line.recentBottles(line.bottles.length, line.bottleCount)}
                </span>
                <button
                  type="button"
                  className={buttonClass.secondary}
                  disabled={busy}
                  onClick={onShowAll}
                >
                  {t.line.allBottles(line.bottleCount)}
                </button>
              </div>
            )}
          </div>
        )}

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
    run(
      `identify:${issue.code}:${a.scanned}:${a.outcome}`,
      async (requestId) => {
        const r = await apiSend('POST', `${path}/identify`, returnBottleScanResultSchema, {
          requestId,
          scannedValue: a.scanned,
          outcome: a.outcome,
        });
        return t.result.identified(r.bottleCode!, t.outcome[r.result!] ?? '');
      },
      a.scanned,
    );
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
      {identifiable && field.unconfirmed && (
        <div className="mt-2">
          <UnconfirmedScan
            label={`${field.unconfirmed.scanned} · ${t.line[field.unconfirmed.outcome === 'GOOD' ? 'good' : 'defective']}`}
            held={field.held}
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
