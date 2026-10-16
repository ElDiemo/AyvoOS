'use client';

import {
  currentStationSessionSchema,
  stationInUseSchema,
  stationSessionResultSchema,
  stationSessionSchema,
  type CurrentStationSession,
  type StationInUse,
} from '@ayvo/types';
import { useEffect, useId, useRef, useState } from 'react';
import { z } from 'zod';
import { ConfirmDialog, ReasonField, reasonError } from '@/components/catalog/form-kit';
import { buttonClass, Card, inputClass } from '@/components/ui';
import { formatDateTimeCs } from '@/i18n/cs/format';
import { workstationsCs } from '@/i18n/cs/workstations';
import { apiGet, apiSend, ClientApiError } from '@/lib/client-api';
import { scanFeedback } from '@/lib/scan-feedback';
import { FillingWorkspace } from './filling-workspace';
import { LabelingWorkspace } from './labeling-workspace';

const t = workstationsCs.station;
const HEARTBEAT_MS = 60_000;
const elsewhereSchema = z.object({ station: z.object({ code: z.string(), name: z.string() }) });
const releasedSchema = z.object({ status: z.literal('RELEASED') });

type Notice = { tone: 'ok' | 'error' | 'info'; text: string; retry?: () => void } | null;

/** No definite answer: a network error or a 5xx (the server may have committed). */
const uncertain = (error: unknown) => !(error instanceof ClientApiError) || error.status >= 500;

function errorText(error: unknown): string {
  if (error instanceof ClientApiError) {
    if (error.code && workstationsCs.errors[error.code]) return workstationsCs.errors[error.code]!;
    if (error.status === 403) return workstationsCs.errors.FORBIDDEN!;
    if (error.status === 400 || error.status === 422) return workstationsCs.invalid;
    if (error.status < 500) return workstationsCs.failed;
  }
  return workstationsCs.network;
}

/**
 * Výroba → Pracoviště (doc 026): scan the station QR once; the station, its mode/category and the
 * site stay visible in a permanent banner. Leaving hands the station over (no supervisor); a
 * station in use names its holder, and only a user with `production:session_takeover` may take
 * it over with a reason. The server re-validates the stored station on every request.
 *
 * Uncertain answers (lost response, 5xx): the attempt keeps its request id, so a retry continues
 * the SAME server operation (replayed by the server); the page first asks the server for the
 * real state and reports success only when the server confirms it. A late heartbeat answer of an
 * older session never overwrites a newer one; a session the user may no longer work at is shown
 * only as "blocked", with a safe way to leave it.
 */
