import {
  outsideBottleGroupSchema,
  outsideBottlesPageSchema,
  outsideBottlesQuerySchema,
  type OutsideBottle,
  type OutsideBottleGroup,
} from '@ayvo/types';
import Link from 'next/link';
import { ProductionHeader } from '@/components/production/production-header';
import { BottleStatusBadge } from '@/components/status';
import { buttonClass, Card, EmptyState, inputClass } from '@/components/ui';
import { cratesCs } from '@/i18n/cs/crates';
import { formatDateTimeCs } from '@/i18n/cs/format';
import { apiGet } from '@/lib/api';
import { currentUser, hasPermission, siteTimeZone } from '@/lib/session';

export const dynamic = 'force-dynamic';
const t = cratesCs;
const PAGE_SIZE = 50;
const LABELS: Record<OutsideBottleGroup, string> = {
  finished: t.outside.finished,
  labelledEmpty: t.outside.labelledEmpty,
  legacy: t.outside.legacy,
};

type Search = { group?: string; page?: string; search?: string };

/**
 * Výroba → Bedny → Lahve mimo bednu (doc 025 §3.3, A5): labelled bottles of the active site in no
 * crate, one group and one bounded page at a time, with an exact search by code or scanned QR — so
 * every bottle stays reachable (PR #25 review A5-R1). The crate it left, when and why; the liquid
 * lot of a finished bottle. Links to the bottle only for users who may open it (production:read).
 */
export default async function OutsideBottlesPage({
  searchParams,
}: {
  searchParams: Promise<Search>;
}) {
  const raw = await searchParams;
  const parsed = outsideBottlesQuerySchema.safeParse({
    group: raw.group || undefined,
    page: raw.page || undefined,
    pageSize: PAGE_SIZE,
    search: raw.search || undefined,
  });
  const query = parsed.success
    ? parsed.data
    : outsideBottlesQuerySchema.parse({ pageSize: PAGE_SIZE });
  const [me, data, timeZone] = await Promise.all([
    currentUser(),
    apiGet('admin/bottles-outside-crates', outsideBottlesPageSchema, {
      group: query.group,
      page: query.page,
      pageSize: query.pageSize,
      search: query.search,
    }),
    siteTimeZone(),
  ]);
  const canOpenBottle = hasPermission(me, 'production:read');
  const pages = Math.max(1, Math.ceil(data.total / data.pageSize));
  const link = (p: Partial<Search>) => {
    const q = new URLSearchParams();
    const next = { group: query.group, search: query.search, ...p };
    for (const [k, v] of Object.entries(next)) if (v) q.set(k, String(v));
    return `/production/crates/outside?${q.toString()}`;
  };
  const from = data.total === 0 ? 0 : (data.page - 1) * data.pageSize + 1;
  const to = Math.min(data.total, data.page * data.pageSize);

  return (
    <>
      <ProductionHeader
        active="crates"
        title={t.outside.title}
        subtitle={t.outside.subtitle}
        back={{ href: '/production/crates', label: t.backToList }}
      />
      <nav className="mb-4 flex flex-wrap gap-2" aria-label={t.outside.title}>
        {outsideBottleGroupSchema.options.map((group) => (
          <Link
            key={group}
            href={link({ group, page: undefined, search: undefined })}
            data-testid={`outside-group-${group}`}
            aria-current={query.group === group ? 'page' : undefined}
            className={
              query.group === group
                ? 'rounded-full border border-stone-900 bg-stone-900 px-3 py-1 text-sm text-white'
                : 'rounded-full border border-stone-300 bg-white px-3 py-1 text-sm text-stone-800 hover:border-stone-500'
            }
          >
            {t.outside.groupCount(LABELS[group], data.totals[group] ?? 0)}
          </Link>
        ))}
      </nav>
      <Card className="mb-6">
        <form
          className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_auto]"
          action="/production/crates/outside"
          data-testid="outside-search"
        >
          <input type="hidden" name="group" value={query.group} />
          <input
            name="search"
            defaultValue={query.search}
            placeholder={t.outside.searchPlaceholder}
            className={inputClass}
            aria-label={t.outside.search}
            autoComplete="off"
          />
          <div className="flex gap-2">
            <button type="submit" className={buttonClass.secondary}>
              {t.outside.find}
            </button>
            {query.search && (
              <Link
                href={link({ search: undefined, page: undefined })}
                className={buttonClass.secondary}
              >
                {t.outside.reset}
              </Link>
            )}
          </div>
        </form>
      </Card>
      <Card title={LABELS[query.group]} testId={`outside-${query.group}`}>
        {query.group === 'legacy' && (
          <p className="mb-3 text-xs text-stone-500">{t.outside.legacyHelp}</p>
        )}
        {data.items.length === 0 ? (
          <EmptyState>{query.search ? t.outside.noMatch : t.outside.none}</EmptyState>
        ) : (
          <>
            <ul className="flex flex-col divide-y divide-stone-100 text-sm">
              {data.items.map((b) => (
                <Row key={b.code} bottle={b} timeZone={timeZone} canOpen={canOpenBottle} />
              ))}
            </ul>
            <p className="mt-2 text-xs text-stone-500" data-testid="outside-range">
              {t.outside.range(from, to, data.total)}
            </p>
          </>
        )}
      </Card>
      {pages > 1 && (
        <nav
          className="mt-4 flex items-center justify-between text-sm"
          aria-label={t.pageOf(data.page, pages)}
        >
          {data.page > 1 ? (
            <Link href={link({ page: String(data.page - 1) })} className={buttonClass.secondary}>
              {t.previous}
            </Link>
          ) : (
            <span />
          )}
          <span className="text-stone-600">{t.pageOf(data.page, pages)}</span>
          {data.page < pages ? (
            <Link href={link({ page: String(data.page + 1) })} className={buttonClass.secondary}>
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

function Row({
  bottle: b,
  timeZone,
  canOpen,
}: {
  bottle: OutsideBottle;
  timeZone: string;
  canOpen: boolean;
}) {
  return (
    <li
      className="grid grid-cols-1 gap-x-4 gap-y-1 py-2 md:grid-cols-[minmax(0,1fr)_auto_minmax(0,2fr)] md:items-center"
      data-testid={`outside-${b.code}`}
    >
      {canOpen ? (
        <Link href={`/bottles/${b.code}`} className="font-mono underline-offset-2 hover:underline">
          {b.code}
        </Link>
      ) : (
        <span className="font-mono">{b.code}</span>
      )}
      <BottleStatusBadge status={b.status} />
      <span className="text-xs text-stone-600">
        {[
          b.product && `${b.product.name}${b.recipeVersion ? ` · v${b.recipeVersion}` : ''}`,
          b.design,
          b.liquidLot && t.outside.lot(b.liquidLot),
          b.lastCrate &&
            b.leftAt &&
            t.outside.lastCrate(b.lastCrate, formatDateTimeCs(b.leftAt, timeZone)),
          b.reason && t.outside.reason(b.reason),
        ]
          .filter(Boolean)
          .join(' · ')}
      </span>
    </li>
  );
}
