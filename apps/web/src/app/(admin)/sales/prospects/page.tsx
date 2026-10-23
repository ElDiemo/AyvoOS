import {
  API_BASE_PATH,
  PROSPECT_STAGES,
  prospectListQuerySchema,
  prospectPageSchema,
  salespersonSchema,
  type ProspectSummary,
} from '@ayvo/types';
import { cn } from '@ayvo/ui';
import Link from 'next/link';
import { z } from 'zod';
import { dueClass, dueLabel, salesDateTime, stageClass } from '@/components/sales/sales-format';
import { SalesHeader } from '@/components/sales/sales-header';
import { buttonClass, Card, EmptyState, inputClass } from '@/components/ui';
import { salesCs } from '@/i18n/cs/sales';
import { apiGet } from '@/lib/api';
import { currentUser, hasPermission } from '@/lib/session';

export const dynamic = 'force-dynamic';
const t = salesCs.list;

type Params = Record<string, string | undefined>;

/**
 * Akvizice (doc 034 §9): search (name, city, contacts), filters, pages of 25 with the total and a
 * stable order (next task, name, code). A table on a computer, cards on a phone. Filters are a
 * plain GET form: the URL keeps them for reload, back and sharing.
 */
export default async function ProspectsPage({ searchParams }: { searchParams: Promise<Params> }) {
  const raw = await searchParams;
  // Every filter on its own: one invalid value (e.g. a mistyped country) never drops the others.
  const q = prospectListQuerySchema.parse({});
  for (const [key, value] of Object.entries(raw)) {
    if (!value) continue;
    const one = prospectListQuerySchema.safeParse({
      [key]: key === 'country' ? value.toUpperCase() : value,
    });
    if (one.success) Object.assign(q, { [key]: one.data[key as keyof typeof one.data] });
  }
  const me = await currentUser();
  const canManage = hasPermission(me, 'sales:manage');
  const [page, salespeople] = await Promise.all([
    apiGet('admin/sales/prospects', prospectPageSchema, {
      q: q.q,
      owner: q.owner,
      stage: q.stage,
      priority: q.priority,
      country: q.country,
      next: q.next,
      archived: q.archived,
      page: q.page,
    }),
    canManage ? apiGet('admin/sales/salespeople', z.array(salespersonSchema)) : null,
  ]);
  const pages = Math.max(1, Math.ceil(page.total / page.pageSize));
  const archivedView = q.archived === 'archived';
  const filtered = !!(
    q.q ||
    q.owner ||
    q.stage ||
    q.priority ||
    q.country ||
    q.next ||
    archivedView
  );
  const exportQuery = new URLSearchParams(
    Object.entries({
      q: q.q,
      owner: q.owner,
      stage: q.stage,
      priority: q.priority,
      country: q.country,
      next: q.next,
      archived: archivedView ? 'archived' : undefined,
    }).filter((e): e is [string, string] => !!e[1]),
  ).toString();
  const link = (p: number) => {
    const params = new URLSearchParams(
      Object.entries({ ...raw, page: String(p) }).filter((e): e is [string, string] => !!e[1]),
    );
    return `/sales/prospects?${params.toString()}`;
  };
  const select = (
    name: string,
    label: string,
    value: string | undefined,
    options: [string, string][],
  ) => (
    <label className="flex min-w-0 flex-col gap-1 text-xs font-medium uppercase tracking-wide text-stone-500">
      {label}
      <select
        name={name}
        defaultValue={value ?? ''}
        className={cn(inputClass, 'normal-case tracking-normal')}
        data-testid={`filter-${name}`}
      >
        <option value="">{t.any}</option>
        {options.map(([v, text]) => (
          <option key={v} value={v}>
            {text}
          </option>
        ))}
      </select>
    </label>
  );

  return (
    <>
      <SalesHeader
        active="prospects"
        title={t.title}
        subtitle={t.subtitle}
        actions={
          <div className="flex flex-wrap gap-2">
            <Link
              href="/sales/prospects/new"
              className={buttonClass.primary}
              data-testid="new-prospect"
            >
              {salesCs.overview.newProspect}
            </Link>
            <Link
              href="/sales/prospects/import"
              className={buttonClass.secondary}
              data-testid="import-prospects"
            >
              {salesCs.importer.open}
            </Link>
            {/* The current filters, every page; the API keeps it within the user's scope. */}
            <a
              href={`${API_BASE_PATH}/admin/sales/prospects/export?${exportQuery}`}
              download
              className={buttonClass.secondary}
              title={salesCs.importer.exportHelp}
              data-testid="export-prospects"
            >
              {salesCs.importer.export}
            </a>
          </div>
        }
      />
      <div className="flex flex-col gap-6">
        <Card>
          <form method="get" className="flex flex-col gap-4" data-testid="prospect-filters">
            <label className="flex flex-col gap-1 text-xs font-medium uppercase tracking-wide text-stone-500">
              {t.search}
              <input
                type="search"
                name="q"
                defaultValue={q.q ?? ''}
                placeholder={t.searchPlaceholder}
                maxLength={100}
                className={cn(inputClass, 'normal-case tracking-normal')}
                data-testid="prospect-search"
              />
            </label>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-6">
              {canManage &&
                select('owner', t.owner, q.owner, [
                  ['me', t.ownerMe],
                  ...(salespeople ?? []).map((s): [string, string] => [s.id, s.name]),
                ])}
              {select(
                'stage',
                t.stage,
                q.stage,
                PROSPECT_STAGES.map((s) => [s, salesCs.stages[s]]),
              )}
              {select('priority', t.priority, q.priority, [
                ['A', 'A'],
                ['B', 'B'],
                ['C', 'C'],
              ])}
              <label className="flex min-w-0 flex-col gap-1 text-xs font-medium uppercase tracking-wide text-stone-500">
                {t.country}
                <input
                  name="country"
                  defaultValue={q.country ?? ''}
                  maxLength={2}
                  placeholder="CZ"
                  className={cn(inputClass, 'uppercase tracking-normal')}
                  data-testid="filter-country"
                />
              </label>
              {select('next', t.next, q.next, Object.entries(t.nextOptions))}
              {/* Archived prospects only on request (doc 034 §3a); the default is the active ones. */}
              <label className="flex min-w-0 flex-col gap-1 text-xs font-medium uppercase tracking-wide text-stone-500">
                {t.archived}
                <select
                  name="archived"
                  defaultValue={archivedView ? 'archived' : ''}
                  className={cn(inputClass, 'normal-case tracking-normal')}
                  data-testid="filter-archived"
                >
                  <option value="">{t.archivedOptions.active}</option>
                  <option value="archived">{t.archivedOptions.archived}</option>
                </select>
              </label>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <button type="submit" className={buttonClass.secondary} data-testid="apply-filters">
                {t.filter}
              </button>
              {filtered && (
                <Link href="/sales/prospects" className="text-sm text-stone-600 underline">
                  {t.reset}
                </Link>
              )}
              <p className="ml-auto text-sm text-stone-600" data-testid="prospect-total">
                {t.total(page.total)}
              </p>
            </div>
          </form>
        </Card>

        <Card>
          {page.items.length === 0 ? (
            <EmptyState>
              {archivedView && !(q.q || q.owner || q.stage || q.priority || q.country || q.next)
                ? t.emptyArchived
                : filtered
                  ? t.emptyFiltered
                  : t.empty}
            </EmptyState>
          ) : (
            <>
              {/* Computer: a table. */}
              <table
                className="hidden w-full table-fixed text-sm lg:table"
                data-testid="prospect-table"
              >
                <thead>
                  <tr className="border-b border-stone-200 text-left text-xs uppercase tracking-wide text-stone-500">
                    <th className="w-[28%] py-2 pr-3 font-medium">{t.columns.name}</th>
                    <th className="w-[10%] py-2 pr-3 font-medium">{t.columns.stage}</th>
                    <th className="w-[14%] py-2 pr-3 font-medium">{t.columns.owner}</th>
                    <th className="w-[14%] py-2 pr-3 font-medium">{t.columns.lastContact}</th>
                    <th className="py-2 font-medium">{t.columns.next}</th>
                  </tr>
                </thead>
                <tbody>
                  {page.items.map((p) => (
                    <Row key={p.code} p={p} today={page.today} />
                  ))}
                </tbody>
              </table>
              {/* Phone and tablet: cards, nothing wide. */}
              <ul
                className="flex flex-col divide-y divide-stone-100 lg:hidden"
                data-testid="prospect-cards"
              >
                {page.items.map((p) => (
                  <CardRow key={p.code} p={p} today={page.today} />
                ))}
              </ul>
            </>
          )}
          {pages > 1 && (
            <nav
              className="mt-4 flex flex-wrap items-center justify-between gap-2 border-t border-stone-100 pt-4 text-sm"
              aria-label="Stránkování"
              data-testid="pagination"
            >
              {q.page > 1 ? (
                <Link
                  href={link(q.page - 1)}
                  className="font-medium underline-offset-2 hover:underline"
                >
                  {t.previous}
                </Link>
              ) : (
                <span />
              )}
              <span className="text-stone-600">{t.page(q.page, pages)}</span>
              {q.page < pages ? (
                <Link
                  href={link(q.page + 1)}
                  className="font-medium underline-offset-2 hover:underline"
                  data-testid="next-page"
                >
                  {t.nextPage}
                </Link>
              ) : (
                <span />
              )}
            </nav>
          )}
        </Card>
        <p className="text-xs text-stone-500">{salesCs.timeZoneNote}</p>
      </div>
    </>
  );
}

