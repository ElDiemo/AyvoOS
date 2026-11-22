import {
  commissionPreviewSchema,
  commissionStatementListSchema,
  type CommissionItem,
  type CommissionMode,
  type CommissionStatement,
  type CommissionStatementPreview,
} from '@ayvo/types';
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
import {
  causeLabel,
  closableFrom,
  deviations,
  flagLabel,
  hotelCount,
  refusalText,
} from './commission-closing-format';
import { monthCs, rateCs } from './commission-format';
import { SalespersonInvoiceForm } from './salesperson-invoice-form';

const t = commissionsCs.closing;

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
    <div className="overflow-x-auto">
      <table className="w-full text-left text-sm" data-testid={testId}>
        <thead className="text-xs text-stone-500">
          <tr>
            {[c.cause, c.invoice, c.hotel, c.serviceMonth, c.base, c.k, c.rate, c.amount].map(
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
              <td className="py-2 pr-3">{causeLabel(i)}</td>
              <td className="py-2 pr-3 wrap-anywhere">{i.invoiceNumber}</td>
              <td className="py-2 pr-3 wrap-anywhere">{i.hotelCode}</td>
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

function Balance({
  s,
  testId,
}: {
  s: Pick<
    CommissionStatementPreview,
    | 'openingBalance'
    | 'total'
    | 'closingBalance'
    | 'amountToInvoice'
    | 'carriedForward'
    | 'currency'
  >;
  testId: string;
}) {
  const b = t.balance;
  return (
    <div data-testid={testId}>
      <FieldList>
        <Field label={b.opening}>{financeAmount(s.openingBalance, s.currency)}</Field>
        <Field label={b.total}>{financeAmount(s.total, s.currency)}</Field>
        <Field label={b.closing}>{financeAmount(s.closingBalance, s.currency)}</Field>
        <Field label={b.toInvoice}>
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

function PreviewCard({
  s,
  month,
  mode,
}: {
  s: CommissionStatementPreview;
  month: string;
  mode: CommissionMode;
}) {
  const d = deviations(s);
  const testId = `preview-${s.salesperson.id}`;
  return (
    <Card
      title={`${s.salesperson.name} · ${t.hotels(hotelCount([...s.items, ...s.flags]))}`}
      testId={testId}
    >
      <div className="flex flex-col gap-4">
        <p className="text-xs text-stone-500">
          {t.previous(s.previousPeriod ? monthCs(s.previousPeriod) : null)}
        </p>
        <Balance s={s} testId={`${testId}-balance`} />
        <section aria-label={t.deviations} data-testid={`${testId}-deviations`}>
          <h3 className="mb-2 text-sm font-semibold">{t.deviations}</h3>
          {d.corrections.length === 0 && d.flags.length === 0 && !d.carriedIn ? (
            <p className="text-sm text-stone-600">{t.noDeviations}</p>
          ) : (
            <ul className="flex flex-col gap-1 text-sm">
              {d.carriedIn && <li>{t.openingNote(financeAmount(d.carriedIn, s.currency))}</li>}
              {d.corrections.map((c) => (
                <li key={`${c.invoiceNumber}#${c.lineNo}#${c.cause}`}>
                  {causeLabel(c)}: {c.invoiceNumber} · {c.hotelCode} · {monthCs(c.serviceMonth)} ·{' '}
                  {financeAmount(c.amount, s.currency)}
                </li>
              ))}
              {d.flags.map((f) => (
                <li
                  key={`${f.code}#${f.invoiceNumber}#${f.hotelCode}`}
                  className="text-amber-900"
                  data-testid={`${testId}-flag`}
                >
                  {flagLabel(f, monthCs)}: {f.invoiceNumber} · {f.hotelCode} ·{' '}
                  {monthCs(f.serviceMonth)}
                </li>
              ))}
              {d.corrections.length > 0 && (
                <li className="text-xs text-stone-500">{t.correctionNote}</li>
              )}
            </ul>
          )}
        </section>
        {s.items.length > 0 && (
          <details>
            <summary className="cursor-pointer text-sm font-medium">
              {t.items(s.items.length)}
            </summary>
            <div className="mt-2">
              <Items items={s.items} currency={s.currency} testId={`${testId}-items`} />
            </div>
          </details>
        )}
        <CommissionApprove
          month={month}
          monthLabel={monthCs(month)}
          mode={mode}
          salesperson={s.salesperson}
          currency={s.currency}
          fingerprint={s.fingerprint}
          amountLabel={financeAmount(s.amountToInvoice, s.currency)}
          blocked={d.blocked}
        />
      </div>
    </Card>
  );
}

function ApprovedCard({ s, today }: { s: CommissionStatement; today: string }) {
  const testId = `approved-${s.salesperson.id}`;
  const inv = s.salespersonInvoice;
  const i = t.invoice;
  const amount = financeAmount(s.amountToInvoice, s.currency);
  return (
    <Card title={`${s.salesperson.name} · ${t.hotels(hotelCount(s.items))}`} testId={testId}>
      <div className="flex flex-col gap-4">
        <p className="text-xs text-stone-500">
          {t.approvedAt(formatDateTimeCs(s.approvedAt), s.approvedByName)}
        </p>
        <Balance s={s} testId={`${testId}-balance`} />
        <details>
          <summary className="cursor-pointer text-sm font-medium">
            {t.items(s.items.length)}
          </summary>
          <div className="mt-2">
            <Items items={s.items} currency={s.currency} testId={`${testId}-items`} />
          </div>
        </details>
        <section aria-label={i.heading} data-testid={`${testId}-invoice`}>
          <h3 className="mb-2 text-sm font-semibold">{i.heading}</h3>
          {inv ? (
            <div className="flex flex-col gap-2">
              <FieldList>
                <Field label={i.number}>{inv.invoiceNumber}</Field>
                <Field label={i.issuedOn}>{financeDate(inv.issuedOn)}</Field>
                <Field label={i.receivedOn}>{financeDate(inv.receivedOn)}</Field>
                <Field label={i.base}>{financeAmount(inv.base, inv.currency)}</Field>
                <Field label={i.payoutOn}>
                  <strong data-testid={`${testId}-payout`}>{financeDate(inv.payoutOn)}</strong>
                </Field>
              </FieldList>
              <p className="text-xs text-stone-500">
                {i.recordedAt(formatDateTimeCs(inv.recordedAt), inv.recordedByName)} ·{' '}
                {i.payoutNote}
              </p>
            </div>
          ) : s.amountToInvoice === '0.00' ? (
            <p className="text-sm text-stone-600">{i.nothing}</p>
          ) : (
            <SalespersonInvoiceForm statementId={s.id} amountLabel={amount} today={today} />
          )}
        </section>
      </div>
    </Card>
  );
}

/** "YYYY-MM-DD" today in Europe/Prague (the default receipt day of a salesperson's invoice). */
function pragueToday(): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Prague' }).format(new Date());
}

/**
 * Obchod → Provize → Uzávěrka (finance:commissions_manage, ADMIN; doc 069 §5–§6, PR 2e): the
 * preview of a closed month from Finance, per salesperson with its deviations, the approval bound
 * to that preview, the approved statements and the salesperson's invoice with the planned payout
 * day. An open month and an outage are said as they are; nothing is shown as paid.
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

  let previewBody: React.ReactNode;
  if (preview.ok) {
    const p = preview.data;
    previewBody = (
      <div className="flex flex-col gap-4">
        {p.statements.length === 0 ? (
          <Card title={t.previewHeading(label)} testId="closing-preview">
            <EmptyState>{mode === 'LIVE' ? t.liveEmpty : t.noStatements}</EmptyState>
          </Card>
        ) : (
          <section aria-label={t.previewHeading(label)} data-testid="closing-preview">
            <h2 className="mb-3 text-base font-semibold">{t.previewHeading(label)}</h2>
            <div className="flex flex-col gap-4">
              {p.statements.map((s) => (
                <PreviewCard
                  key={`${s.salesperson.id}|${s.currency}`}
                  s={s}
                  month={month}
                  mode={mode}
                />
              ))}
            </div>
          </section>
        )}
        {p.unresolved.length > 0 && (
          <Card title={t.unresolvedHeading} testId="closing-unresolved">
            <p className="mb-2 text-sm text-stone-600">{t.unresolvedHelp}</p>
            <ul className="flex flex-col gap-1 text-sm">
              {p.unresolved.map((u) => (
                <li key={`${u.invoiceNumber}#${u.hotelCode}#${u.serviceMonth}#${u.reason}`}>
                  {t.unresolved[u.reason]}: {u.invoiceNumber} · {u.hotelCode} ·{' '}
                  {monthCs(u.serviceMonth)}
                </li>
              ))}
            </ul>
          </Card>
        )}
      </div>
    );
  } else if (preview.code === 'MONTH_NOT_CLOSED') {
    previewBody = (
      <div data-testid="closing-not-closed">
        <Notice tone="info">{t.MONTH_NOT_CLOSED(label, closableFrom(month))}</Notice>
      </div>
    );
  } else {
    previewBody = (
      <div data-testid="closing-unavailable">
        <ErrorNote>
          {refusalText(
            { MONTH_NOT_CLOSED: t.MONTH_NOT_CLOSED(label, closableFrom(month)) },
            preview.code,
            preview.status === 400 ? t.invalid : t.unavailable,
          )}
        </ErrorNote>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-6">
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
      <p className="text-sm text-stone-600">{t.intro}</p>
      {mode === 'TEST' && (
        <p
          className="self-start rounded bg-amber-50 px-2 py-1 text-xs font-medium text-amber-900"
          data-testid="closing-test-badge"
        >
          {t.testBadge}
        </p>
      )}
      {previewBody}
      <section aria-label={t.approvedHeading(label)} data-testid="closing-approved">
        <h2 className="mb-3 text-base font-semibold">{t.approvedHeading(label)}</h2>
        {approved.ok ? (
          approved.data.statements.length === 0 ? (
            <Card>
              <EmptyState>{t.noApproved}</EmptyState>
            </Card>
          ) : (
            <div className="flex flex-col gap-4">
              {approved.data.statements.map((s) => (
                <ApprovedCard key={s.id} s={s} today={today} />
              ))}
            </div>
          )
        ) : (
          <ErrorNote>{t.unavailable}</ErrorNote>
        )}
      </section>
    </div>
  );
}
