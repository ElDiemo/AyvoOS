import {
  bottleListResponseSchema,
  goodsReceiptPageSchema,
  stockOverviewSchema,
  stockSummarySchema,
  supplierSchema,
} from '@ayvo/types';
import { StatusBadge } from '@ayvo/ui';
import Link from 'next/link';
import { unstable_rethrow } from 'next/navigation';
import { z } from 'zod';
import { buttonClass, Notice, PageHeader, Stat } from '@/components/ui';
import { formatQuantityCs, unitCs } from '@/i18n/cs/format';
import { catalogCs } from '@/i18n/cs/catalog';
import { identityCs } from '@/i18n/cs/identity';
import { shellCs } from '@/i18n/cs/shell';
import { apiGet } from '@/lib/api';
import { fetchApiHealth } from '@/lib/api-health';
import { serverEnv } from '@/lib/env';
import { moduleById } from '@/lib/navigation';
import { currentUser, hasPermission } from '@/lib/session';

// Always render at request time so figures and the API status are live.
export const dynamic = 'force-dynamic';
const h = shellCs.home;

/** A module's figures, or null when they could not be loaded (the overview still renders). */
async function settle<T>(load: () => Promise<T>): Promise<T | null> {
  try {
    return await load();
  } catch (error) {
    unstable_rethrow(error); // sign-in / forbidden redirects must not be swallowed
    return null;
  }
}

async function warehouseFigures() {
  const [stock, pending, suppliers] = await Promise.all([
    apiGet('admin/inventory/stock', stockOverviewSchema),
    apiGet('admin/goods-receipts', goodsReceiptPageSchema, {
      page: 1,
      pageSize: 1,
      invoice: 'pending',
    }),
    apiGet('admin/suppliers', z.array(supplierSchema)),
  ]);
  const newBottles = stock.items.find((s) => s.item.code === 'NEW_BOTTLE');
  return {
    newBottlesOnHand: newBottles?.onHand ?? '0',
    unit: unitCs(newBottles?.item.unit.code ?? 'pcs'),
    lowStock: stock.items.filter((s) => s.lowStock).map((s) => s.item.name),
    pendingInvoices: pending.total,
    suppliers: suppliers.filter((s) => !s.archivedAt).length,
  };
}

async function availabilityFigures() {
  const summary = await apiGet('admin/inventory/stock-summary', stockSummarySchema);
  return { lowStock: summary.items.filter((s) => s.lowStock).map((s) => s.item.name) };
}

async function productionFigures() {
  const total = (status?: 'CREATED' | 'LABELED_EMPTY') =>
    apiGet('admin/bottles', bottleListResponseSchema, { page: 1, pageSize: 1, status }).then(
      (r) => r.total,
    );
  const [bottles, awaiting, labeled] = await Promise.all([
    total(),
    total('CREATED'),
    total('LABELED_EMPTY'),
  ]);
  return { bottles, awaiting, labeled };
}

/**
 * Přehled (doc 019): the operational overview of the implemented modules — real figures only,
 * the next useful actions, warnings and the system status. Future modules get no placeholder.
 */
