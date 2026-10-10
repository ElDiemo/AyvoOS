import { bottleCreationBatchListResponseSchema } from '@ayvo/types';
import Link from 'next/link';
import { buttonClass, Card, EmptyState, PageHeader } from '@/components/ui';
import { apiGet } from '@/lib/api';
import { codeRange, formatDateTime } from '@/lib/format';

export const dynamic = 'force-dynamic';

export default async function BatchesPage({
  searchParams,
}: {
  searchParams: Promise<{ page?: string }>;
}) {
  const page = Math.max(1, Number((await searchParams).page) || 1);
  const list = await apiGet('admin/bottle-batches', bottleCreationBatchListResponseSchema, {
    page,
    pageSize: 50,
  });
  const pages = Math.max(1, Math.ceil(list.total / list.pageSize));
  return (
    <>
      <PageHeader
        title="Creation batches"
        subtitle="Groups of bottle identities registered together (not fill batches)."
        actions={
          <Link href="/bottles/new" className={buttonClass.primary}>
            Create bottles
          </Link>
        }
      />
      <Card className="overflow-x-auto p-0">
        {list.items.length === 0 ? (
          <EmptyState>No creation batches yet.</EmptyState>
        ) : (
          <table className="w-full text-left text-sm">
            <thead className="border-b border-stone-200 text-xs uppercase tracking-wide text-stone-500">
              <tr>
                <th className="px-6 py-3 font-medium">Batch</th>
                <th className="px-6 py-3 font-medium">Bottles</th>
                <th className="px-6 py-3 font-medium">Codes</th>
                <th className="px-6 py-3 font-medium">Template</th>
                <th className="px-6 py-3 font-medium">Created at</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-stone-100">
              {list.items.map((b) => (
                <tr key={b.code} className="hover:bg-stone-50">
                  <td className="px-6 py-3 font-mono">
                    <Link href={`/batches/${b.code}`} className="font-medium hover:underline">
                      {b.code}
                    </Link>
                  </td>
                  <td className="px-6 py-3 tabular-nums">{b.quantityCreated}</td>
                  <td className="px-6 py-3 font-mono text-xs">
                    {codeRange(b.firstBottleCode, b.lastBottleCode)}
                  </td>
                  <td className="px-6 py-3">{b.labelTemplate.label}</td>
                  <td className="px-6 py-3 text-stone-500">{formatDateTime(b.createdAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>
      {pages > 1 && (
        <nav className="mt-6 flex items-center justify-between text-sm" aria-label="Pagination">
          {page > 1 ? (
            <Link href={`/batches?page=${page - 1}`} className={buttonClass.secondary}>
              ← Previous
            </Link>
          ) : (
            <span />
          )}
          <span className="text-stone-500">
            Page {page} of {pages}
          </span>
          {page < pages ? (
            <Link href={`/batches?page=${page + 1}`} className={buttonClass.secondary}>
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
