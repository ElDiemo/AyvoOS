import { bottleCreationHistoryResponseSchema } from '@ayvo/types';
import Link from 'next/link';
import { BottlesHeader } from '@/components/bottles/bottles-header';
import { PrintJobStatus } from '@/components/status';
import { buttonClass, Card, EmptyState } from '@/components/ui';
import { apiGet } from '@/lib/api';
import { codeRange, formatDateTime } from '@/lib/format';

export const dynamic = 'force-dynamic';

const PAGE_SIZE = 50;

/**
 * Bottles → Creation history: one row per bottle creation (a creation batch in the backend), with
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
      <BottlesHeader
        active="history"
        subtitle={`${list.total} creation${list.total === 1 ? '' : 's'} · each created series keeps its bottles, label template and label print jobs`}
      />
      {/* relative: keeps the sr-only header inside the scroll container on small screens */}
      <Card className="relative overflow-x-auto p-0">
        {list.items.length === 0 ? (
          <EmptyState>
            No bottles have been created yet.{' '}
            <Link href="/bottles/new" className="font-medium underline">
              Create bottles
            </Link>
          </EmptyState>
        ) : (
          <table className="w-full text-left text-sm" data-testid="creation-history">
            <thead className="border-b border-stone-200 text-xs uppercase tracking-wide text-stone-500">
              <tr>
                <th className="px-6 py-3 font-medium">Series</th>
                <th className="px-6 py-3 font-medium">Created at</th>
                <th className="px-6 py-3 font-medium">Bottles</th>
                <th className="px-6 py-3 font-medium">Label template</th>
                <th className="px-6 py-3 font-medium">Labels</th>
                <th className="px-6 py-3 font-medium">
                  <span className="sr-only">Actions</span>
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
                    {formatDateTime(item.createdAt)}
                  </td>
                  <td className="px-6 py-3">
                    <span className="tabular-nums">{item.quantityCreated}</span>
                    <span className="block font-mono text-xs text-stone-500">
                      {codeRange(item.firstBottleCode, item.lastBottleCode)}
                    </span>
                  </td>
                  <td className="px-6 py-3">{item.labelTemplate.label}</td>
                  <td className="px-6 py-3">
                    {item.latestPrintJob ? (
                      <PrintJobStatus status={item.latestPrintJob.status} />
                    ) : (
                      <span className="text-stone-500">No print job</span>
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
                          Download PDF
                        </a>
                      )}
                      <Link href={`/batches/${item.code}`} className={buttonClass.secondary}>
                        {item.latestPrintJob?.status === 'COMPLETED'
                          ? 'Details'
                          : 'Labels & details'}
                      </Link>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>
      <p className="mt-3 text-xs text-stone-400">
        The creator is not recorded yet: AYVO OS has no user accounts on DEV.
      </p>
      {pages > 1 && (
        <nav className="mt-6 flex items-center justify-between text-sm" aria-label="Pagination">
          {page > 1 ? (
            <Link href={`/bottles/history?page=${page - 1}`} className={buttonClass.secondary}>
              ← Previous
            </Link>
          ) : (
            <span />
          )}
          <span className="text-stone-500">
            Page {page} of {pages}
          </span>
          {page < pages ? (
            <Link href={`/bottles/history?page=${page + 1}`} className={buttonClass.secondary}>
              Next →
            </Link>
          ) : (
            <span />
          )}
        </nav>
      )}
    </>
  );
}
