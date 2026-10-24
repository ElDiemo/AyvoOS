import {
  financeDocumentListQuerySchema,
  financeDocumentPageSchema,
  financeSupplierSchema,
  type FinanceDocument,
} from '@ayvo/types';
import { cn } from '@ayvo/ui';
import Link from 'next/link';
import { z } from 'zod';
import { fileSize, financeAmount, financeDate } from '@/components/finance/finance-format';
import { ReceiveDocumentForm } from '@/components/finance/receive-document-form';
import { buttonClass, Card, EmptyState, inputClass, PageHeader } from '@/components/ui';
import { financeCs as t } from '@/i18n/cs/finance';
import { apiGet } from '@/lib/api';
import { currentUser, hasPermission } from '@/lib/session';

export const dynamic = 'force-dynamic';

type Params = Record<string, string | undefined>;

/**
 * Přijaté doklady (doc 039, N1): search and filters as a plain GET form (the URL keeps them),
 * pages of 50, newest issue date first; receiving a document for finance:documents_manage.
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
  const me = await currentUser();
  const canManage = hasPermission(me, 'finance:documents_manage');
  const [page, suppliers] = await Promise.all([
    apiGet('admin/finance/documents', financeDocumentPageSchema, {
      q: q.q,
      supplierId: q.supplierId,
      status: q.status,
      issuedFrom: q.issuedFrom,
      issuedTo: q.issuedTo,
      page: q.page,
    }),
    canManage ? apiGet('admin/finance/suppliers', z.array(financeSupplierSchema)) : [],
  ]);
  const pages = Math.max(1, Math.ceil(page.total / page.pageSize));
  const filtered = !!(q.q || q.supplierId || q.status || q.issuedFrom || q.issuedTo);
  const link = (p: number) =>
    `/finance/documents?${new URLSearchParams(
      Object.entries({ ...raw, page: String(p) }).filter((e): e is [string, string] => !!e[1]),
    ).toString()}`;
  const filterLabel =
    'flex min-w-0 flex-col gap-1 text-xs font-medium uppercase tracking-wide text-stone-500';

  return (
    <>
      <PageHeader title={t.title} subtitle={t.subtitle} />
      <div className="flex flex-col gap-6">
        {canManage && (
          <Card title={t.receive.title} testId="finance-receive">
            <ReceiveDocumentForm suppliers={suppliers} />
          </Card>
        )}
        <Card>
          <form method="get" className="flex flex-col gap-4" data-testid="finance-filters">
            <label className={filterLabel}>
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
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
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
          </form>
        </Card>
        <Card title={t.list.total(page.total)} testId="finance-documents">
          {page.items.length === 0 ? (
            <EmptyState>{filtered ? t.list.emptyFiltered : t.list.empty}</EmptyState>
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
                      <td className="py-2 pr-3">{d.supplier.name}</td>
                      <td className="py-2 pr-3">
                        {t.kinds[d.kind]} {d.documentNumber}
                      </td>
                      <td className="py-2 pr-3">{financeDate(d.issuedOn)}</td>
                      <td className="py-2 pr-3 text-right tabular-nums">
                        {financeAmount(d.totalAmount, d.currency)}
                      </td>
                      <td className="py-2">{t.status[d.status]}</td>
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
          <span className="text-xs text-stone-500">{t.status[d.status]}</span>
        </span>
        <span className="text-sm font-medium">{d.supplier.name}</span>
        <span className="text-sm text-stone-600">
          {t.kinds[d.kind]} {d.documentNumber} · {financeDate(d.issuedOn)}
        </span>
        <span className="text-sm tabular-nums">
          {financeAmount(d.totalAmount, d.currency)} · {fileSize(d.byteSize)}
        </span>
      </Link>
    </li>
  );
}
