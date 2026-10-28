import { catalogComponentSchema } from '@ayvo/types';
import Link from 'next/link';
import { z } from 'zod';
import { CatalogHeader, CatalogRow, RowValue } from '@/components/catalog/catalog-header';
import { SuccessNote } from '@/components/catalog/form-kit';
import { buttonClass, Card, EmptyState } from '@/components/ui';
import { catalogCs } from '@/i18n/cs/catalog';
import { unitCs } from '@/i18n/cs/format';
import { apiGet } from '@/lib/api';
import { currentUser, hasPermission } from '@/lib/session';

export const dynamic = 'force-dynamic';
const t = catalogCs.components;

/** Produkty a receptury → Komponenty (inventory items of component kinds + catalogue profile). */
export default async function ComponentsPage({
  searchParams,
}: {
  searchParams: Promise<{ created?: string }>;
}) {
  const [me, components, { created }] = await Promise.all([
    currentUser(),
    apiGet('admin/catalog/components', z.array(catalogComponentSchema)),
    searchParams,
  ]);
  const createdItem = created ? components.find((c) => c.code === created) : undefined;
  return (
    <>
      <CatalogHeader
        view="components"
        title={t.title}
        subtitle={t.help}
        actions={
          hasPermission(me, 'catalog:product_manage') ? (
            <Link href="/production/catalog/components/new" className={buttonClass.primary}>
              {t.new}
            </Link>
          ) : null
        }
      />
      {createdItem && (
        <div className="mb-4">
          <SuccessNote>{t.created(createdItem.name)}</SuccessNote>
        </div>
      )}
      <Card>
        {components.length === 0 ? (
          <EmptyState>{t.empty}</EmptyState>
        ) : (
          <ul data-testid="components">
            {components.map((c) => (
              <CatalogRow key={c.code} testId={`component-${c.code}`}>
                <div className="min-w-0 wrap-anywhere">
                  <Link
                    href={`/production/catalog/components/${encodeURIComponent(c.code)}`}
                    className="font-medium underline-offset-2 hover:underline"
                  >
                    {c.name}
                  </Link>{' '}
                  <span className="font-mono text-xs text-stone-500">{c.code}</span>
                  {c.archived && <span className="block text-xs text-amber-800">{t.archived}</span>}
                </div>
                <RowValue label={t.kind}>
                  {catalogCs.kinds[c.kind]} · {unitCs(c.unit.code)}
                </RowValue>
                <RowValue label={t.category}>
                  {c.category?.name ??
                    (c.kind === 'LABEL_MEDIA' ? t.sharedLabelShort : catalogCs.common.any)}
                </RowValue>
                <RowValue label={t.lotTracked}>
                  {c.kind === 'PACKAGING'
                    ? `${t.packageCapacity}: ${c.packageCapacity ?? t.unknown}`
                    : (c.lotTracked ? t.lotTracked : `${t.lotTracked}: ${catalogCs.common.no}`) +
                      (c.kind === 'LABEL_MEDIA' && c.packageCapacity
                        ? ` · ${t.piecesPerRoll}: ${c.packageCapacity}`
                        : '')}
                </RowValue>
              </CatalogRow>
            ))}
          </ul>
        )}
      </Card>
    </>
  );
}
