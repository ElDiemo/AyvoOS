import {
  commissionPreviewSchema,
  commissionStatementListSchema,
  type CommissionFlag,
  type CommissionItem,
  type CommissionMode,
  type CommissionPreview,
} from '@ayvo/types';
import { cn } from '@ayvo/ui';
import Link from 'next/link';
import { financeAmount, financeDate } from '@/components/finance/finance-format';
import {
  buttonClass,
  Card,
  EmptyState,
  ErrorNote,
  Field,
  FieldList,
  Notice,
} from '@/components/ui';
import { commissionsCs } from '@/i18n/cs/commissions';
import { formatDateTimeCs } from '@/i18n/cs/format';
import { apiGetResult } from '@/lib/api';
import { CommissionApprove } from './commission-approve';
import { causeLabel, closableFrom, flagLabel } from './commission-closing-format';
import { monthCs, rateCs } from './commission-format';
import {
  APPROVABLE_CURRENCY,
  monthIsEmpty,
  overviewRows,
  ROW_STATES,
  stateCounts,
  type OverviewRow,
  type RowState,
} from './commission-overview';
import { SalespersonInvoiceForm } from './salesperson-invoice-form';

const t = commissionsCs.closing;
const o = commissionsCs.overview;

const badgeTone: Record<RowState, string> = {
  BLOCKED: 'border-amber-300 bg-amber-50 text-amber-900',
  AWAITING_APPROVAL: 'border-sky-200 bg-sky-50 text-sky-900',
  TO_INVOICE: 'border-stone-300 bg-stone-100 text-stone-900',
  INVOICE_RECEIVED: 'border-emerald-200 bg-emerald-50 text-emerald-900',
  NOTHING_TO_INVOICE: 'border-stone-200 bg-white text-stone-600',
};

function StateBadge({ state, testId }: { state: RowState; testId?: string }) {
  return (
    <span
      className={cn(
        'inline-flex items-center rounded border px-2 py-0.5 text-xs font-medium',
        badgeTone[state],
      )}
      data-testid={testId}
    >
      {o.state[state]}
    </span>
  );
}