export default async function HomePage() {
  const user = await currentUser();
  // Warehouse figures belong to the active site; without one (several sites, none chosen) or at a
  // site without a warehouse the overview offers the site choice instead of redirecting.
  const activeSite = user.sites.find((s) => s.id === user.activeSiteId) ?? null;
  const siteHasWarehouse = !!activeSite?.capabilities.includes('WAREHOUSE');
  const needsSite = !activeSite && user.sites.length > 1;
  const canWarehouse = siteHasWarehouse && hasPermission(user, 'inventory:read');
  // Planning-only stock access (SALES) without the full warehouse.
  const canAvailability =
    siteHasWarehouse && !canWarehouse && hasPermission(user, 'inventory:stock_summary');
  const canProduction =
    !!activeSite?.capabilities.includes('PRODUCTION') && hasPermission(user, 'production:read');
  // The company-wide catalogue needs no site (doc 023); shown when production itself is not.
  const canCatalog = !canProduction && hasPermission(user, 'catalog:read');
  const [health, warehouse, availability, production] = await Promise.all([
    fetchApiHealth(serverEnv.API_URL),
    canWarehouse ? settle(warehouseFigures) : null,
    canAvailability ? settle(availabilityFigures) : null,
    canProduction ? settle(productionFigures) : null,
  ]);
  const warehouseModule = moduleById('warehouse');
  const productionModule = moduleById('production');

  return (
    <>
      <PageHeader title={h.title} subtitle={h.subtitle} />
      <div className="flex flex-col gap-6">
        {needsSite && (
          <Notice tone="warning">
            <Link href="/select-site" className="underline" data-testid="choose-site">
              {identityCs.shell.chooseSite}
            </Link>
          </Notice>
        )}
        {!needsSite && !canWarehouse && !canAvailability && !canProduction && !canCatalog && (
          <Notice tone="info">{h.noModules}</Notice>
        )}
        <div className="grid grid-cols-1 gap-6 xl:grid-cols-2">
          {canWarehouse && (
            <ModulePanel
              href={warehouseModule.href}
              title={warehouseModule.label}
              description={warehouseModule.description}
              testId="module-warehouse"
              openLabel={h.openWarehouse}
              actions={
                hasPermission(user, 'inventory:receive') ? (
                  <Link href="/warehouse/receipts/new" className={buttonClass.primary}>
                    {shellCs.actions.newReceipt}
                  </Link>
                ) : null
              }
            >
              {warehouse ? (
                <>
                  <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
                    <Stat
                      label={h.newBottlesOnHand}
                      value={formatQuantityCs(warehouse.newBottlesOnHand)}
                      unit={warehouse.unit}
                      tone={warehouse.newBottlesOnHand === '0' ? 'warning' : 'neutral'}
                      href="/warehouse/stock"
                      testId="home-new-bottles"
                    />
                    <Stat
                      label={h.receiptsPendingInvoice}
                      value={warehouse.pendingInvoices}
                      tone={warehouse.pendingInvoices > 0 ? 'warning' : 'neutral'}
                      href="/warehouse/receipts?invoice=pending"
                    />
                    <Stat
                      label={h.suppliers}
                      value={warehouse.suppliers}
                      href="/warehouse/suppliers"
                    />
                  </div>
                  <Warnings
                    items={[
                      warehouse.suppliers === 0 && h.noSuppliers,
                      warehouse.newBottlesOnHand === '0' && h.noStock,
                      warehouse.lowStock.length > 0 &&
                        h.lowStockWarning(warehouse.lowStock.join(', ')),
                      warehouse.pendingInvoices > 0 &&
                        h.pendingInvoiceWarning(warehouse.pendingInvoices),
                    ]}
                  />
                </>
              ) : (
                <Notice>{shellCs.common.errorTitle}</Notice>
              )}
            </ModulePanel>
          )}

          {canAvailability && (
            <ModulePanel
              href="/warehouse/availability"
              title={warehouseModule.label}
              description={h.availabilityDescription}
              testId="module-availability"
              openLabel={h.openAvailability}
              actions={null}
            >
              {availability ? (
                availability.lowStock.length > 0 ? (
                  <Warnings items={[h.lowStockWarning(availability.lowStock.join(', '))]} />
                ) : (
                  <p className="text-sm text-stone-600">{h.allAvailable}</p>
                )
              ) : (
                <Notice>{shellCs.common.errorTitle}</Notice>
              )}
            </ModulePanel>
          )}

          {canCatalog && (
            <ModulePanel
              href="/production/catalog"
              title={shellCs.modules.production.pages.catalog}
              description={h.catalogDescription}
              testId="module-catalog"
              openLabel={h.openCatalog}
              actions={null}
            >
              <p className="text-sm text-stone-600">{catalogCs.scopeNote}</p>
            </ModulePanel>
          )}

          {canProduction && (
            <ModulePanel
              href={productionModule.href}
              title={productionModule.label}
              description={productionModule.description}
              testId="module-production"
              openLabel={h.openProduction}
              actions={
                <>
                  <Link href="/production/station" className={buttonClass.primary}>
                    {shellCs.actions.labelActivation}
                  </Link>
                  {hasPermission(user, 'production:bottles_create') && (
                    <Link href="/bottles/new" className={buttonClass.secondary}>
                      {shellCs.actions.createBottles}
                    </Link>
                  )}
                </>
              }
            >
              {production ? (
                <>
                  <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
                    <Stat label={h.bottles} value={production.bottles} href="/bottles" />
                    <Stat
                      label={h.awaitingLabel}
                      value={production.awaiting}
                      href="/bottles?status=CREATED"
                      testId="home-awaiting-label"
                    />
                    <Stat
                      label={h.labeled}
                      value={production.labeled}
                      href="/bottles?status=LABELED_EMPTY"
                    />
                  </div>
                  <Warnings items={[production.bottles === 0 && h.noBottles]} />
                </>
              ) : (
                <Notice>{shellCs.common.errorTitle}</Notice>
              )}
            </ModulePanel>
          )}
        </div>

        <section
          data-testid="api-status"
          className="flex flex-wrap items-center gap-x-6 gap-y-2 rounded-lg border border-stone-200 bg-white px-5 py-3 text-sm"
        >
          <h2 className="text-xs font-medium uppercase tracking-wide text-stone-500">{h.system}</h2>
          {health.reachable ? (
            <>
              {(
                [
                  [h.services.api, health.health.status === 'ok'],
                  [h.services.database, health.health.checks.database === 'up'],
                  [h.services.redis, health.health.checks.redis === 'up'],
                ] as const
              ).map(([label, up]) => (
                <span key={label} className="flex items-center gap-2">
                  {label}
                  <StatusBadge tone={up ? 'ok' : 'error'}>{up ? h.up : h.down}</StatusBadge>
                </span>
              ))}
            </>
          ) : (
            <StatusBadge tone="error">{h.apiUnreachable}</StatusBadge>
          )}
        </section>
      </div>
    </>
  );
}

function ModulePanel({
  href,
  title,
  description,
  actions,
  testId,
  openLabel,
  children,
}: {
  href: string;
  title: string;
  description: string;
  actions: React.ReactNode | null;
  testId: string;
  openLabel: string;
  children: React.ReactNode;
}) {
  return (
    <section
      className="flex min-w-0 flex-col gap-4 rounded-lg border border-stone-200 bg-white p-5 shadow-sm sm:p-6"
      data-testid={testId}
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 className="text-lg font-semibold">
            <Link href={href} className="hover:underline">
              {title}
            </Link>
          </h2>
          <p className="text-sm text-stone-600">{description}</p>
        </div>
        <Link
          href={href}
          className="text-sm font-medium whitespace-nowrap text-stone-700 hover:underline"
        >
          {openLabel} →
        </Link>
      </div>
      {children}
      <div className="flex flex-wrap gap-2">{actions}</div>
    </section>
  );
}

function Warnings({ items }: { items: (string | false)[] }) {
  const shown = items.filter((i): i is string => !!i);
  if (shown.length === 0) return null;
  return (
    <ul className="flex flex-col gap-2">
      {shown.map((text) => (
        <li key={text}>
          <Notice>{text}</Notice>
        </li>
      ))}
    </ul>
  );
}
