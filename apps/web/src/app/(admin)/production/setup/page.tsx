import { productionReadinessSchema, type ReadinessItem } from '@ayvo/types';
import Link from 'next/link';
import { ProductionHeader } from '@/components/production/production-header';
import { Card, EmptyState } from '@/components/ui';
import { readinessCs as t } from '@/i18n/cs/readiness';
import { apiGet } from '@/lib/api';
import { requireAnyPermission } from '@/lib/session';
import { readinessDependency, readinessStep } from '@/components/production/readiness-actions';

export const dynamic = 'force-dynamic';

const tone: Record<ReadinessItem['state'], string> = {
  OK: 'border-emerald-300 bg-emerald-50 text-emerald-900',
  MISSING: 'border-amber-300 bg-amber-50 text-amber-950',
  UNAVAILABLE: 'border-stone-200 bg-stone-50 text-stone-500',
};

/**
 * Výroba → Nastavení výroby → Připravit výrobu (doc 027 §4): read-only, for the active site and
 * one product. Labelling and filling are listed separately; each item comes from the server only
 * with its own permission (otherwise "Nedostupné", never 0). It permits and blocks nothing.
 */
export default async function ProductionSetupPage({
  searchParams,
}: {
  searchParams: Promise<{ product?: string }>;
}) {
  const me = await requireAnyPermission([
    'production:workstations_manage',
    'catalog:product_manage',
  ]);
  const { product } = await searchParams;
  const r = await apiGet('admin/production/readiness', productionReadinessSchema, {
    product: typeof product === 'string' && product ? product : undefined,
  });
  /** The concrete next step of a missing item, or who to ask (issue #11 UI-21). */
  const Step = ({ item }: { item: ReadinessItem }) => {
    const dependency = readinessDependency(item, r);
    const step = readinessStep(item, me.permissions, r.product?.code ?? null);
    if (!dependency && step.kind === 'none') return null;
    return (
      <span className="flex w-full flex-col gap-1 text-xs" data-testid={`step-${item.key}`}>
        {dependency && <span>{dependency}</span>}
        {step.kind === 'links' &&
          step.links.map((l) => (
            <Link key={l.href} href={l.href} className="self-start font-medium underline">
              {t.actions.next}: {l.label} →
            </Link>
          ))}
        {step.kind === 'ask' && (
          <>
            <span data-testid="ask-supervisor">{t.askSupervisor}</span>
            {step.read && (
              <Link href={step.read.href} className="self-start underline">
                {step.read.label}
              </Link>
            )}
          </>
        )}
      </span>
    );
  };
  const section = (key: 'setup' | 'labeling' | 'filling', items: ReadinessItem[]) => (
    <Card title={t.sections[key]} testId={`readiness-${key}`}>
      {key !== 'setup' && <p className="mb-3 text-xs text-stone-500">{t.sectionHelp[key]}</p>}
      <ul className="flex flex-col gap-2 text-sm">
        {items.map((i) => (
          <li
            key={`${i.key}-${i.recipe?.version ?? ''}`}
            data-testid={`readiness-${i.key}`}
            data-state={i.state}
            data-recipe={i.recipe?.version}
            className={`flex flex-wrap items-center justify-between gap-2 rounded-md border px-3 py-2 ${tone[i.state]}`}
          >
            <span className="min-w-0">
              <span className="font-medium">{t.items[i.key] ?? i.key}</span>
              {i.count !== null && t.count[i.key] && i.state === 'OK' && (
                <span className="ml-2 text-xs">{t.count[i.key]!(i.count)}</span>
              )}
              {i.recipe && (
                <span className="block text-xs opacity-80">
                  {i.recipe.waitingCrates === null
                    ? t.recipePlan(i.recipe.version)
                    : t.recipeWaiting(i.recipe.version, i.recipe.waitingCrates)}
                </span>
              )}
            </span>
            <span className="flex items-center gap-3 text-xs">
              <span>{i.reason === 'NO_WAREHOUSE' ? t.noWarehouse : t.state[i.state]}</span>
            </span>
            {i.state !== 'OK' && <Step item={i} />}
          </li>
        ))}
      </ul>
      {key === 'labeling' && <p className="mt-3 text-xs text-stone-500">{t.printNote}</p>}
    </Card>
  );

  return (
    <>
      <ProductionHeader active="setup" title={t.title} subtitle={t.subtitle} />
      {r.products.length > 0 && (
        <nav
          className="mb-4 flex flex-wrap gap-2"
          aria-label={t.product}
          data-testid="readiness-products"
        >
          {r.products.map((p) => (
            <Link
              key={p.code}
              href={`/production/setup?product=${encodeURIComponent(p.code)}`}
              aria-current={r.product?.code === p.code ? 'page' : undefined}
              className={
                r.product?.code === p.code
                  ? 'rounded-full border border-stone-900 bg-stone-900 px-3 py-1 text-sm text-white'
                  : 'rounded-full border border-stone-300 bg-white px-3 py-1 text-sm text-stone-800 hover:border-stone-500'
              }
            >
              {p.name}
            </Link>
          ))}
        </nav>
      )}
      <div className="grid gap-6 lg:grid-cols-2">
        {section('setup', r.setup)}
        {r.product ? (
          <>
            <Card title={t.sections.crates} testId="readiness-crates">
              {r.crates ? (
                <dl className="grid grid-cols-2 gap-3 text-sm sm:grid-cols-4">
                  {Object.entries(r.crates).map(([k, n]) => (
                    <div key={k}>
                      <dt className="text-xs text-stone-500">{t.crateStates[k]}</dt>
                      <dd className="text-2xl font-bold tabular-nums">{n}</dd>
                    </div>
                  ))}
                </dl>
              ) : (
                <p className="text-sm text-stone-500">{t.cratesUnavailable}</p>
              )}
            </Card>
            {section('labeling', r.labeling)}
            {section('filling', r.filling)}
          </>
        ) : (
          <EmptyState>{t.noProduct}</EmptyState>
        )}
      </div>
    </>
  );
}