function Items({
  items,
  currency,
  testId,
}: {
  items: readonly CommissionItem[];
  currency: string;
  testId: string;
}) {
  const c = t.columns;
  return (
    <div className="max-h-[28rem] overflow-auto">
      <table className="w-full min-w-[46rem] text-left text-sm" data-testid={testId}>
        <thead className="sticky top-0 bg-white text-xs text-stone-500">
          <tr>
            {[c.hotel, c.cause, c.invoice, c.serviceMonth, c.base, c.k, c.rate, c.amount].map(
              (h) => (
                <th key={h} scope="col" className="py-2 pr-3 font-medium whitespace-nowrap">
                  {h}
                </th>
              ),
            )}
          </tr>
        </thead>
        <tbody className="divide-y divide-stone-100">
          {items.map((i) => (
            <tr key={`${i.invoiceNumber}#${i.lineNo}#${i.cause}`}>
              <td className="py-2 pr-3 whitespace-nowrap">{i.hotelCode}</td>
              <td className="py-2 pr-3">{causeLabel(i)}</td>
              <td className="py-2 pr-3 whitespace-nowrap">{i.invoiceNumber}</td>
              <td className="py-2 pr-3 tabular-nums">{monthCs(i.serviceMonth)}</td>
              <td className="py-2 pr-3 text-right whitespace-nowrap tabular-nums">
                {financeAmount(i.base, currency)}
              </td>
              <td className="py-2 pr-3 tabular-nums">{i.k}.</td>
              <td className="py-2 pr-3 whitespace-nowrap tabular-nums">{rateCs(i.rate)} %</td>
              <td className="py-2 pr-3 text-right whitespace-nowrap tabular-nums">
                {financeAmount(i.amount, currency)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

type Sums = {
  openingBalance: string;
  total: string;
  closingBalance: string;
  amountToInvoice: string;
  carriedForward: string;
  currency: string;
};

function Balance({ s, invoiced, testId }: { s: Sums; invoiced: boolean; testId: string }) {
  const b = t.balance;
  return (
    <div data-testid={testId}>
      <FieldList>
        <Field label={b.opening}>{financeAmount(s.openingBalance, s.currency)}</Field>
        <Field label={b.total}>{financeAmount(s.total, s.currency)}</Field>
        <Field label={b.closing}>{financeAmount(s.closingBalance, s.currency)}</Field>
        <Field label={invoiced ? o.amount.INVOICE_RECEIVED : b.toInvoice}>
          <strong data-testid={`${testId}-to-invoice`}>
            {financeAmount(s.amountToInvoice, s.currency)}
          </strong>
        </Field>
        {s.carriedForward !== '0.00' && (
          <Field label={b.carried}>{financeAmount(s.carriedForward, s.currency)}</Field>
        )}
      </FieldList>
    </div>
  );
}

function FlagList({
  flags,
  testId,
  mode,
}: {
  flags: readonly CommissionFlag[];
  testId: string;
  /** With a mode, an earlier open month gets a link to its own overview. */
  mode?: CommissionMode;
}) {
  const due = [...new Set(flags.map((f) => f.dueMonth).filter((m): m is string => !!m))];
  return (
    <div className="flex flex-col gap-1">
      <ul className="flex flex-col gap-1 text-sm text-amber-900" data-testid={testId}>
        {flags.map((f) => (
          <li key={`${f.code}#${f.invoiceNumber}#${f.hotelCode}`} className="wrap-anywhere">
            {flagLabel(f, monthCs)}: {f.invoiceNumber} · {f.hotelCode} · {monthCs(f.serviceMonth)}
          </li>
        ))}
      </ul>
      {mode &&
        due.map((m) => (
          <Link
            key={m}
            href={`/sales/commissions?tab=closing&month=${m}&mode=${mode}`}
            className="self-start text-sm text-stone-800 underline underline-offset-2"
            data-testid={`${testId}-open-${m}`}
          >
            {o.openMonth(monthCs(m))}
          </Link>
        ))}
    </div>
  );
}

function Deviations({
  items,
  flags,
  openingBalance,
  currency,
  testId,
}: {
  items: readonly CommissionItem[];
  flags: readonly CommissionFlag[];
  openingBalance: string;
  currency: string;
  testId: string;
}) {
  const corrections = items.filter((i) => i.kind === 'CORRECTION');
  const carriedIn = openingBalance.startsWith('-') ? openingBalance : null;
  return (
    <section aria-label={t.deviations} data-testid={testId}>
      <h3 className="mb-2 text-sm font-semibold">{t.deviations}</h3>
      {corrections.length === 0 && flags.length === 0 && !carriedIn ? (
        <p className="text-sm text-stone-600">{t.noDeviations}</p>
      ) : (
        <div className="flex flex-col gap-1 text-sm">
          {carriedIn && <p>{t.openingNote(financeAmount(carriedIn, currency))}</p>}
          {corrections.length > 0 && (
            <ul className="flex flex-col gap-1">
              {corrections.map((c) => (
                <li key={`${c.invoiceNumber}#${c.lineNo}#${c.cause}`} className="wrap-anywhere">
                  {causeLabel(c)}: {c.invoiceNumber} · {c.hotelCode} · {monthCs(c.serviceMonth)} ·{' '}
                  {financeAmount(c.amount, currency)}
                </li>
              ))}
              <li className="text-xs text-stone-500">{t.correctionNote}</li>
            </ul>
          )}
          {flags.length > 0 && <FlagList flags={flags} testId={`${testId}-flags`} />}
        </div>
      )}
    </section>
  );
}

/** The amount the row's first layer shows, labelled by its state (never a new instruction). */
function rowAmount(r: OverviewRow): string {
  const s = r.approved ?? r.preview!;
  return r.state === 'NOTHING_TO_INVOICE' ? s.carriedForward : s.amountToInvoice;
}

function Action({
  r,
  month,
  mode,
  today,
  testId,
}: {
  r: OverviewRow;
  month: string;
  mode: CommissionMode;
  today: string;
  testId: string;
}) {
  if (r.conflict) return null;
  const inv = r.approved?.salespersonInvoice ?? null;
  if (r.state === 'AWAITING_APPROVAL' || r.state === 'BLOCKED')
    return (
      <div className="flex flex-col gap-1">
        {r.state === 'AWAITING_APPROVAL' && (
          <p className="text-sm text-stone-600">{o.next.AWAITING_APPROVAL}</p>
        )}
        <CommissionApprove
          month={month}
          monthLabel={monthCs(month)}
          mode={mode}
          salesperson={r.salesperson}
          currency={r.currency}
          fingerprint={r.preview!.fingerprint}
          amountLabel={financeAmount(r.preview!.amountToInvoice, r.currency)}
          blocked={r.preview!.flags.length > 0}
        />
      </div>
    );
  if (r.state === 'TO_INVOICE')
    return (
      <details data-testid={`${testId}-invoice-action`}>
        <summary className={cn(buttonClass.primary, 'cursor-pointer list-none')}>
          {o.recordInvoice}
        </summary>
        <div className="mt-3">
          <p className="mb-3 text-sm text-stone-600">{o.next.TO_INVOICE}</p>
          <SalespersonInvoiceForm
            statementId={r.approved!.id}
            amountLabel={financeAmount(r.approved!.amountToInvoice, r.currency)}
            today={today}
          />
        </div>
      </details>
    );
  if (r.state === 'INVOICE_RECEIVED' && inv)
    return (
      <p className="text-sm text-stone-700">
        {o.next.INVOICE_RECEIVED.before}{' '}
        <strong data-testid={`${testId}-payout`}>{financeDate(inv.payoutOn)}</strong>{' '}
        {o.next.INVOICE_RECEIVED.after}
      </p>
    );
  return <p className="text-sm text-stone-600">{o.next.NOTHING_TO_INVOICE}</p>;
}

function Row({
  r,
  month,
  mode,
  today,
}: {
  r: OverviewRow;
  month: string;
  mode: CommissionMode;
  today: string;
}) {
  const testId = `row-${r.salesperson.id}-${r.currency}`;
  const sums = r.approved ?? r.preview!;
  const inv = r.approved?.salespersonInvoice ?? null;
  const flags = r.preview?.flags ?? [];
  const items = r.approved?.items ?? r.preview!.items;
  const i = t.invoice;
  return (
    <li
      className="rounded-lg border border-stone-200 bg-white p-4 shadow-sm sm:p-5"
      data-testid={testId}
    >
      <div className="flex flex-col gap-3">
        <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
          <div className="min-w-0">
            <p className="font-semibold wrap-anywhere">{r.salesperson.name}</p>
            <p className="text-sm text-stone-600" data-testid={`${testId}-hotels`}>
              {t.hotels(r.hotels)} · {r.currency}
            </p>
          </div>
          <div className="flex flex-col gap-1 sm:items-end">
            <StateBadge state={r.state} testId={`${testId}-state`} />
            {r.state === 'BLOCKED' && !r.conflict && r.preview!.items.length === 0 ? (
              <p className="text-sm text-stone-600" data-testid={`${testId}-amount-pending`}>
                {o.amountPending}
              </p>
            ) : (
              <p className="text-sm text-stone-600">
                {o.amount[r.state]}:{' '}
                <strong className="text-stone-900 tabular-nums" data-testid={`${testId}-amount`}>
                  {financeAmount(rowAmount(r), r.currency)}
                </strong>
              </p>
            )}
          </div>
        </div>

        {/* Blocking reasons stay in the first layer: never hidden behind the detail. */}
        {r.conflict && <Notice>{o.conflict}</Notice>}
        {r.currency !== APPROVABLE_CURRENCY && r.preview && <Notice>{o.nonCzk(r.currency)}</Notice>}
        {flags.length > 0 && <FlagList flags={flags} testId={`${testId}-flags`} mode={mode} />}

        <div data-testid={`${testId}-action`}>
          <Action r={r} month={month} mode={mode} today={today} testId={testId} />
        </div>

        <details data-testid={`${testId}-detail`}>
          <summary className="cursor-pointer text-sm font-medium text-stone-700">
            {o.detail}
          </summary>
          <div className="mt-3 flex flex-col gap-4">
            <p className="text-xs text-stone-500">
              {t.previous(sums.previousPeriod ? monthCs(sums.previousPeriod) : null)}
              {r.approved &&
                ` · ${t.approvedAt(formatDateTimeCs(r.approved.approvedAt), r.approved.approvedByName)}`}
            </p>
            <Balance s={sums} invoiced={inv !== null} testId={`${testId}-balance`} />
            <Deviations
              items={items}
              flags={flags}
              openingBalance={sums.openingBalance}
              currency={r.currency}
              testId={`${testId}-deviations`}
            />
            <section aria-label={t.items(items.length)}>
              <h3 className="mb-2 text-sm font-semibold">{t.items(items.length)}</h3>
              {items.length > 0 ? (
                <Items items={items} currency={r.currency} testId={`${testId}-items`} />
              ) : (
                <p className="text-sm text-stone-600">—</p>
              )}
            </section>
            {inv && (
              <section aria-label={i.heading} data-testid={`${testId}-invoice`}>
                <h3 className="mb-2 text-sm font-semibold">{i.heading}</h3>
                <FieldList>
                  <Field label={i.number}>{inv.invoiceNumber}</Field>
                  <Field label={i.issuedOn}>{financeDate(inv.issuedOn)}</Field>
                  <Field label={i.receivedOn}>{financeDate(inv.receivedOn)}</Field>
                  <Field label={i.base}>{financeAmount(inv.base, inv.currency)}</Field>
                  <Field label={i.payoutOn}>{financeDate(inv.payoutOn)}</Field>
                </FieldList>
                <p className="mt-2 text-xs text-stone-500">
                  {i.recordedAt(formatDateTimeCs(inv.recordedAt), inv.recordedByName)} ·{' '}
                  {i.payoutNote}
                </p>
              </section>
            )}
          </div>
        </details>
      </div>
    </li>
  );
}

function Unresolved({ lines }: { lines: CommissionPreview['unresolved'] }) {
  return (
    <details
      className="rounded-lg border border-stone-200 bg-white p-4"
      data-testid="closing-unresolved"
    >
      <summary className="cursor-pointer text-sm font-medium">
        {o.unresolvedSummary(lines.length)}
      </summary>
      <p className="mt-2 mb-2 text-sm text-stone-600">{t.unresolvedHelp}</p>
      <ul className="flex max-h-[20rem] flex-col gap-1 overflow-auto text-sm">
        {lines.map((u) => (
          <li
            key={`${u.invoiceNumber}#${u.hotelCode}#${u.serviceMonth}#${u.reason}`}
            className="wrap-anywhere"
          >
            {t.unresolved[u.reason]}: {u.invoiceNumber} · {u.hotelCode} · {monthCs(u.serviceMonth)}
          </li>
        ))}
      </ul>
    </details>
  );
}

/** "YYYY-MM-DD" today in Europe/Prague (the default receipt day of a salesperson's invoice). */
function pragueToday(): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Prague' }).format(new Date());
}

/**
 * Obchod → Provize → Měsíční provize (finance:commissions_manage, ADMIN; doc 069 §5–§6): the
 * last closed month by default, one row per salesperson and currency with its current state
 * (merged from the existing preview and approved-statement reads), one fitting action and the
 * detail. An open month, an outage of either source and an empty month are each said as they
 * are; nothing is shown as paid.
 */
export async function CommissionClosing({ month, mode }: { month: string; mode: CommissionMode }) {
  const [preview, approved] = await Promise.all([
    apiGetResult('admin/finance/commissions/preview', commissionPreviewSchema, { month, mode }),
    apiGetResult('admin/finance/commissions/statements', commissionStatementListSchema, {
      month,
      mode,
    }),
  ]);
  const label = monthCs(month);
  const today = pragueToday();
  const rows = overviewRows(preview.ok ? preview.data : null, approved.ok ? approved.data : null);
  const counts = stateCounts(rows);
  const empty = monthIsEmpty(
    { ok: preview.ok, statements: preview.ok ? preview.data.statements : undefined },
    { ok: approved.ok, statements: approved.ok ? approved.data.statements : undefined },
  );
  const notClosed = !preview.ok && preview.code === 'MONTH_NOT_CLOSED';

  return (
    <div className="flex flex-col gap-5">
      <form method="get" className="flex flex-wrap items-end gap-3" data-testid="closing-filter">
        <input type="hidden" name="tab" value="closing" />
        <label className="flex flex-col gap-1 text-sm">
          <span className="font-medium">{t.month}</span>
          <input
            type="month"
            name="month"
            defaultValue={month}
            className="rounded-md border border-stone-300 px-3 py-2"
            data-testid="closing-month"
          />
        </label>
        <label className="flex flex-col gap-1 text-sm">
          <span className="font-medium">{t.mode}</span>
          <select
            name="mode"
            defaultValue={mode}
            className="rounded-md border border-stone-300 px-3 py-2"
            data-testid="closing-mode"
          >
            <option value="TEST">{t.modes.TEST}</option>
            <option value="LIVE">{t.modes.LIVE}</option>
          </select>
        </label>
        <button type="submit" className={buttonClass.secondary} data-testid="closing-show">
          {t.show}
        </button>
      </form>

      <div className="flex flex-col gap-2">
        <p
          className={cn(
            'self-start rounded px-2 py-1 text-xs font-medium',
            mode === 'TEST' ? 'bg-amber-50 text-amber-900' : 'bg-red-50 text-red-900',
          )}
          data-testid={mode === 'TEST' ? 'closing-test-badge' : 'closing-live-badge'}
        >
          {o.modeLabel(mode === 'TEST' ? t.testBadge : o.liveBadge)}
        </p>
        <ol
          aria-label={o.stepsLabel}
          className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm font-medium text-stone-800"
          data-testid="closing-steps"
        >
          {o.steps.map((s, n) => (
            <li key={s} className="flex items-center gap-2">
              {n > 0 && (
                <span aria-hidden="true" className="text-stone-400">
                  →
                </span>
              )}
              <span>
                {n + 1}. {s}
              </span>
            </li>
          ))}
        </ol>
        <p className="text-xs text-stone-500">{t.intro}</p>
      </div>

      {notClosed && (
        <div data-testid="closing-not-closed">
          <Notice tone="info">{t.MONTH_NOT_CLOSED(label, closableFrom(month))}</Notice>
        </div>
      )}
      {!preview.ok && !notClosed && (
        <div data-testid="closing-unavailable">
          <ErrorNote>{preview.status === 400 ? t.invalid : o.previewUnavailable}</ErrorNote>
        </div>
      )}
      {!approved.ok && (
        <div data-testid="closing-approved-unavailable">
          <ErrorNote>{o.approvedUnavailable}</ErrorNote>
        </div>
      )}

      {empty ? (
        <Card testId="closing-empty">
          <EmptyState>{mode === 'LIVE' ? t.liveEmpty : t.noStatements}</EmptyState>
        </Card>
      ) : (
        rows.length > 0 && (
          <section aria-label={o.listHeading(label)} data-testid="closing-list">
            <div className="mb-3 flex flex-wrap items-baseline justify-between gap-2">
              <h2 className="text-base font-semibold">{o.listHeading(label)}</h2>
              <p className="flex flex-wrap gap-x-3 gap-y-1 text-xs" data-testid="closing-counts">
                {ROW_STATES.filter((s) => counts[s]).map((s) => (
                  <span key={s} className="text-stone-600">
                    {o.state[s]}: <strong className="tabular-nums">{counts[s]}</strong>
                  </span>
                ))}
              </p>
            </div>
            <ul className="flex flex-col gap-3">
              {rows.map((r) => (
                <Row key={r.key} r={r} month={month} mode={mode} today={today} />
              ))}
            </ul>
          </section>
        )
      )}

      {preview.ok && preview.data.unresolved.length > 0 && (
        <Unresolved lines={preview.data.unresolved} />
      )}
    </div>
  );
}
