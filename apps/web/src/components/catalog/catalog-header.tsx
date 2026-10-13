import { ProductionHeader } from '@/components/production/production-header';
import { ViewSwitch } from '@/components/shell/module-header';
import { catalogCs } from '@/i18n/cs/catalog';

export type CatalogView = 'products' | 'components' | 'crate-types';

const VIEWS = [
  { id: 'products', href: '/production/catalog', label: catalogCs.views.products },
  { id: 'components', href: '/production/catalog/components', label: catalogCs.views.components },
  { id: 'crate-types', href: '/production/catalog/crate-types', label: catalogCs.views.crateTypes },
] as const;

/**
 * Výroba → Produkty a receptury: module navigation, the page title, the three catalogue views and
 * the permanent scope note (company-wide catalogue, site-bound stock, no stock movement).
 */
export function CatalogHeader({
  view,
  title,
  subtitle,
  actions,
  back,
}: {
  view: CatalogView | null;
  title: React.ReactNode;
  subtitle?: React.ReactNode;
  actions?: React.ReactNode;
  back?: { href: string; label: string };
}) {
  return (
    <>
      <ProductionHeader
        active="catalog"
        title={title}
        subtitle={subtitle}
        actions={actions}
        back={back}
      />
      <p
        className="-mt-4 mb-4 rounded-md border border-stone-200 bg-stone-50 px-3 py-2 text-sm text-stone-700"
        data-testid="catalog-scope"
      >
        {catalogCs.scopeNote}
      </p>
      {view && <ViewSwitch label={catalogCs.views.label} views={VIEWS} active={view} />}
    </>
  );
}

/** One row of a catalogue list: stacks on phones (no sideways scrolling), a grid on wide screens. */
export function CatalogRow({ children, testId }: { children: React.ReactNode; testId?: string }) {
  return (
    <li
      className="grid grid-cols-1 gap-x-4 gap-y-1 border-t border-stone-100 py-3 text-sm first:border-t-0 md:grid-cols-[minmax(0,2fr)_repeat(3,minmax(0,1fr))] md:items-center"
      data-testid={testId}
    >
      {children}
    </li>
  );
}

/** A labelled value inside a CatalogRow (the label is visible on phones only). */
export function RowValue({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex min-w-0 gap-2 wrap-anywhere md:block">
      <span className="text-xs text-stone-500 md:sr-only">{label}:</span>
      <span>{children}</span>
    </div>
  );
}
