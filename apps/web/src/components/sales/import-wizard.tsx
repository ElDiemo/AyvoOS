'use client';

import {
  IMPORT_FIELDS,
  SINGLE_IMPORT_FIELDS,
  importInspectionSchema,
  importPreviewSchema,
  importResultSchema,
  type ImportField,
  type ImportInspection,
  type ImportOptions,
  type ImportPreview,
  type ImportPreviewRow,
  type Salesperson,
} from '@ayvo/types';
import { cn } from '@ayvo/ui';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useId, useState } from 'react';
import { ConfirmDialog, fieldClass, FormField, useAttempt } from '@/components/catalog/form-kit';
import { buttonClass, Card, ErrorNote } from '@/components/ui';
import { salesCs } from '@/i18n/cs/sales';
import { apiSend, ClientApiError } from '@/lib/client-api';
import { salesErrorText } from './sales-format';

const t = salesCs.importer;
const PAGE = 50;

type Choice = { include: boolean; ack: boolean };
const hasDuplicates = (r: ImportPreviewRow) =>
  r.fileDuplicates.length > 0 || r.duplicates.length > 0;

/**
 * The CSV import (doc 034 §13): file → columns → preview (writes nothing) → explicit
 * confirmation. The file stays in the browser and is sent again for each step; the server
 * checks everything again on confirmation. One request id per confirmation attempt, so a double
 * click or a retry after a lost answer never imports twice.
 */
