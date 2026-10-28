import {
  financeDocumentListQuerySchema,
  financeDocumentPageSchema,
  type FinanceDocument,
} from '@ayvo/types';
import { cn } from '@ayvo/ui';
import Link from 'next/link';
import {
  fileSize,
  financeAmount,
  financeDate,
  financeMonth,
} from '@/components/finance/finance-format';
import { MissingBadge } from '@/components/finance/missing-badge';
import { buttonClass, Card, inputClass } from '@/components/ui';
import { FinanceHeader } from '@/components/finance/finance-header';
import { financeCs as t } from '@/i18n/cs/finance';
import { apiGet } from '@/lib/api';
import { hasPermission, requirePermission } from '@/lib/session';

export const dynamic = 'force-dynamic';

type Params = Record<string, string | undefined>;

/**
 * Přijaté doklady (doc 039, N1): the default Finance screen is the list itself (UI-02) — search and
 * filters as a plain GET form (the URL keeps them), pages of 50, newest first; "K doplnění" marks
 * what the export still needs. Receiving a PDF (Nahrát doklad) and taking over a supplier document
 * of Sklad (Převzít ze skladu) are actions above it, each on its own page of the module.
 */
export default async function FinanceDocumentsPage({
  searchParams,
}: {
  searchParams: Promise<Params>;
}) {
  const raw = await searchParams;
  // Every filter on its own: one invalid value never drops the others.
  const q = financeDocumentListQuerySchema.parse({});
  for (const [key, value] of Object.entries(raw)) {
    if (!value) continue;
    const one = financeDocumentListQuerySchema.safeParse({ [key]: value });
    if (one.success) Object.assign(q, { [key]: one.data[key as keyof typeof one.data] });
  }
  const me = await requirePermission('finance:documents_read');
  const canManage = hasPermission(me, 'finance:documents_manage');
  const canTakeOver = canManage && hasPermission(me, 'procurement:documents_read');
  const [page] = await Promise.all([
    apiGet('admin/finance/documents', financeDocumentPageSchema, {
      q: q.q,
      supplierId: q.supplierId,
      status: q.status,
      issuedFrom: q.issuedFrom,
      issuedTo: q.issuedTo,
      handoverMonth: q.handoverMonth,
      incomplete: q.incomplete,
      page: q.page,
    }),
  ]);
  const pages = Math.max(1, Math.ceil(page.total / page.pageSize));
  const filtered = !!(
    q.q ||
    q.supplierId ||
    q.status ||
    q.issuedFrom ||
    q.issuedTo ||
    q.handoverMonth ||
    q.incomplete
  );
  const advanced = !!(q.status || q.issuedFrom || q.issuedTo || q.handoverMonth);
  const link = (p: number) =>
    `/finance/documents?${new URLSearchParams(
      Object.entries({ ...raw, page: String(p) }).filter((e): e is [string, string] => !!e[1]),
    ).toString()}`;
  const filterLabel =
    'flex min-w-0 flex-col gap-1 text-xs font-medium uppercase tracking-wide text-stone-500';

  return (
    <>
      <FinanceHeader
        active="documents"
        title={t.title}
        subtitle={t.subtitle}
        actions={
          (canManage || canTakeOver) && (
            <div className="flex flex-wrap gap-2">
              {canManage && (
                <Link
                  href="/finance/documents/new"
                  className={buttonClass.primary}
                  data-testid="finance-upload"
                >
                  {t.list.upload}
                </Link>
              )}
              {canTakeOver && (
                <Link
                  href="/finance/documents/take-over"
                  className={buttonClass.secondary}
                  data-testid="finance-take-over-link"
                >
                  {t.list.takeOver}
                </Link>
              )}
            </div>
          )
        }
      />
      <div className="flex flex-col gap-6">
        <form
          method="get"
          className="flex flex-col gap-3 rounded-lg border border-stone-200 bg-white p-4 shadow-sm"
          data-testid="finance-filters"
        >
          <div className="flex flex-col gap-3 sm:flex-row sm:items-end">
            <label className={cn(filterLabel, 'sm:flex-1')}>
              {t.list.search}
              <input
                type="search"
                name="q"
                defaultValue={q.q ?? ''}
                placeholder={t.list.searchPlaceholder}
                maxLength={100}
                className={cn(inputClass, 'normal-case tracking-normal')}
              />
            </label>
            <label className="flex items-center gap-2 text-sm sm:pb-2">
              <input
                type="checkbox"
                name="incomplete"
                value="true"
                defaultChecked={q.incomplete === 'true'}
              />
              {t.list.onlyIncomplete}
            </label>
            <div className="flex flex-wrap gap-2">
              <button type="submit" className={buttonClass.primary}>
                {t.list.filter}
              </button>
              {filtered && (
                <Link href="/finance/documents" className={buttonClass.secondary}>
                  {t.list.reset}
                </Link>
              )}
            </div>
          </div>
          <details open={advanced} data-testid="finance-filters-more">
            <summary className="cursor-pointer text-sm text-stone-600">
              {advanced ? t.list.moreFiltersActive : t.list.moreFilters}
            </summary>
            <div className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-4">
              <label className={filterLabel}>
                {t.fields.status}
                <select
                  name="status"
                  defaultValue={q.status ?? ''}
                  className={cn(inputClass, 'normal-case tracking-normal')}
                >
                  <option value="">{t.list.any}</option>
                  <option value="ACTIVE">{t.status.ACTIVE}</option>
                  <option value="VOIDED">{t.status.VOIDED}</option>
                </select>
              </label>
              <label className={filterLabel}>
                {t.list.month}
                <input
                  type="month"
                  name="handoverMonth"
                  defaultValue={q.handoverMonth ?? ''}
                  className={cn(inputClass, 'normal-case tracking-normal')}
                />
              </label>
              <label className={filterLabel}>
                {t.list.from}
                <input
                  type="date"
                  name="issuedFrom"
                  defaultValue={q.issuedFrom ?? ''}
                  className={cn(inputClass, 'normal-case tracking-normal')}
                />
              </label>
              <label className={filterLabel}>
                {t.list.to}
                <input
                  type="date"
                  name="issuedTo"
                  defaultValue={q.issuedTo ?? ''}
                  className={cn(inputClass, 'normal-case tracking-normal')}
                />
              </label>
            </div>
          </details>
        </form>
        <Card title={t.list.total(page.total)} testId="finance-documents">
          {page.items.length === 0 ? (
            <p className="py-2 text-sm text-stone-600">
              {filtered ? t.list.emptyFiltered : t.list.empty}
            </p>
          ) : (
            <>
              {/* A table on a computer, cards on a phone. */}
              <table className="hidden w-full text-sm md:table">
                <thead className="text-left text-xs uppercase tracking-wide text-stone-500">
                  <tr>
                    <th className="py-2 pr-3 font-medium">{t.fields.code}</th>
                    <th className="py-2 pr-3 font-medium">{t.fields.supplier}</th>
                    <th className="py-2 pr-3 font-medium">{t.fields.documentNumber}</th>
                    <th className="py-2 pr-3 font-medium">{t.fields.issuedOn}</th>
                    <th className="py-2 pr-3 font-medium">{t.fields.handoverMonth}</th>
                    <th className="py-2 pr-3 text-right font-medium">{t.fields.amount}</th>
                    <th className="py-2 font-medium">{t.fields.status}</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-stone-100">
                  {page.items.map((d) => (
                    <tr key={d.id} className={d.status === 'VOIDED' ? 'text-stone-400' : ''}>
                      <td className="py-2 pr-3 font-mono">
                        <Link href={`/finance/documents/${d.code}`} className="underline">
                          {d.code}
                        </Link>
                      </td>
                      <td className="py-2 pr-3">{d.supplier?.name ?? t.detail.empty}</td>
                      <td className="py-2 pr-3">
                        {t.kinds[d.kind]} {d.documentNumber ?? ''}
                      </td>
                      <td className="py-2 pr-3">{financeDate(d.issuedOn)}</td>
                      <td className="py-2 pr-3">{financeMonth(d.handoverMonth)}</td>
                      <td className="py-2 pr-3 text-right tabular-nums">
                        {financeAmount(d.totalAmount, d.currency)}
                      </td>
                      <td className="py-2">
                        {t.status[d.status]} <MissingBadge missing={d.missing} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <ul className="flex flex-col gap-3 md:hidden">
                {page.items.map((d) => (
                  <MobileItem key={d.id} d={d} />
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

function MobileItem({ d }: { d: FinanceDocument }) {
  return (
    <li className="rounded-md border border-stone-200 p-3">
      <Link href={`/finance/documents/${d.code}`} className="flex flex-col gap-1">
        <span className="flex justify-between gap-2">
          <span className="font-mono text-sm underline">{d.code}</span>
          <span className="text-xs text-stone-500">
            {t.status[d.status]} <MissingBadge missing={d.missing} />
          </span>
        </span>
        <span className="text-sm font-medium">{d.supplier?.name ?? t.detail.empty}</span>
        <span className="text-sm text-stone-600">
          {t.kinds[d.kind]} {d.documentNumber ?? ''} · {financeDate(d.issuedOn)} ·{' '}
          {financeMonth(d.handoverMonth)}
        </span>
        <span className="text-sm tabular-nums">
          {financeAmount(d.totalAmount, d.currency)} · {fileSize(d.byteSize)}
        </span>
      </Link>
    </li>
  );
}