function Stage({ p }: { p: ProspectSummary }) {
  return (
    <span
      className={cn(
        'inline-block rounded px-2 py-0.5 text-xs font-medium whitespace-nowrap',
        stageClass[p.stage],
      )}
    >
      {salesCs.stages[p.stage]}
      {p.archivedAt && (
        <span className="ml-1 font-normal text-stone-500" data-testid="archived-badge">
          · {t.archivedBadge}
        </span>
      )}
    </span>
  );
}

function Next({ p, today }: { p: ProspectSummary; today: string }) {
  if (!p.nextTask) return <span className="text-amber-800">{t.noNext}</span>;
  const due = dueLabel(p.nextTask.dueOn, today);
  return (
    <span className="wrap-anywhere">
      <span className={cn('mr-2', dueClass[due.tone])}>{due.text}</span>
      {p.nextTask.title}
      {p.openTasks > 1 && <span className="text-stone-400"> (+{p.openTasks - 1})</span>}
    </span>
  );
}

const place = (p: ProspectSummary) => [p.city, p.countryCode].filter(Boolean).join(', ');

function Row({ p, today }: { p: ProspectSummary; today: string }) {
  return (
    <tr
      className="border-b border-stone-100 align-top last:border-0"
      data-testid={`prospect-${p.code}`}
    >
      <td className="py-3 pr-3">
        <Link
          href={`/sales/prospects/${p.code}`}
          className="font-medium underline-offset-2 hover:underline wrap-anywhere"
        >
          {p.name}
        </Link>
        <p className="text-xs text-stone-500">
          {place(p)}
          {p.priority && ` · ${p.priority}`}
          {p.roomsEstimate && ` · ~${p.roomsEstimate} pok.`}
        </p>
      </td>
      <td className="py-3 pr-3">
        <Stage p={p} />
      </td>
      <td className="py-3 pr-3 wrap-anywhere">{p.owner.name}</td>
      <td className="py-3 pr-3 text-stone-600">
        {p.lastContactAt ? salesDateTime(p.lastContactAt) : t.noContact}
      </td>
      <td className="py-3">
        <Next p={p} today={today} />
      </td>
    </tr>
  );
}

function CardRow({ p, today }: { p: ProspectSummary; today: string }) {
  return (
    <li
      className="flex flex-col gap-1 py-3 first:pt-0 last:pb-0"
      data-testid={`prospect-card-${p.code}`}
    >
      <div className="flex items-start justify-between gap-2">
        <Link
          href={`/sales/prospects/${p.code}`}
          className="min-w-0 font-medium underline-offset-2 hover:underline wrap-anywhere"
        >
          {p.name}
        </Link>
        <Stage p={p} />
      </div>
      <p className="text-xs text-stone-500 wrap-anywhere">
        {place(p)}
        {p.priority && ` · ${p.priority}`} · {p.owner.name}
      </p>
      <p className="text-sm">
        <Next p={p} today={today} />
      </p>
      <p className="text-xs text-stone-500">
        {t.columns.lastContact}: {p.lastContactAt ? salesDateTime(p.lastContactAt) : t.noContact}
      </p>
    </li>
  );
}