export function ImportWizard({ salespeople }: { salespeople: Salesperson[] | null }) {
  const id = useId();
  const router = useRouter();
  const [file, setFile] = useState<File | null>(null);
  const [inspection, setInspection] = useState<ImportInspection | null>(null);
  const [mapping, setMapping] = useState<ImportField[]>([]);
  const [country, setCountry] = useState('');
  const [label, setLabel] = useState('');
  const [ownerId, setOwnerId] = useState('');
  const [overrides, setOverrides] = useState<ImportOptions['overrides']>({});
  const [preview, setPreview] = useState<ImportPreview | null>(null);
  /** The fixes the shown preview was made with; others must be checked before confirming. */
  const [previewedFixes, setPreviewedFixes] = useState('{}');
  const [choice, setChoice] = useState<Record<number, Choice>>({});
  const [problemsOnly, setProblemsOnly] = useState(false);
  const [page, setPage] = useState(1);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const attempt = useAttempt();

  const form = (extra?: object) => {
    const data = new FormData();
    data.append('file', file!, file!.name);
    if (extra) data.append('options', JSON.stringify(extra));
    return data;
  };
  const options = (): ImportOptions => ({
    mapping,
    defaults: {
      countryCode: country.trim() ? country.trim().toUpperCase() : null,
      contactLabel: label.trim() || null,
    },
    overrides,
    ownerId: ownerId || null,
  });
  const fail = (e: unknown) => setError(salesErrorText(e));

  async function inspect() {
    if (!file) return setError(salesCs.errors.IMPORT_FILE_MISSING!);
    setBusy(true);
    setError(null);
    try {
      const i = await apiSend(
        'POST',
        'admin/sales/imports/inspect',
        importInspectionSchema,
        form(),
      );
      setInspection(i);
      setMapping(i.suggested);
      setPreview(null);
      setOverrides({});
    } catch (e) {
      fail(e);
    } finally {
      setBusy(false);
    }
  }

  function mappingProblem(): string | null {
    if (!mapping.includes('name')) return t.nameRequired;
    const twice = SINGLE_IMPORT_FIELDS.find((f) => mapping.filter((m) => m === f).length > 1);
    return twice ? t.mappedTwice(t.fields[twice]) : null;
  }

  async function check(keepChoice = false) {
    const problem = mappingProblem();
    if (problem) return setError(problem);
    if (country.trim() && !/^[A-Za-z]{2}$/.test(country.trim()))
      return setError(salesCs.form.countryInvalid);
    setBusy(true);
    setError(null);
    try {
      const p = await apiSend(
        'POST',
        'admin/sales/imports/preview',
        importPreviewSchema,
        form(options()),
      );
      // The user's earlier choice counts only for a row that could be chosen then (no errors);
      // a row just fixed starts with the default. A possible duplicate needs its confirmation.
      const wasOk = new Set(preview?.rows.filter((r) => !r.errors.length).map((r) => r.row));
      setPreview(p);
      setPreviewedFixes(JSON.stringify(overrides));
      setChoice((old) =>
        Object.fromEntries(
          p.rows.map((r) => {
            const prev = keepChoice && wasOk.has(r.row) ? old[r.row] : undefined;
            const ok = r.errors.length === 0;
            const dup = hasDuplicates(r);
            const ack = ok && dup ? (prev?.ack ?? false) : false;
            const include = ok && (prev ? prev.include : !dup) && (!dup || ack);
            return [r.row, { include, ack }];
          }),
        ),
      );
      setPage(1);
    } catch (e) {
      fail(e);
    } finally {
      setBusy(false);
    }
  }

  const selected = preview
    ? preview.rows.filter((r) => choice[r.row]?.include && !r.errors.length)
    : [];
  const blockedByDuplicates = selected.filter((r) => hasDuplicates(r) && !choice[r.row]?.ack);
  const fixesPending = JSON.stringify(overrides) !== previewedFixes;

  async function confirm() {
    if (!selected.length) return setError(t.nothingSelected);
    setConfirming(false);
    setError(null);
    const body = {
      ...options(),
      // The server confirms only what this preview showed (the same file and decisions).
      fingerprint: preview!.fingerprint,
      rows: selected.map((r) => ({ row: r.row, acknowledgeDuplicates: !!choice[r.row]?.ack })),
    };
    const result = await attempt.run(JSON.stringify(body) + file!.name + file!.size, (requestId) =>
      apiSend('POST', 'admin/sales/imports', importResultSchema, form({ ...body, requestId })),
    );
    if (result.ok) {
      router.push(`/sales/prospects/import/${result.value.code}`);
      return;
    }
    if (!result.error) return;
    fail(result.error);
    // The file changed since the preview (saved again in Excel): a fresh preview, fresh choices.
    if (result.error instanceof ClientApiError && result.error.code === 'IMPORT_PREVIEW_STALE') {
      await check(false);
      setError(salesErrorText(result.error));
      return;
    }
    // The world changed since the preview: show the current state, keep the user's choices.
    if (
      result.error instanceof ClientApiError &&
      ['IMPORT_DUPLICATES_UNCONFIRMED', 'IMPORT_ROWS_INVALID'].includes(result.error.code ?? '')
    ) {
      await check(true);
      setError(salesErrorText(result.error));
    }
  }

  const rows = preview
    ? preview.rows.filter((r) => !problemsOnly || r.errors.length || hasDuplicates(r))
    : [];
  const pages = Math.max(1, Math.ceil(rows.length / PAGE));
  const shown = rows.slice((page - 1) * PAGE, page * PAGE);
  const ownerName =
    preview?.owner.name ?? salespeople?.find((s) => s.id === ownerId)?.name ?? t.ownerMe;

  return (
    <div className="flex flex-col gap-6" data-testid="import-wizard">
      <ol className="flex flex-wrap gap-2 text-sm" aria-label="Postup">
        {t.steps.slice(0, 3).map((s, i) => {
          const step = preview ? 2 : inspection ? 1 : 0;
          return (
            <li
              key={s}
              aria-current={step === i ? 'step' : undefined}
              className={cn(
                'rounded-full px-3 py-1',
                step === i ? 'bg-stone-900 text-white' : 'bg-stone-100 text-stone-600',
              )}
            >
              {i + 1}. {s}
            </li>
          );
        })}
      </ol>

      <Card title={t.steps[0]} testId="import-file">
        <div className="flex flex-col gap-4">
          <FormField id={`${id}-file`} label={t.file} help={t.fileHelp}>
            <input
              id={`${id}-file`}
              type="file"
              accept=".csv,text/csv"
              onChange={(e) => {
                setFile(e.target.files?.[0] ?? null);
                setInspection(null);
                setPreview(null);
                setError(null);
              }}
              className="block w-full min-w-0 text-sm"
              data-testid="import-file-input"
            />
          </FormField>
          {salespeople && (
            <FormField id={`${id}-owner`} label={t.owner}>
              <select
                id={`${id}-owner`}
                value={ownerId}
                onChange={(e) => {
                  setOwnerId(e.target.value);
                  setPreview(null);
                }}
                className={fieldClass(false)}
                data-testid="import-owner"
              >
                <option value="">{t.ownerMe}</option>
                {salespeople.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name} ({s.email})
                  </option>
                ))}
              </select>
            </FormField>
          )}
          <div className="flex flex-wrap items-center gap-3">
            <button
              type="button"
              className={buttonClass.primary}
              disabled={busy || !file}
              onClick={() => void inspect()}
              data-testid="import-read"
            >
              {busy && !inspection ? t.reading : t.read}
            </button>
            {inspection && (
              <p className="text-sm text-stone-600" data-testid="import-file-info">
                {inspection.fileName} ·{' '}
                {t.fileInfo(inspection.rowCount, inspection.encoding, inspection.delimiter)}
              </p>
            )}
          </div>
        </div>
      </Card>

      {inspection && (
        <Card title={t.mapTitle} testId="import-mapping">
          <p className="mb-4 text-sm text-stone-600">{t.mapHelp}</p>
          <ul className="flex flex-col divide-y divide-stone-100">
            {inspection.headers.map((h, i) => (
              <li
                key={i}
                className="grid grid-cols-1 gap-2 py-3 first:pt-0 sm:grid-cols-[minmax(0,1fr)_minmax(0,16rem)] sm:items-center"
                data-testid={`map-col-${i}`}
              >
                <div className="min-w-0">
                  <p className="font-medium wrap-anywhere">{h || t.emptyHeader(i + 1)}</p>
                  <p className="truncate text-xs text-stone-500">
                    {inspection.sample
                      .map((r) => r[i]?.trim())
                      .filter(Boolean)
                      .slice(0, 3)
                      .join(' · ') || '—'}
                  </p>
                </div>
                <select
                  aria-label={`${t.meaning}: ${h || t.emptyHeader(i + 1)}`}
                  value={mapping[i] ?? 'ignore'}
                  onChange={(e) => {
                    const next = [...mapping];
                    next[i] = e.target.value as ImportField;
                    setMapping(next);
                    setPreview(null);
                  }}
                  className={fieldClass(false)}
                  data-testid={`map-select-${i}`}
                >
                  {IMPORT_FIELDS.map((f) => (
                    <option key={f} value={f}>
                      {t.fields[f]}
                    </option>
                  ))}
                </select>
              </li>
            ))}
          </ul>
          <div className="mt-5 grid grid-cols-1 gap-4 border-t border-stone-100 pt-4 sm:grid-cols-2">
            <FormField id={`${id}-country`} label={t.defaultCountry} help={t.defaultCountryHelp}>
              <input
                id={`${id}-country`}
                value={country}
                maxLength={2}
                placeholder="CZ"
                onChange={(e) => {
                  setCountry(e.target.value);
                  setPreview(null);
                }}
                className={cn(fieldClass(false), 'uppercase')}
                data-testid="import-default-country"
              />
            </FormField>
            <FormField id={`${id}-label`} label={t.defaultLabel} help={t.defaultLabelHelp}>
              <input
                id={`${id}-label`}
                value={label}
                maxLength={160}
                placeholder="Recepce"
                onChange={(e) => {
                  setLabel(e.target.value);
                  setPreview(null);
                }}
                className={fieldClass(false)}
                data-testid="import-default-label"
              />
            </FormField>
          </div>
          {!preview && (
            <div className="mt-5">
              <button
                type="button"
                className={buttonClass.primary}
                disabled={busy}
                onClick={() => void check()}
                data-testid="import-check"
              >
                {busy ? t.checking : t.check}
              </button>
            </div>
          )}
        </Card>
      )}

      {error && (
        <div role="alert" data-testid="import-error">
          <ErrorNote>{error}</ErrorNote>
        </div>
      )}

      {preview && (
        <Card title={t.previewTitle} testId="import-preview">
          <div className="flex flex-col gap-4">
            <p className="text-sm font-medium" data-testid="import-counts">
              {t.counts(
                preview.counts.total,
                preview.counts.valid,
                preview.counts.withErrors,
                preview.counts.withDuplicates,
              )}
            </p>
            <div className="flex flex-wrap gap-2" role="tablist">
              {[false, true].map((only) => (
                <button
                  key={String(only)}
                  type="button"
                  role="tab"
                  aria-selected={problemsOnly === only}
                  className={cn(
                    'rounded-md px-3 py-1.5 text-sm font-medium',
                    problemsOnly === only
                      ? 'bg-stone-900 text-white'
                      : 'text-stone-600 hover:bg-stone-100',
                  )}
                  onClick={() => {
                    setProblemsOnly(only);
                    setPage(1);
                  }}
                  data-testid={only ? 'import-show-problems' : 'import-show-all'}
                >
                  {only ? t.showProblems : t.showAll}
                </button>
              ))}
            </div>
            <ul className="flex flex-col divide-y divide-stone-100" data-testid="import-rows">
              {shown.map((r) => (
                <PreviewRow
                  key={r.row}
                  r={r}
                  choice={choice[r.row] ?? { include: false, ack: false }}
                  onChoice={(c) => setChoice({ ...choice, [r.row]: c })}
                  fix={overrides[String(r.row)] ?? {}}
                  onFix={(f) => setOverrides({ ...overrides, [String(r.row)]: f })}
                />
              ))}
            </ul>
            {pages > 1 && (
              <nav
                className="flex items-center justify-between gap-2 text-sm"
                aria-label="Stránky náhledu"
              >
                <button
                  type="button"
                  disabled={page <= 1}
                  onClick={() => setPage(page - 1)}
                  className="underline disabled:no-underline disabled:opacity-40"
                >
                  {t.previous}
                </button>
                <span className="text-stone-600">{t.page(page, pages)}</span>
                <button
                  type="button"
                  disabled={page >= pages}
                  onClick={() => setPage(page + 1)}
                  className="underline disabled:no-underline disabled:opacity-40"
                  data-testid="import-next-page"
                >
                  {t.next}
                </button>
              </nav>
            )}
            {fixesPending && (
              <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
                <button
                  type="button"
                  className={buttonClass.secondary}
                  disabled={busy}
                  onClick={() => void check(true)}
                  data-testid="import-recheck"
                >
                  {busy ? t.checking : t.recheck}
                </button>
                <p className="text-sm text-stone-600" data-testid="import-fixes-pending">
                  {t.fixesPending}
                </p>
              </div>
            )}
            <div className="flex flex-col gap-3 border-t border-stone-100 pt-4 sm:flex-row sm:items-center sm:justify-between">
              <p className="text-sm text-stone-600" data-testid="import-selected">
                {t.selected(selected.length, preview.counts.total)}
              </p>
              <div className="flex flex-wrap gap-2">
                <button
                  type="button"
                  className={buttonClass.secondary}
                  onClick={() => setPreview(null)}
                  disabled={attempt.busy}
                >
                  {t.back}
                </button>
                <button
                  type="button"
                  className={buttonClass.primary}
                  disabled={
                    attempt.busy ||
                    busy ||
                    fixesPending ||
                    !selected.length ||
                    blockedByDuplicates.length > 0
                  }
                  onClick={() => setConfirming(true)}
                  data-testid="import-confirm"
                >
                  {attempt.busy ? t.importing : t.confirm(selected.length)}
                </button>
              </div>
            </div>
          </div>
          <ConfirmDialog
            open={confirming}
            title={t.confirmTitle}
            confirmLabel={t.confirm(selected.length)}
            busy={attempt.busy}
            onConfirm={() => void confirm()}
            onCancel={() => setConfirming(false)}
            testId="import-confirm-dialog"
          >
            <p>{t.confirmText(selected.length, ownerName)}</p>
          </ConfirmDialog>
        </Card>
      )}
    </div>
  );
}

