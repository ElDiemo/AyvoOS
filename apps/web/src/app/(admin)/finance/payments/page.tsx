import { PAYMENT_FILTERS, paymentsPageSchema, paymentsQuerySchema } from '@ayvo/types';
import Link from 'next/link';
import { financeAmount, financeDate } from '@/components/finance/finance-format';
import { FinanceHeader } from '@/components/finance/finance-header';
import { ImportBankButton, SimulateStatementForm } from '@/components/finance/payment-forms';
import { buttonClass, Card, inputClass, Notice } from '@/components/ui';
import { financeCs } from '@/i18n/cs/finance';
import { apiGet } from '@/lib/api';
import { hasPermission, requirePermission } from '@/lib/session';

export const dynamic = 'force-dynamic';
const t = financeCs.payments;

/**
 * Platby a přiřazení (N3B-2, doc 041 §8; a view of Banka a platby, doc 042): incoming payments,
 * their matching and allocations. The list comes first; recording payments from the bank
 * transactions already read is the one action above it, the DEV simulation a closed block below
 * (never in production). Each payment is an anchor (#P-…) for the invoice detail's links.
 */
export default async function PaymentsPage({
  searchParams,
}: {
  searchParams: Promise<{ filter?: string; q?: string; page?: string }>;
}) {
  const me = await requirePermission('finance:invoices_read');
  const canManage = hasPermission(me, 'finance:payments_manage');
  const canBank = hasPermission(me, 'finance:bank_read');
  const params = await searchParams;
  const parsed = paymentsQuerySchema.safeParse(params);
  const query = parsed.success ? parsed.data : {};
  const page = await apiGet('admin/finance/payments', paymentsPageSchema, {
    filter: query.filter,
    q: query.q,
    page: query.page,
  });
  const urlOf = (over: { filter?: string; page?: number }) => {
    const u = new URLSearchParams();
    const filter = 'filter' in over ? over.filter : query.filter;
    if (filter) u.set('filter', filter);
    if (query.q) u.set('q', query.q);
    if (over.page && over.page > 1) u.set('page', String(over.page));
    const text = u.toString();
    return `/finance/payments${text ? `?${text}` : ''}`;
  };
  const from = (page.page - 1) * page.pageSize + 1;
  const to = Math.min(page.page * page.pageSize, page.total);
  return (
    <>
      <FinanceHeader active="bank" view="payments" title={t.title} subtitle={t.subtitle} />
      <div className="flex flex-col gap-6">
        {/* Where payments come from, and (finance:payments_manage) the one action that records them. */}
        <div
          className="flex flex-col gap-3 rounded-lg border border-stone-200 bg-white p-4 text-sm shadow-sm"
          data-testid="payments-from-bank"
        >
          <p className="text-stone-600">
            {t.fromBank} {/* A link only for whom the page opens (review FIN90-R3). */}
            {canBank ? (
              <Link href="/finance/bank" className="underline">
                {financeCs.bank.title}
              </Link>
            ) : (
              financeCs.bank.title
            )}
            .
          </p>
          {canManage && <ImportBankButton />}
        </div>
        <nav
          aria-label={t.filters.ALL}
          className="flex flex-wrap gap-2 text-sm"
          data-testid="payments-filters"
        >
          {[undefined, ...PAYMENT_FILTERS].map((f) => (
            <Link
              key={f ?? 'ALL'}
              href={urlOf({ filter: f })}
              aria-current={query.filter === f ? 'page' : undefined}
              className={query.filter === f ? buttonClass.primary : buttonClass.secondary}
              data-testid={`payments-filter-${f ?? 'ALL'}`}
            >
              {t.filters[f ?? 'ALL']}
            </Link>
          ))}
        </nav>
        <form className="flex flex-wrap items-end gap-2 text-sm" data-testid="payments-search">
          {query.filter && <input type="hidden" name="filter" value={query.filter} />}
          <label className="flex min-w-0 flex-1 flex-col gap-1 font-medium">
            {t.searchLabel}
            <input
              name="q"
              defaultValue={query.q ?? ''}
              maxLength={80}
              placeholder={t.searchHint}
              className={inputClass}
              data-testid="payments-q"
            />
          </label>
          <button type="submit" className={buttonClass.secondary} data-testid="payments-q-submit">
            {t.search}
          </button>
        </form>
        <Card testId="payments">
          <p className="mb-2 text-xs text-stone-500" data-testid="payments-found">
            {t.found(page.total, from, to)}
          </p>
          {page.payments.length === 0 ? (
            <p className="py-2 text-sm text-stone-600">{t.empty}</p>
          ) : (
            <ul className="divide-y divide-stone-100 text-sm">
              {page.payments.map((p) => {
                // The matching result is history; once a person allocated it, it is settled.
                const review =
                  p.matchResult !== 'MATCHED' && p.matchResult !== 'PARTIAL_OVERPAYMENT';
                const resolved = review && p.state === 'ALLOCATED';
                return (
                  <li
                    key={p.code}
                    id={p.code}
                    className="grid scroll-mt-24 grid-cols-2 gap-x-4 gap-y-1 py-2 target:bg-amber-50 lg:grid-cols-[7rem_6rem_7rem_8rem_1fr_11rem]"
                    data-testid={`payment-${p.code}`}
                  >
                    <Link
                      href={`/finance/payments/${p.code}`}
                      className="font-mono underline"
                      data-testid={`payment-${p.code}-open`}
                    >
                      {p.code}
                    </Link>
                    <span>{financeDate(p.bookedOn)}</span>
                    <span className="font-semibold tabular-nums">
                      {financeAmount(p.amount, p.currency)}
                    </span>
                    <span>
                      {t.variableSymbol} {p.variableSymbol ?? '—'}
                    </span>
                    <span className="col-span-2 min-w-0 break-words text-stone-600 lg:col-span-1">
                      {p.counterpartyName ?? '—'}
                      {review && !resolved && (
                        <span
                          className="block text-amber-800"
                          data-testid={`payment-${p.code}-result`}
                        >
                          {t.result[p.matchResult]}
                        </span>
                      )}
                    </span>
                    <span className="col-span-2 font-medium lg:col-span-1">
                      <span data-testid={`payment-${p.code}-state`}>{t.state[p.state]}</span>
                      {p.bankChangedSinceRecorded && (
                        <span
                          className="block text-red-800"
                          data-testid={`payment-${p.code}-bank-changed`}
                        >
                          {t.filters.CHANGED}
                        </span>
                      )}
                    </span>
                  </li>
                );
              })}
            </ul>
          )}
          {page.total > page.pageSize && (
            <nav className="mt-3 flex gap-2 text-sm" data-testid="payments-pages">
              {page.page > 1 && (
                <Link href={urlOf({ page: page.page - 1 })} className={buttonClass.secondary}>
                  {t.previous}
                </Link>
              )}
              {to < page.total && (
                <Link
                  href={urlOf({ page: page.page + 1 })}
                  className={buttonClass.secondary}
                  data-testid="payments-next"
                >
                  {t.next}
                </Link>
              )}
            </nav>
          )}
        </Card>
        {canManage && page.simulationAvailable && (
          <details
            className="rounded-lg border border-dashed border-stone-300 bg-white p-4 text-sm"
            data-testid="payments-simulation"
          >
            <summary className="cursor-pointer font-medium">{t.simulateTitle}</summary>
            <div className="mt-4 flex flex-col gap-4">
              <Notice tone="info">{t.simulationNote}</Notice>
              <SimulateStatementForm />
            </div>
          </details>
        )}
      </div>
    </>
  );
}
