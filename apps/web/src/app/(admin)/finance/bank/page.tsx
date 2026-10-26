import {
  bankStatusSchema,
  bankTransactionListQuerySchema,
  bankTransactionPageSchema,
  type BankSyncRun,
  type BankTransaction,
} from '@ayvo/types';
import { cn } from '@ayvo/ui';
import Link from 'next/link';
import { BankSyncButton } from '@/components/finance/bank-sync-button';
import { financeAmount, financeDate } from '@/components/finance/finance-format';
import {
  buttonClass,
  Card,
  EmptyState,
  ErrorNote,
  inputClass,
  Notice,
  PageHeader,
} from '@/components/ui';
import { financeCs } from '@/i18n/cs/finance';
import { apiGet } from '@/lib/api';
import { hasPermission, requirePermission } from '@/lib/session';

export const dynamic = 'force-dynamic';
const t = financeCs.bank;
type Params = Record<string, string | undefined>;

/** A moment as its Prague calendar day ("26. 10. 2026"). */
const pragueDay = (iso: string | null) =>
  iso
    ? financeDate(
        new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Prague' }).format(new Date(iso)),
      )
    : '—';
const pragueTime = (iso: string) =>
  new Intl.DateTimeFormat('cs-CZ', {
    timeZone: 'Europe/Prague',
    day: 'numeric',
    month: 'numeric',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(iso));

/**
 * Bankovní pohyby (N3B-1, doc 041): the company accounts' transactions read from RB Premium API
 * (read only), the state of the connection — the certificate's readability and expiry, the last
 * success and the last failure of each account, never a secret — and, for finance:bank_sync, the
 * button to read new ones. Not paired with invoices yet (that comes with issued invoices).
 */
export default async function BankTransactionsPage({
  searchParams,
}: {
  searchParams: Promise<Params>;
}) {
  const me = await requirePermission('finance:bank_read');
  const canSync = hasPermission(me, 'finance:bank_sync');
  const raw = await searchParams;
  const q = bankTransactionListQuerySchema.parse({});
  for (const [key, value] of Object.entries(raw)) {
    if (!value) continue;
    const one = bankTransactionListQuerySchema.safeParse({ [key]: value });
    if (one.success) Object.assign(q, { [key]: one.data[key as keyof typeof one.data] });
  }
  const [status, page] = await Promise.all([
    apiGet('admin/finance/bank/status', bankStatusSchema),
    apiGet('admin/finance/bank/transactions', bankTransactionPageSchema, {
      account: q.account,
      direction: q.direction,
      from: q.from,
      to: q.to,
      page: q.page,
    }),
  ]);
  const pages = Math.max(1, Math.ceil(page.total / page.pageSize));
  const filtered = !!(q.account || q.direction || q.from || q.to);
  const link = (p: number) =>
    `/finance/bank?${new URLSearchParams(
      Object.entries({ ...raw, page: String(p) }).filter((e): e is [string, string] => !!e[1]),
    ).toString()}`;
  const notAfter = status.certificate.notAfter;
  const expiresSoon = expiresWithin30Days(notAfter);
  const filterLabel =
    'flex min-w-0 flex-col gap-1 text-xs font-medium uppercase tracking-wide text-stone-500';

  return (
    <>
      <PageHeader title={t.title} subtitle={t.subtitle} />
      <div className="flex flex-col gap-6">
        <Card title={t.connection} testId="bank-connection">
          {status.environment === null ? (
            <Notice tone="info">{t.notConfigured}</Notice>
          ) : (
            <div className="flex flex-col gap-4">
              {status.environment !== 'PRODUCTION' && (
                <Notice>{t.environment[status.environment]}</Notice>
              )}
              <p className="text-sm" data-testid="bank-certificate">
                <span className="text-stone-500">{t.certificate.label}: </span>
                {status.certificate.state === 'READABLE'
                  ? t.certificate.READABLE(notAfter ? pragueDay(notAfter) : '—')
                  : t.certificate[status.certificate.state]}
              </p>
              {expiresSoon && <Notice>{t.certificate.expiresSoon(pragueDay(notAfter))}</Notice>}
              <ul className="divide-y divide-stone-100 text-sm" data-testid="bank-accounts">
                {status.accounts.map((a) => (
                  <li key={`${a.accountNumber}/${a.currency}`} className="flex flex-col gap-1 py-2">
                    <span className="font-medium">
                      {t.account} {a.accountNumber} · {a.currency}
                    </span>
                    <span className="text-stone-600">
                      {t.lastSuccess}: {a.lastSuccess ? runLine(a.lastSuccess) : t.never}
                    </span>
                    {a.lastRun?.status === 'RUNNING' && (
                      <span className="text-stone-600">{t.running}</span>
                    )}
                    {a.lastRun?.status === 'FAILED' && (
                      <ErrorNote>
                        {t.lastFailure} ({pragueTime(a.lastRun.startedAt)}):{' '}
                        {a.lastRun.errorCode ? t.errors[a.lastRun.errorCode] : ''}
                      </ErrorNote>
                    )}
                  </li>
                ))}
              </ul>
              {canSync && <BankSyncButton />}
            </div>
          )}
        </Card>
        <Card>
          <form method="get" className="flex flex-col gap-4" data-testid="bank-filters">
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-4">
              <label className={filterLabel}>
                {t.list.account}
                <select
                  name="account"
                  defaultValue={q.account ?? ''}
                  className={cn(inputClass, 'normal-case tracking-normal')}
                >
                  <option value="">{t.list.any}</option>
                  {status.accounts.map((a) => (
                    <option
                      key={`${a.accountNumber}/${a.currency}`}
                      value={`${a.accountNumber}/${a.currency}`}
                    >
                      {a.accountNumber} · {a.currency}
                    </option>
                  ))}
                </select>
              </label>
              <label className={filterLabel}>
                {t.list.direction}
                <select
                  name="direction"
                  defaultValue={q.direction ?? ''}
                  className={cn(inputClass, 'normal-case tracking-normal')}
                >
                  <option value="">{t.list.any}</option>
                  <option value="CRDT">{t.list.CRDT}</option>
                  <option value="DBIT">{t.list.DBIT}</option>
                </select>
              </label>
              <label className={filterLabel}>
                {t.list.from}
                <input
                  type="date"
                  name="from"
                  defaultValue={q.from ?? ''}
                  className={cn(inputClass, 'normal-case tracking-normal')}
                />
              </label>
              <label className={filterLabel}>
                {t.list.to}
                <input
                  type="date"
                  name="to"
                  defaultValue={q.to ?? ''}
                  className={cn(inputClass, 'normal-case tracking-normal')}
                />
              </label>
            </div>
            <div className="flex flex-wrap gap-2">
              <button type="submit" className={buttonClass.primary}>
                {t.list.filter}
              </button>
              {filtered && (
                <Link href="/finance/bank" className={buttonClass.secondary}>
                  {t.list.reset}
                </Link>
              )}
            </div>
          </form>
        </Card>
        <Card title={t.list.total(page.total)} testId="bank-transactions">
          {page.items.length === 0 ? (
            <EmptyState>{filtered ? t.list.emptyFiltered : t.list.empty}</EmptyState>
          ) : (
            <>
              {/* A table on a computer, cards on a phone. */}
              <table className="hidden w-full text-sm md:table">
                <thead className="text-left text-xs uppercase tracking-wide text-stone-500">
                  <tr>
                    <th className="py-2 pr-3 font-medium">{t.fields.date}</th>
                    <th className="py-2 pr-3 text-right font-medium">{t.fields.amount}</th>
                    <th className="py-2 pr-3 font-medium">{t.fields.counterparty}</th>
                    <th className="py-2 pr-3 font-medium">{t.fields.symbols}</th>
                    <th className="py-2 pr-3 font-medium">{t.fields.message}</th>
                    <th className="py-2 font-medium">{t.fields.processing}</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-stone-100">
                  {page.items.map((x) => (
                    <tr key={x.id} data-testid="bank-transaction">
                      <td className="py-2 pr-3 whitespace-nowrap">
                        {pragueDay(x.bookingDate ?? x.valueDate)}
                      </td>
                      <td className="py-2 pr-3 text-right whitespace-nowrap tabular-nums">
                        {financeAmount(x.amount, x.amountCurrency)}
                      </td>
                      <td className="py-2 pr-3">
                        <Party x={x} />
                      </td>
                      <td className="py-2 pr-3 font-mono text-xs">{symbols(x)}</td>
                      <td className="py-2 pr-3 wrap-anywhere">{x.message ?? '—'}</td>
                      <td className="py-2">
                        {t.processing[x.processing]}
                        {x.version > 1 && (
                          <span className="block text-xs text-stone-500">{t.changed}</span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <ul className="flex flex-col gap-3 md:hidden">
                {page.items.map((x) => (
                  <li
                    key={x.id}
                    className="rounded-md border border-stone-200 p-3 text-sm"
                    data-testid="bank-transaction-card"
                  >
                    <span className="flex justify-between gap-2">
                      <span>{pragueDay(x.bookingDate ?? x.valueDate)}</span>
                      <span className="font-medium tabular-nums">
                        {financeAmount(x.amount, x.amountCurrency)}
                      </span>
                    </span>
                    <span className="mt-1 block">
                      <Party x={x} />
                    </span>
                    <span className="mt-1 block font-mono text-xs">{symbols(x)}</span>
                    {x.message && (
                      <span className="mt-1 block wrap-anywhere text-stone-600">{x.message}</span>
                    )}
                    <span className="mt-1 block text-xs text-stone-500">
                      {t.processing[x.processing]}
                    </span>
                  </li>
                ))}
              </ul>
            </>
          )}
          {pages > 1 && (
            <nav className="mt-4 flex items-center justify-between text-sm">
              {page.page > 1 ? <Link href={link(page.page - 1)}>{t.list.previous}</Link> : <span />}
              <span className="text-stone-500">{t.list.page(page.page, pages)}</span>
              {page.page < pages ? <Link href={link(page.page + 1)}>{t.list.next}</Link> : <span />}
            </nav>
          )}
        </Card>
      </div>
    </>
  );
}

/** The certificate's expiry is near (30 days): said in advance, as the bank asks. */
function expiresWithin30Days(notAfter: string | null, now = new Date()) {
  return notAfter !== null && Date.parse(notAfter) - now.getTime() < 30 * 86_400_000;
}

function runLine(r: BankSyncRun) {
  return `${pragueTime(r.finishedAt ?? r.startedAt)} · ${t.window(financeDate(r.fromDate), financeDate(r.toDate))}`;
}

function symbols(x: BankTransaction) {
  if (!x.variableSymbol && !x.constantSymbol && !x.specificSymbol) return '—';
  return [x.variableSymbol, x.constantSymbol, x.specificSymbol].map((s) => s ?? '–').join(' / ');
}

function Party({ x }: { x: BankTransaction }) {
  const { name, account, iban } = x.counterparty;
  if (!name && !account && !iban) return <>—</>;
  return (
    <span className="flex min-w-0 flex-col">
      {name && <span className="wrap-anywhere">{name}</span>}
      {(account ?? iban) && (
        <span className="font-mono text-xs text-stone-500 wrap-anywhere">{account ?? iban}</span>
      )}
    </span>
  );
}