function PreviewRow({
  r,
  choice,
  onChoice,
  fix,
  onFix,
}: {
  r: ImportPreviewRow;
  choice: Choice;
  onChoice: (c: Choice) => void;
  fix: { name?: string; countryCode?: string };
  onFix: (f: { name?: string; countryCode?: string }) => void;
}) {
  const id = useId();
  const codes = r.errors.map((e) => e.code);
  const dup = hasDuplicates(r);
  const needsName = codes.includes('NAME_MISSING');
  const needsCountry = codes.includes('COUNTRY_MISSING') || codes.includes('COUNTRY_INVALID');
  return (
    <li
      className="flex flex-col gap-2 py-3 first:pt-0 last:pb-0"
      data-testid={`import-row-${r.row}`}
    >
      <div className="flex flex-wrap items-start justify-between gap-2">
        <label className="flex min-w-0 items-start gap-2">
          <input
            type="checkbox"
            className="mt-1"
            checked={choice.include && !r.errors.length}
            // A possible duplicate is included only by its explicit confirmation below.
            disabled={r.errors.length > 0 || (dup && !choice.ack)}
            onChange={(e) => onChoice({ ...choice, include: e.target.checked })}
            aria-label={`${t.include}: ${t.row(r.row)}`}
            data-testid="import-include"
          />
          <span className="min-w-0">
            <span className="text-xs text-stone-500">{t.row(r.row)}</span>{' '}
            <span className="font-medium wrap-anywhere">{r.name ?? '—'}</span>
            <span className="block text-xs text-stone-500 wrap-anywhere">
              {[r.city, r.countryCode].filter(Boolean).join(', ') || '—'}
              {r.priority && ` · ${r.priority}`}
              {r.roomsEstimate && ` · ~${r.roomsEstimate} pok.`}
              {' · '}
              {r.contact
                ? [r.contact.label, r.contact.position, r.contact.email, r.contact.phone]
                    .filter(Boolean)
                    .join(', ')
                : t.noContact}
            </span>
          </span>
        </label>
        <span
          className={cn(
            'shrink-0 rounded px-2 py-0.5 text-xs font-medium',
            r.errors.length
              ? 'bg-red-50 text-red-800'
              : dup
                ? 'bg-amber-50 text-amber-900'
                : 'bg-emerald-50 text-emerald-800',
          )}
          data-testid="import-row-status"
        >
          {r.errors.length ? t.hasErrors : dup ? t.duplicate : t.ok}
        </span>
      </div>
      {r.errors.length > 0 && (
        <ul className="ml-6 list-disc pl-4 text-sm text-red-800" data-testid="import-row-errors">
          {r.errors.map((e, i) => (
            <li key={i} className="wrap-anywhere">
              {t.rowErrors[e.code]}
              {e.value && ` („${e.value}“)`}
            </li>
          ))}
        </ul>
      )}
      {(needsName || needsCountry) && (
        <div className="ml-6 grid grid-cols-1 gap-3 sm:grid-cols-2">
          {needsName && (
            <FormField id={`${id}-name`} label={t.fixName}>
              <input
                id={`${id}-name`}
                value={fix.name ?? ''}
                maxLength={200}
                onChange={(e) => onFix({ ...fix, name: e.target.value || undefined })}
                className={fieldClass(false)}
                data-testid="import-fix-name"
              />
            </FormField>
          )}
          {needsCountry && (
            <FormField id={`${id}-country`} label={t.fixCountry}>
              <input
                id={`${id}-country`}
                value={fix.countryCode ?? ''}
                maxLength={2}
                onChange={(e) =>
                  onFix({ ...fix, countryCode: e.target.value.toUpperCase() || undefined })
                }
                className={cn(fieldClass(false), 'uppercase')}
                data-testid="import-fix-country"
              />
            </FormField>
          )}
        </div>
      )}
      {dup && (
        <div
          className="ml-6 flex flex-col gap-1 rounded-md border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900"
          data-testid="import-row-duplicates"
        >
          {r.fileDuplicates.length > 0 && <p>{t.inFile(r.fileDuplicates)}</p>}
          {r.duplicates.length > 0 && (
            <>
              <p>{t.existing}</p>
              <ul className="list-disc pl-5">
                {r.duplicates.map((d) => (
                  <li key={d.code} className="wrap-anywhere">
                    <Link href={`/sales/prospects/${d.code}`} target="_blank" className="underline">
                      {d.name}
                    </Link>
                    {d.city ? `, ${d.city}` : ''} · {d.owner}
                    {d.archived && ` · ${salesCs.list.archivedBadge}`} ·{' '}
                    {d.reasons.map((x) => salesCs.form.duplicateReasons[x]).join(', ')}
                  </li>
                ))}
              </ul>
            </>
          )}
          {!r.errors.length && (
            <label className="mt-1 flex items-center gap-2 font-medium">
              <input
                type="checkbox"
                checked={choice.ack}
                onChange={(e) => onChoice({ include: e.target.checked, ack: e.target.checked })}
                data-testid="import-acknowledge"
              />
              {t.acknowledge}
            </label>
          )}
        </div>
      )}
      {r.note && (
        <details className="ml-6 text-xs text-stone-500">
          <summary className="cursor-pointer">{t.notePreview}</summary>
          <p className="mt-1 whitespace-pre-line wrap-anywhere">{r.note}</p>
        </details>
      )}
    </li>
  );
}
