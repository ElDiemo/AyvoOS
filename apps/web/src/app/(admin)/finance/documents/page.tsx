import {
  financeDocumentListQuerySchema,
  financeDocumentPageSchema,
  financeSupplierSchema,
  takeOverCandidateSchema,
  type FinanceDocument,
} from '@ayvo/types';
import { cn } from '@ayvo/ui';
import Link from 'next/link';
import { z } from 'zod';
import {
  fileSize,
  financeAmount,
  financeDate,
  financeMonth,
} from '@/components/finance/finance-format';
import { MissingBadge } from '@/components/finance/missing-badge';
import { ReceiveDocumentForm } from '@/components/finance/receive-document-form';
import { TakeOverList } from '@/components/finance/take-over-list';
import { buttonClass, Card, EmptyState, inputClass, PageHeader } from '@/components/ui';
import { financeCs as t } from '@/i18n/cs/finance';
import { apiGet } from '@/lib/api';
import { currentUser, hasPermission } from '@/lib/session';

export const dynamic = 'force-dynamic';

type Params = Record<string, string | undefined>;

/**
 * Přijaté doklady (doc 039, N1): search and filters as a plain GET form (the URL keeps them),
 * pages of 50, newest first; "K doplnění" marks what the export still needs. Receiving a PDF and
 * taking over a supplier document of Sklad for finance:documents_manage (the takeover list only
 * shows the paperwork of the user's sites; the core decides).
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
  const canTakeOver = canManage && hasPermission(me, 'procurement:documents_read');
  const [page, suppliers, candidates] = await Promise.all([
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
    canManage ? apiGet('admin/finance/suppliers', z.array(financeSupplierSchema)) : [],
    canTakeOver ? apiGet('admin/finance/supplier-documents', z.array(takeOverCandidateSchema)) : [],
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
        {canTakeOver && (
          <Card title={t.takeOver.title} testId="finance-take-over">
            <TakeOverList candidates={candidates} />
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
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-4">
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
            <label className="flex items-center gap-2 text-sm">
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