export function StationPanel({
  initial,
  canTakeover,
  timeZone,
}: {
  initial: CurrentStationSession;
  canTakeover: boolean;
  timeZone: string;
}) {
  const id = useId();
  const [current, setCurrent] = useState(initial.current);
  const [blocked, setBlocked] = useState(initial.blocked);
  const [ended, setEnded] = useState(initial.endedByOther);
  const [notice, setNotice] = useState<Notice>(null);
  const [inUse, setInUse] = useState<StationInUse | null>(null);
  const [value, setValue] = useState('');
  const [busy, setBusy] = useState(false);
  const [dialog, setDialog] = useState(false);
  /** Labelling scans waiting or uncertain: the station cannot be left until they are resolved. */
  const [unresolved, setUnresolved] = useState(false);
  const [reason, setReason] = useState('');
  const [reasonErr, setReasonErr] = useState<string | null>(null);
  const input = useRef<HTMLInputElement>(null);
  const attempts = useRef(new Map<string, string>());
  const currentId = useRef<string | null>(initial.current?.session.id ?? null);

  useEffect(() => {
    currentId.current = current?.session.id ?? null;
  }, [current]);

  /** One user attempt = one request id, kept while its answer is uncertain. */
  const attemptId = (key: string) => {
    const existing = attempts.current.get(key);
    if (existing) return existing;
    const fresh = crypto.randomUUID();
    attempts.current.set(key, fresh);
    return fresh;
  };

  /** The server's truth (after an uncertain answer or a refusal of the old session). */
  async function reconcile() {
    const fresh = await apiGet('admin/station-sessions/current', currentStationSessionSchema).catch(
      () => null,
    );
    if (fresh) {
      setCurrent(fresh.current);
      setBlocked(fresh.blocked);
      setEnded(fresh.endedByOther);
    }
    return fresh;
  }

  // The scanner types into whatever has focus: keep the field focused whenever it is usable,
  // after the render that enables it (never in an animation frame).
  useEffect(() => {
    if (!current && !busy && !dialog) input.current?.focus();
  }, [current, busy, dialog, notice]);

  // Heartbeat: keeps the lease and detects a takeover, deactivation or lost access.
  useEffect(() => {
    if (!current) return;
    const sessionId = current.session.id;
    const timer = setInterval(() => {
      apiSend('POST', `admin/station-sessions/${sessionId}/heartbeat`, stationSessionSchema)
        .then((session) =>
          setCurrent((c) => (c && c.session.id === session.id ? { ...c, session } : c)),
        )
        .catch(async (error: unknown) => {
          if (
            error instanceof ClientApiError &&
            error.status < 500 &&
            currentId.current === sessionId
          ) {
            await reconcile();
            setNotice({ tone: 'error', text: t.lostSession });
            scanFeedback('error');
          }
        });
    }, HEARTBEAT_MS);
    return () => clearInterval(timer);
  }, [current]);

  async function scan(raw: string) {
    if (busy || raw.trim() === '') return;
    const key = `open:${raw.trim()}`;
    setBusy(true);
    setInUse(null);
    setEnded(null);
    try {
      const result = await apiSend('POST', 'admin/station-sessions', stationSessionResultSchema, {
        requestId: attemptId(key),
        scannedValue: raw,
      });
      attempts.current.delete(key);
      setCurrent({ session: result.session, station: result.station });
      setBlocked(null);
      setNotice({
        tone: 'ok',
        text:
          result.outcome === 'RESUMED'
            ? t.resumed(result.station.name)
            : t.opened(result.station.name),
      });
      scanFeedback('ok');
    } catch (error) {
      if (uncertain(error)) {
        const fresh = await reconcile();
        if (fresh?.current) {
          attempts.current.delete(key);
          setNotice({ tone: 'ok', text: t.verifiedOpened(fresh.current.station.name) });
          scanFeedback('ok');
        } else {
          setNotice({ tone: 'error', text: t.uncertain, retry: () => void scan(raw) });
          scanFeedback('error');
        }
        return;
      }
      attempts.current.delete(key);
      scanFeedback('error');
      if (error instanceof ClientApiError && error.code === 'STATION_IN_USE') {
        const details = stationInUseSchema.safeParse(error.details);
        if (details.success) {
          setInUse(details.data);
          setNotice(null);
          return;
        }
      }
      if (error instanceof ClientApiError && error.code === 'SESSION_ELSEWHERE') {
        const details = elsewhereSchema.safeParse(error.details);
        if (details.success) {
          setNotice({ tone: 'error', text: t.elsewhere(details.data.station.name) });
          return;
        }
      }
      setNotice({ tone: 'error', text: errorText(error) });
    } finally {
      setBusy(false);
      setValue('');
    }
  }

  async function leave(sessionId: string) {
    if (busy) return;
    const key = `release:${sessionId}`;
    setBusy(true);
    try {
      await apiSend('POST', `admin/station-sessions/${sessionId}/release`, releasedSchema, {
        requestId: attemptId(key),
      });
      attempts.current.delete(key);
      setCurrent(null);
      setBlocked(null);
      setNotice({ tone: 'info', text: t.left });
    } catch (error) {
      if (uncertain(error)) {
        const fresh = await reconcile();
        if (
          fresh &&
          fresh.current?.session.id !== sessionId &&
          fresh.blocked?.sessionId !== sessionId
        ) {
          attempts.current.delete(key);
          setNotice({ tone: 'info', text: t.verifiedLeft });
        } else {
          setNotice({ tone: 'error', text: t.uncertain, retry: () => void leave(sessionId) });
        }
        return;
      }
      attempts.current.delete(key);
      if (error instanceof ClientApiError && error.code === 'SESSION_NOT_OWNED') {
        // Taken over or deactivated meanwhile: the station is no longer this user's.
        await reconcile();
        setNotice({ tone: 'error', text: t.lostSession });
      } else setNotice({ tone: 'error', text: errorText(error) });
    } finally {
      setBusy(false);
    }
  }

  async function takeover() {
    const r = reasonError(reason);
    setReasonErr(r);
    if (r || !inUse) return;
    const key = `takeover:${inUse.sessionId}:${reason.trim()}`;
    setBusy(true);
    try {
      const result = await apiSend(
        'POST',
        `admin/station-sessions/${inUse.sessionId}/takeover`,
        stationSessionResultSchema,
        { requestId: attemptId(key), reason: reason.trim() },
      );
      attempts.current.delete(key);
      setDialog(false);
      setInUse(null);
      setReason('');
      setCurrent({ session: result.session, station: result.station });
      setNotice({ tone: 'ok', text: t.takenOver(result.station.name) });
      scanFeedback('ok');
    } catch (error) {
      setDialog(false);
      if (uncertain(error)) {
        const fresh = await reconcile();
        if (fresh?.current) {
          attempts.current.delete(key);
          setInUse(null);
          setReason('');
          setNotice({ tone: 'ok', text: t.verifiedOpened(fresh.current.station.name) });
          scanFeedback('ok');
        } else {
          setNotice({ tone: 'error', text: t.uncertain, retry: () => setDialog(true) });
          scanFeedback('error');
        }
        return;
      }
      attempts.current.delete(key);
      setNotice({ tone: 'error', text: errorText(error) });
      scanFeedback('error');
    } finally {
      setBusy(false);
    }
  }

  const noticeBox = notice && (
    <div
      role={notice.tone === 'error' ? 'alert' : 'status'}
      data-testid="station-notice"
      className={
        notice.tone === 'ok'
          ? 'rounded-md border border-emerald-300 bg-emerald-50 p-3 text-sm font-medium text-emerald-950'
          : notice.tone === 'error'
            ? 'rounded-md border border-red-300 bg-red-50 p-3 text-sm font-medium text-red-900'
            : 'rounded-md border border-stone-300 bg-stone-50 p-3 text-sm text-stone-800'
      }
    >
      <span aria-hidden="true">
        {notice.tone === 'ok' ? '✔ ' : notice.tone === 'error' ? '✖ ' : 'ℹ '}
      </span>
      {notice.text}
      {notice.retry && (
        <button
          type="button"
          className={`${buttonClass.secondary} ml-2`}
          onClick={notice.retry}
          disabled={busy}
        >
          {t.retry}
        </button>
      )}
    </div>
  );

  if (current) {
    const s = current.station;
    return (
      <div className="flex flex-col gap-4">
        <div
          data-testid="station-banner"
          className="sticky top-0 z-10 flex flex-col gap-2 rounded-lg border-2 border-stone-900 bg-amber-50 p-4 shadow-sm sm:flex-row sm:items-center sm:justify-between"
        >
          <div className="min-w-0">
            <p
              className="text-lg font-bold uppercase tracking-wide text-stone-900"
              data-testid="station-mode"
            >
              {workstationsCs.mode[s.mode]}
              {s.category ? ` · ${s.category.name}` : ''}
            </p>
            <p className="text-base font-medium wrap-anywhere">
              {s.name} <span className="font-mono text-sm text-stone-600">({s.code})</span>
            </p>
            <p className="text-sm text-stone-700">
              {t.site}: {s.site.name} · {t.warehouse}: {s.warehouse.name} · {t.worker}:{' '}
              {current.session.user}
            </p>
          </div>
          <button
            type="button"
            className={`${buttonClass.secondary} shrink-0`}
            onClick={() => void leave(current.session.id)}
            disabled={busy || unresolved}
            title={unresolved ? t.leaveBlocked : undefined}
          >
            {t.leave}
          </button>
        </div>
        {noticeBox}
        {s.mode === 'LABELING' ? (
          <LabelingWorkspace
            key={current.session.id}
            sessionId={current.session.id}
            onUnresolvedChange={setUnresolved}
          />
        ) : (
          <FillingWorkspace
            key={current.session.id}
            sessionId={current.session.id}
            onUnresolvedChange={setUnresolved}
          />
        )}
        <p className="text-xs text-stone-500">
          {t.leaveHelp} {t.since}: {formatDateTimeCs(current.session.openedAt, timeZone)}
        </p>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      {blocked && (
        <div
          role="alert"
          className="flex flex-col gap-2 rounded-md border border-amber-300 bg-amber-50 p-3 text-sm text-amber-950"
          data-testid="station-blocked"
        >
          <p className="font-medium">{t.blockedTitle}</p>
          <p>{t.blockedText(workstationsCs.errors[blocked.code] ?? workstationsCs.failed)}</p>
          <button
            type="button"
            className={`${buttonClass.secondary} self-start`}
            onClick={() => void leave(blocked.sessionId)}
            disabled={busy}
          >
            {t.leave}
          </button>
        </div>
      )}
      {ended && (
        <div
          role="alert"
          className="rounded-md border border-amber-300 bg-amber-50 p-3 text-sm text-amber-950"
          data-testid="station-ended"
        >
          <p className="font-medium">{t.endedTitle}</p>
          <p>
            {t.endedByOther(
              ended.station.name,
              ended.endedBy,
              formatDateTimeCs(ended.endedAt, timeZone),
              ended.reason,
            )}
          </p>
        </div>
      )}
      <Card>
        <form
          className="flex flex-col gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            void scan(value);
          }}
          data-testid="station-scan"
        >
          <label htmlFor={`${id}-scan`} className="text-sm font-medium">
            {t.scanStation}
          </label>
          <input
            id={`${id}-scan`}
            ref={input}
            value={value}
            disabled={busy}
            autoComplete="off"
            spellCheck={false}
            placeholder={t.scanPlaceholder}
            onChange={(e) => setValue(e.target.value)}
            aria-describedby={`${id}-help`}
            className={`${inputClass} text-lg`}
          />
          <p id={`${id}-help`} className="text-xs text-stone-500">
            {busy ? t.checking : t.scanHelp}
          </p>
        </form>
      </Card>
      {noticeBox}
      {inUse && (
        <div
          role="alert"
          className="flex flex-col gap-2 rounded-md border border-red-300 bg-red-50 p-3 text-sm text-red-950"
          data-testid="station-in-use"
        >
          <p className="font-medium">{t.inUseTitle(inUse.holder)}</p>
          <p>{t.inUseText(formatDateTimeCs(inUse.lastActivityAt, timeZone), inUse.leaseExpired)}</p>
          <p>{t.inUseHandover}</p>
          {canTakeover && (
            <button
              type="button"
              className={`${buttonClass.danger} self-start`}
              onClick={() => {
                setReasonErr(null);
                setDialog(true);
              }}
            >
              {t.takeover}
            </button>
          )}
        </div>
      )}
      <ConfirmDialog
        open={dialog}
        title={t.takeoverTitle}
        confirmLabel={t.takeover}
        danger
        busy={busy}
        onConfirm={() => void takeover()}
        onCancel={() => setDialog(false)}
        testId="takeover-dialog"
      >
        <p>{inUse ? t.takeoverText(inUse.holder) : ''}</p>
        <ReasonField
          id={`${id}-reason`}
          value={reason}
          onChange={setReason}
          error={reasonErr}
          label={t.takeoverReason}
        />
      </ConfirmDialog>
    </div>
  );
}
