import { cratePageSchema, crateListQuerySchema, crateTypeSchema, PAGE_SIZE_MAX } from '@ayvo/types';
import Link from 'next/link';
import { z } from 'zod';
import { RowValue } from '@/components/catalog/catalog-header';
import { ProductionHeader } from '@/components/production/production-header';
import { buttonClass, Card, EmptyState, inputClass } from '@/components/ui';
import { cratesCs } from '@/i18n/cs/crates';
import { formatDateTimeCs } from '@/i18n/cs/format';
import { apiGet } from '@/lib/api';
import { currentUser, hasPermission, siteTimeZone } from '@/lib/session';

export const dynamic = 'force-dynamic';
const t = cratesCs;
const PAGE_SIZE = 50;

type Search = { page?: string; search?: string; crateType?: string };

/**
 * Výroba → Bedny: the physical crates of the active site (doc 025 A1). Crate types are catalogue
 * data; this list is the physical pieces. No cycle state exists yet, and it is said so.
 */
export default async function CratesPage({ searchParams }: { searchParams: Promise<Search> }) {
  const raw = await searchParams;
  const params: Search = {};
  for (const key of ['page', 'search', 'crateType'] as const) {
    const value = raw[key];
    if (typeof value !== 'string' || value === '') continue;
    if (crateListQuerySchema.shape[key].safeParse(value).success) params[key] = value;
  }
  const page = Math.max(1, Number(params.page) || 1);
  const me = await currentUser();
  const [list, types, timeZone] = await Promise.all([
    apiGet('admin/crates', cratePageSchema, {
      page,
      pageSize: Math.min(PAGE_SIZE, PAGE_SIZE_MAX),
      search: params.search,
      crateType: params.crateType,
    }),
    // Crate type names for the filter; without catalogue access the filter is just hidden.
    hasPermission(me, 'catalog:read')
      ? apiGet('admin/catalog/crate-types', z.array(crateTypeSchema))
      : Promise.resolve([]),
    siteTimeZone(),
  ]);
  const pages = Math.max(1, Math.ceil(list.total / list.pageSize));
  const filtered = !!(params.search || params.crateType);
  const link = (p: number) => {
    const q = new URLSearchParams();
    for (const [k, v] of Object.entries({ ...params, page: String(p) })) if (v) q.set(k, v);
    return `/production/crates?${q.toString()}`;
  };

  return (
    <>
      <ProductionHeader
        active="crates"
        title={t.title}
        subtitle={t.subtitle}
        actions={
          hasPermission(me, 'crates:register') ? (
            <Link href="/production/crates/new" className={buttonClass.primary}>
              {t.register}
            </Link>
          ) : null
        }
      />
      <Card className="mb-6">
        <form
          className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_14rem_auto]"
          action="/production/crates"
          data-testid="crate-filter"
        >
          <input
            name="search"
            defaultValue={params.search}
            placeholder={t.searchPlaceholder}
            className={inputClass}
            aria-label={t.search}
          />
          {types.length > 0 ? (
            <select
              name="crateType"
              defaultValue={params.crateType ?? ''}
              className={inputClass}
              aria-label={t.typeFilter}
            >
              <option value="">{t.allTypes}</option>
              {types.map((ct) => (
                <option key={ct.code} value={ct.code}>
                  {ct.name} ({ct.code})
                </option>
              ))}
            </select>
          ) : (
            <span className="hidden sm:block" />
          )}
          <div className="flex gap-2">
            <button type="submit" className={buttonClass.secondary}>
              {t.filter}
            </button>
            <Link href="/production/crates" className={buttonClass.secondary}>
              {t.reset}
            </Link>
          </div>
        </form>
      </Card>
      <p className="mb-2 text-sm text-stone-600" data-testid="crate-count">
        {t.count(list.total, filtered)}
      </p>
      <Card>
        {list.items.length === 0 ? (
          <EmptyState>{filtered ? t.noMatch : t.none}</EmptyState>
        ) : (
          <ul data-testid="crates">
            {list.items.map((c) => (
              <li
                key={c.code}
                data-testid={`crate-${c.code}`}
                className="grid grid-cols-1 gap-x-4 gap-y-1 border-t border-stone-100 py-3 text-sm first:border-t-0 md:grid-cols-[minmax(0,1.2fr)_repeat(4,minmax(0,1fr))] md:items-center"
              >
                <Link
                  href={`/production/crates/${c.code}`}
                  className="font-mono font-medium underline-offset-2 hover:underline"
                >
                  {c.code}
                </Link>
                <RowValue label={t.columns.type}>
                  {c.crateType.code} · {t.capacity(c.crateType.capacity)}
                </RowValue>
                <RowValue label={t.columns.circulation}>
                  {c.cycle
                    ? t.cycleLine(
                        t.cycleStatus[c.cycle.status] ?? c.cycle.status,
                        c.cycle.memberCount,
                        c.cycle.capacity,
                        c.cycle.product.name,
                      )
                    : t.noCirculation}
                </RowValue>
                <RowValue label={t.columns.location}>
                  {c.lastLocation
                    ? `${c.lastLocation.name} (${c.lastLocation.code})`
                    : t.notRecorded}
                </RowValue>
                <RowValue label={t.columns.lastChange}>
                  {formatDateTimeCs(c.lastEventAt, timeZone)}
                </RowValue>
              </li>
            ))}
          </ul>
        )}
      </Card>
      <p className="mt-3 text-xs text-stone-500">{t.noCirculationHelp}</p>
      {pages > 1 && (
        <nav
          className="mt-4 flex items-center justify-between text-sm"
          aria-label={t.pageOf(page, pages)}
        >
          {page > 1 ? (
            <Link href={link(page - 1)} className={buttonClass.secondary}>
              {t.previous}
            </Link>
          ) : (
            <span />
          )}
          <span className="text-stone-600">{t.pageOf(page, pages)}</span>
          {page < pages ? (
            <Link href={link(page + 1)} className={buttonClass.secondary}>
              {t.next}
            </Link>
          ) : (
            <span />
          )}
        </nav>
      )}
    </>
  );
}
