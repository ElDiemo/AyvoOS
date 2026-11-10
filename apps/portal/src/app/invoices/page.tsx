import Link from 'next/link';
import type { PortalInvoicePage } from '@ayvo/types';
import { Shell } from '@/components/shell';
import { cs } from '@/i18n/cs';
import { PortalUnavailable } from '@/lib/backend';
import { portalEnv } from '@/lib/env';
import { formatDate, formatMoney } from '@/lib/format';
import { myInvoices, portalSession } from '@/lib/portal';

export const dynamic = 'force-dynamic';

/** "Faktury": the invoices the session's grants cover (Finance's one predicate), paged. */
export default async function InvoicesPage({
  searchParams,
}: {
  searchParams: Promise<{ page?: string; balicek?: string; from?: string; to?: string }>;
}) {
  const { token, view } = await portalSession();
  const params = await searchParams;
  const page = Math.max(1, Math.min(10_000, Number(params.page) || 1));
  const reason = params.balicek ? cs.invoices.package.reasons[params.balicek] : undefined;
  const monthOr = (v: string | undefined, fallback: string) =>
    v && /^\d{4}-(0[1-9]|1[0-2])$/.test(v) ? v : fallback;
  const now = new Date();
  const thisMonth = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
  const start = new Date(now.getFullYear(), now.getMonth() - 2, 1);
  const threeBack = `${start.getFullYear()}-${String(start.getMonth() + 1).padStart(2, '0')}`;
  let list: PortalInvoicePage | null = null;
  try {
    list = await myInvoices(token, page);
  } catch (error) {
    // Finance down: only this section is unavailable; "Moje hotely" keeps working.
    if (!(error instanceof PortalUnavailable)) throw error;
  }
  const pages = list ? Math.max(1, Math.ceil(list.total / list.pageSize)) : 1;
  return (
    <Shell user={view.user} active="invoices" testInvoices={portalEnv().APP_ENV !== 'production'}>
      <h1 className="text-xl font-semibold">{cs.invoices.title}</h1>
      {!list ? (
        <p role="alert" className="text-sm text-amber-900" data-testid="invoices-unavailable">
          {cs.invoices.unavailable}
        </p>
      ) : list.items.length === 0 ? (
        <section
          className="flex flex-col gap-2 rounded-xl border border-dashed border-stone-300 bg-white p-5 text-sm"
          data-testid="invoices-empty"
        >
          <p className="font-medium text-stone-900">{cs.invoices.none}</p>
          <p className="text-stone-600">
            {cs.invoices.noneHelp}{' '}
            <a
              href={`mailto:${cs.invoices.billingEmail}`}
              className="font-medium text-emerald-900 underline underline-offset-2"
            >
              {cs.invoices.billingEmail}
            </a>
            .
          </p>
        </section>
      ) : (
        <>
          <ul className="flex flex-col gap-2" data-testid="portal-invoices">
            {list.items.map((i) => (
              <li key={i.id} className="rounded-md border border-stone-200 bg-white p-3">
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                  <Link href={`/invoices/${i.id}`} className="font-medium underline">
                    {i.number}
                  </Link>
                  <span className="text-sm font-medium">{formatMoney(i.total, i.currency)}</span>
                </div>
                <p className="text-sm text-stone-600">
                  {i.kind === 'TEST' && (
                    <span className="mr-2 rounded bg-amber-100 px-1 text-xs font-semibold text-amber-900">
                      {cs.invoices.test}
                    </span>
                  )}
                  {formatDate(i.issuedOn)} · {i.hotels.map((h) => h.name).join(', ')} ·{' '}
                  {i.cancelled ? cs.invoices.cancelled : cs.invoices.states[i.paymentState]}
                </p>
              </li>
            ))}
          </ul>
          {pages > 1 && (
            <nav className="flex items-center gap-3 text-sm">
              {page > 1 && <Link href={`/invoices?page=${page - 1}`}>{cs.invoices.previous}</Link>}
              <span>{cs.invoices.page(page, pages)}</span>
              {page < pages && <Link href={`/invoices?page=${page + 1}`}>{cs.invoices.next}</Link>}
            </nav>
          )}
        </>
      )}
      {list && list.total > 0 && (
        <details
          open={reason !== undefined}
          className="group rounded-xl border border-stone-200 bg-white shadow-sm"
          data-testid="invoice-package"
        >
          <summary
            className="flex cursor-pointer list-none items-center justify-between gap-3 rounded-xl px-5 py-4 text-sm font-semibold text-stone-900 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-emerald-800 [&::-webkit-details-marker]:hidden"
            data-testid="invoice-package-open"
          >
            <span id="package-title">{cs.invoices.package.open}</span>
            <span aria-hidden className="text-stone-500 transition-transform group-open:rotate-180">
              ▾
            </span>
          </summary>
          <div className="flex flex-col gap-3 border-t border-stone-100 px-5 pt-3 pb-5">
            <p className="text-xs text-stone-500">{cs.invoices.package.help}</p>
            {reason && (
              <p role="alert" className="text-sm text-amber-900">
                {reason}
              </p>
            )}
            <form
              method="get"
              action="/invoices/package"
              aria-labelledby="package-title"
              className="flex flex-wrap items-end gap-3"
            >
              <label className="flex flex-col gap-1 text-sm">
                <span>{cs.invoices.package.from}</span>
                <input
                  type="month"
                  name="from"
                  required
                  defaultValue={monthOr(params.from, threeBack)}
                  className="rounded-lg border border-stone-300 bg-white px-3 py-2 text-sm"
                />
              </label>
              <label className="flex flex-col gap-1 text-sm">
                <span>{cs.invoices.package.to}</span>
                <input
                  type="month"
                  name="to"
                  required
                  defaultValue={monthOr(params.to, thisMonth)}
                  className="rounded-lg border border-stone-300 bg-white px-3 py-2 text-sm"
                />
              </label>
              <button
                type="submit"
                className="rounded-lg bg-emerald-900 px-4 py-2 text-sm font-semibold text-white hover:bg-emerald-800 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-emerald-800"
              >
                {cs.invoices.package.submit}
              </button>
            </form>
          </div>
        </details>
      )}
    </Shell>
  );
}
