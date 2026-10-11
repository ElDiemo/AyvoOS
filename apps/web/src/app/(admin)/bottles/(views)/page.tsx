import {
  bottleListQuerySchema,
  bottleListResponseSchema,
  labelTemplateSummarySchema,
  PAGE_SIZE_MAX,
} from '@ayvo/types';
import Link from 'next/link';
import { z } from 'zod';
import { BottlesHeader } from '@/components/production/bottles-header';
import { BottleStatusBadge } from '@/components/status';
import { buttonClass, Card, EmptyState, inputClass } from '@/components/ui';
import { formatDateTimeCs } from '@/i18n/cs/format';
import { productionCs } from '@/i18n/cs/production';
import { shellCs } from '@/i18n/cs/shell';
import { apiGet } from '@/lib/api';

export const dynamic = 'force-dynamic';

const PAGE_SIZE = 50;

const b = productionCs.bottles;
const c = shellCs.common;

type Search = {
  page?: string;
  search?: string;
  batch?: string;
  templateId?: string;
  status?: string;
};

export default async function BottlesPage({ searchParams }: { searchParams: Promise<Search> }) {
  const raw = await searchParams;
  // Drop invalid filters (e.g. a mistyped templateId) instead of failing the whole page.
  const params: Search = {};
  for (const key of ['page', 'search', 'batch', 'templateId', 'status'] as const) {
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
      status: params.status,
    }),
    apiGet('admin/label-templates', z.array(labelTemplateSummarySchema)),
  ]);
  const pages = Math.max(1, Math.ceil(list.total / list.pageSize));
  const filtered = !!(params.batch || params.search || params.templateId || params.status);
  const link = (p: number) => {
    const q = new URLSearchParams();
    for (const [k, v] of Object.entries({ ...params, page: String(p) })) if (v) q.set(k, v);
    return `/bottles?${q.toString()}`;
  };

  return (
    <>
      <BottlesHeader active="list" subtitle={b.count(list.total, filtered)} />
      <Card className="mb-6">
        <form
          className="grid gap-3 sm:grid-cols-2 lg:grid-cols-[minmax(0,1fr)_11rem_12rem_12rem_auto]"
          action="/bottles"
        >
          <input
            name="search"
            defaultValue={params.search}
            placeholder={b.searchPlaceholder}
            className={inputClass}
            aria-label={b.search}
          />
          <input
            name="batch"
            defaultValue={params.batch}
            placeholder={b.seriesPlaceholder}
            className={inputClass}
            aria-label={b.seriesFilter}
          />
          <select
            name="templateId"
            defaultValue={params.templateId ?? ''}
            className={inputClass}
            aria-label={b.templateFilter}
          >
            <option value="">{b.allTemplates}</option>
            {templates.map((t) => (
              <option key={t.id} value={t.id}>
                {t.name}
              </option>
            ))}
          </select>
          <select
            name="status"
            defaultValue={params.status ?? ''}
            className={inputClass}
            aria-label={b.statusFilter}
          >
            <option value="">{b.allStatuses}</option>
            {Object.entries(productionCs.bottleStatus).map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
          <div className="flex gap-2">
            <button type="submit" className={buttonClass.secondary}>
              {b.filter}
            </button>
            <Link href="/bottles" className={buttonClass.secondary}>
              {b.reset}
            </Link>
          </div>
        </form>
      </Card>
      <Card className="overflow-x-auto p-0">
        {list.items.length === 0 ? (
          <EmptyState>
            {filtered ? (
              b.noMatch
            ) : (
              <>
                {b.none}{' '}
                <Link href="/bottles/new" className="font-medium underline">
                  {b.create}
                </Link>
              </>
            )}
          </EmptyState>
        ) : (
          <table className="w-full text-left text-sm">
            <thead className="border-b border-stone-200 text-xs uppercase tracking-wide text-stone-500">
              <tr>
                <th className="px-6 py-3 font-medium">{b.code}</th>
                <th className="px-6 py-3 font-medium">{b.status}</th>
                <th className="px-6 py-3 font-medium">{b.series}</th>
                <th className="px-6 py-3 font-medium">{b.template}</th>
                <th className="px-6 py-3 font-medium">{b.createdAt}</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-stone-100">
              {list.items.map((bottle) => (
                <tr key={bottle.code} className="hover:bg-stone-50">
                  <td className="px-6 py-3 font-mono">
                    <Link href={`/bottles/${bottle.code}`} className="font-medium hover:underline">
                      {bottle.code}
                    </Link>
                  </td>
                  <td className="px-6 py-3">
                    <BottleStatusBadge status={bottle.status} />
                  </td>
                  <td className="px-6 py-3 font-mono">
                    <Link href={`/batches/${bottle.creationBatchCode}`} className="hover:underline">
                      {bottle.creationBatchCode}
                    </Link>
                  </td>
                  <td className="px-6 py-3 wrap-anywhere">{bottle.labelTemplate.label}</td>
                  <td className="px-6 py-3 whitespace-nowrap text-stone-500">
                    {formatDateTimeCs(bottle.createdAt)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>
      {pages > 1 && (
        <nav className="mt-6 flex items-center justify-between text-sm" aria-label={c.pagination}>
          {page > 1 ? (
            <Link href={link(page - 1)} className={buttonClass.secondary}>
              {c.previous}
            </Link>
          ) : (
            <span />
          )}
          <span className="text-stone-500">{c.page(page, pages)}</span>
          {page < pages ? (
            <Link href={link(page + 1)} className={buttonClass.secondary}>
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
