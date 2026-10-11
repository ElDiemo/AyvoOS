import { bottleCreationHistoryResponseSchema } from '@ayvo/types';
import Link from 'next/link';
import { BottlesHeader } from '@/components/production/bottles-header';
import { PrintJobStatus } from '@/components/status';
import { buttonClass, Card, EmptyState } from '@/components/ui';
import { formatDateTimeCs } from '@/i18n/cs/format';
import { productionCs } from '@/i18n/cs/production';
import { shellCs } from '@/i18n/cs/shell';
import { apiGet } from '@/lib/api';
import { codeRange } from '@/lib/format';

export const dynamic = 'force-dynamic';

const PAGE_SIZE = 50;
const b = productionCs.bottles;
const c = shellCs.common;

/**
 * Výroba → Lahve → Historie vytvoření: one row per bottle creation (a creation batch in the backend), with
 * the state of its labels. The series detail page holds the full print-job history and actions.
 */
export default async function CreationHistoryPage({
  searchParams,
}: {
  searchParams: Promise<{ page?: string }>;
}) {
  const page = Math.max(1, Math.floor(Number((await searchParams).page)) || 1);
  const list = await apiGet('admin/bottle-creation-history', bottleCreationHistoryResponseSchema, {
    page,
    pageSize: PAGE_SIZE,
  });
  const pages = Math.max(1, Math.ceil(list.total / list.pageSize));

  return (
    <>
      <BottlesHeader active="history" subtitle={b.historyCount(list.total)} />
      {/* relative: keeps the sr-only header inside the scroll container on small screens */}
      <Card className="relative overflow-x-auto p-0">
        {list.items.length === 0 ? (
          <EmptyState>
            {b.noneHistory}{' '}
            <Link href="/bottles/new" className="font-medium underline">
              {b.create}
            </Link>
          </EmptyState>
        ) : (
          <table className="w-full text-left text-sm" data-testid="creation-history">
            <thead className="border-b border-stone-200 text-xs uppercase tracking-wide text-stone-500">
              <tr>
                <th className="px-6 py-3 font-medium">{b.series}</th>
                <th className="px-6 py-3 font-medium">{b.createdAt}</th>
                <th className="px-6 py-3 font-medium">{b.bottlesColumn}</th>
                <th className="px-6 py-3 font-medium">{b.template}</th>
                <th className="px-6 py-3 font-medium">{b.labelsColumn}</th>
                <th className="px-6 py-3 font-medium">
                  <span className="sr-only">{b.actions}</span>
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-stone-100">
              {list.items.map((item) => (
                <tr
                  key={item.code}
                  className="hover:bg-stone-50"
                  data-testid={`series-${item.code}`}
                >
                  <td className="px-6 py-3 font-mono">
                    <Link href={`/batches/${item.code}`} className="font-medium hover:underline">
                      {item.code}
                    </Link>
                  </td>
                  <td className="whitespace-nowrap px-6 py-3 text-stone-500">
                    {formatDateTimeCs(item.createdAt)}
                  </td>
                  <td className="px-6 py-3">
                    <span className="tabular-nums">{item.quantityCreated}</span>
                    <span className="block font-mono text-xs text-stone-500">
                      {codeRange(item.firstBottleCode, item.lastBottleCode)}
                    </span>
                  </td>
                  <td className="px-6 py-3 wrap-anywhere">{item.labelTemplate.label}</td>
                  <td className="px-6 py-3">
                    {item.latestPrintJob ? (
                      <PrintJobStatus status={item.latestPrintJob.status} />
                    ) : (
                      <span className="text-stone-500">{b.noPrintJob}</span>
                    )}
                  </td>
                  <td className="px-6 py-3">
                    <div className="flex justify-end gap-2">
                      {item.latestPrintJob?.downloadUrl && (
                        <a
                          href={item.latestPrintJob.downloadUrl}
                          className={buttonClass.secondary}
                          download
                        >
                          {b.downloadPdf}
                        </a>
                      )}
                      <Link href={`/batches/${item.code}`} className={buttonClass.secondary}>
                        {item.latestPrintJob?.status === 'COMPLETED'
                          ? b.details
                          : b.labelsAndDetails}
                      </Link>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>
      <p className="mt-3 text-xs text-stone-400">{b.noCreator}</p>
      {pages > 1 && (
        <nav className="mt-6 flex items-center justify-between text-sm" aria-label={c.pagination}>
          {page > 1 ? (
            <Link href={`/bottles/history?page=${page - 1}`} className={buttonClass.secondary}>
              {c.previous}
            </Link>
          ) : (
            <span />
          )}
          <span className="text-stone-500">{c.page(page, pages)}</span>
          {page < pages ? (
            <Link href={`/bottles/history?page=${page + 1}`} className={buttonClass.secondary}>
              {c.next}
            </Link>
          ) : (
            <span />
          )}
        </nav>
      )}
    </>
  );
}
