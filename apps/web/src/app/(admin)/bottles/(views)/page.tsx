import {
  bottleListQuerySchema,
  bottleListResponseSchema,
  labelTemplateSummarySchema,
  PAGE_SIZE_MAX,
} from '@ayvo/types';
import Link from 'next/link';
import { z } from 'zod';
import { BottlesHeader } from '@/components/bottles/bottles-header';
import { BottleStatusBadge } from '@/components/status';
import { buttonClass, Card, EmptyState, inputClass } from '@/components/ui';
import { apiGet } from '@/lib/api';
import { formatDateTime } from '@/lib/format';

export const dynamic = 'force-dynamic';

const PAGE_SIZE = 50;

type Search = { page?: string; search?: string; batch?: string; templateId?: string };

export default async function BottlesPage({ searchParams }: { searchParams: Promise<Search> }) {
  const raw = await searchParams;
  // Drop invalid filters (e.g. a mistyped templateId) instead of failing the whole page.
  const params: Search = {};
  for (const key of ['page', 'search', 'batch', 'templateId'] as const) {
    const value = raw[key];
    if (typeof value !== 'string' || value === '') continue;
    if (bottleListQuerySchema.shape[key].safeParse(value).success) params[key] = value;
  }
  const page = Math.max(1, Number(params.page) || 1);
  const [list, templates] = await Promise.all([
    apiGet('admin/bottles', bottleListResponseSchema, {
      page,
      pageSize: Math.min(PAGE_SIZE, PAGE_SIZE_MAX),
      search: params.search,
      batch: params.batch,
      templateId: params.templateId,
    }),
    apiGet('admin/label-templates', z.array(labelTemplateSummarySchema)),
  ]);
  const pages = Math.max(1, Math.ceil(list.total / list.pageSize));
  const link = (p: number) => {
    const q = new URLSearchParams();
    for (const [k, v] of Object.entries({ ...params, page: String(p) })) if (v) q.set(k, v);
    return `/bottles?${q.toString()}`;
  };

  return (
    <>
      <BottlesHeader
        active="bottles"
        subtitle={`${list.total} bottle${list.total === 1 ? '' : 's'}${params.batch || params.search || params.templateId ? ' matching the filters' : ''}`}
      />
      <Card className="mb-6">
        <form
          className="grid gap-3 sm:grid-cols-2 lg:grid-cols-[1fr_12rem_12rem_auto]"
          action="/bottles"
        >
          <input
            name="search"
            defaultValue={params.search}
            placeholder="Bottle code, e.g. AYV-B-000001 or 1"
            className={inputClass}
            aria-label="Search by bottle code"
          />
          <input
            name="batch"
            defaultValue={params.batch}
            placeholder="Series, e.g. BC-000001"
            className={inputClass}
            aria-label="Filter by series"
          />
          <select
            name="templateId"
            defaultValue={params.templateId ?? ''}
            className={inputClass}
            aria-label="Filter by label template"
          >
            <option value="">All templates</option>
            {templates.map((t) => (
              <option key={t.id} value={t.id}>
                {t.name}
              </option>
            ))}
          </select>
          <div className="flex gap-2">
            <button type="submit" className={buttonClass.secondary}>
              Filter
            </button>
            <Link href="/bottles" className={buttonClass.secondary}>
              Reset
            </Link>
          </div>
        </form>
      </Card>
      <Card className="overflow-x-auto p-0">
        {list.items.length === 0 ? (
          <EmptyState>
            {params.batch || params.search || params.templateId ? (
              'No bottles match the filters.'
            ) : (
              <>
                No bottles yet.{' '}
                <Link href="/bottles/new" className="font-medium underline">
                  Create bottles
                </Link>
              </>
            )}
          </EmptyState>
        ) : (
          <table className="w-full text-left text-sm">
            <thead className="border-b border-stone-200 text-xs uppercase tracking-wide text-stone-500">
              <tr>
                <th className="px-6 py-3 font-medium">Bottle code</th>
                <th className="px-6 py-3 font-medium">Status</th>
                <th className="px-6 py-3 font-medium">Series</th>
                <th className="px-6 py-3 font-medium">Label template</th>
                <th className="px-6 py-3 font-medium">Created at</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-stone-100">
              {list.items.map((b) => (
                <tr key={b.code} className="hover:bg-stone-50">
                  <td className="px-6 py-3 font-mono">
                    <Link href={`/bottles/${b.code}`} className="font-medium hover:underline">
                      {b.code}
                    </Link>
                  </td>
                  <td className="px-6 py-3">
                    <BottleStatusBadge status={b.status} />
                  </td>
                  <td className="px-6 py-3 font-mono">
                    <Link href={`/batches/${b.creationBatchCode}`} className="hover:underline">
                      {b.creationBatchCode}
                    </Link>
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
            <Link href={link(page - 1)} className={buttonClass.secondary}>
              ← Previous
            </Link>
          ) : (
            <span />
          )}
          <span className="text-stone-500">
            Page {page} of {pages}
          </span>
          {page < pages ? (
            <Link href={link(page + 1)} className={buttonClass.secondary}>
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
