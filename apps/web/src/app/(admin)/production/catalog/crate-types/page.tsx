import { crateTypeSchema } from '@ayvo/types';
import Link from 'next/link';
import { z } from 'zod';
import { CatalogHeader, CatalogRow, RowValue } from '@/components/catalog/catalog-header';
import { SuccessNote } from '@/components/catalog/form-kit';
import { buttonClass, Card, EmptyState } from '@/components/ui';
import { catalogCs } from '@/i18n/cs/catalog';
import { apiGet } from '@/lib/api';
import { currentUser, hasPermission } from '@/lib/session';

export const dynamic = 'force-dynamic';
const t = catalogCs.crateTypes;

/** Produkty a receptury → Typy beden (definitions, not physical crates). */
export default async function CrateTypesPage({
  searchParams,
}: {
  searchParams: Promise<{ created?: string }>;
}) {
  const [me, crateTypes, { created }] = await Promise.all([
    currentUser(),
    apiGet('admin/catalog/crate-types', z.array(crateTypeSchema)),
    searchParams,
  ]);
  const createdType = created ? crateTypes.find((c) => c.code === created) : undefined;
  return (
    <>
      <CatalogHeader
        view="crate-types"
        title={t.title}
        subtitle={t.help}
        actions={
          hasPermission(me, 'catalog:product_manage') ? (
            <Link href="/production/catalog/crate-types/new" className={buttonClass.primary}>
              {t.new}
            </Link>
          ) : null
        }
      />
      {createdType && (
        <div className="mb-4">
          <SuccessNote>{t.created(createdType.name)}</SuccessNote>
        </div>
      )}
      <Card>
        {crateTypes.length === 0 ? (
          <EmptyState>{t.empty}</EmptyState>
        ) : (
          <ul data-testid="crate-types">
            {crateTypes.map((c) => (
              <CatalogRow key={c.code} testId={`crate-${c.code}`}>
                <div className="min-w-0 wrap-anywhere">
                  <Link
                    href={`/production/catalog/crate-types/${encodeURIComponent(c.code)}`}
                    className="font-medium underline-offset-2 hover:underline"
                  >
                    {c.name}
                  </Link>{' '}
                  <span className="font-mono text-xs text-stone-500">{c.code}</span>
                </div>
                <RowValue label={t.capacity}>{c.capacity}</RowValue>
                <RowValue label={t.categories}>
                  {c.categories.map((x) => x.name).join(', ')}
                </RowValue>
                <span className="hidden md:block" />
              </CatalogRow>
            ))}
          </ul>
        )}
      </Card>
    </>
  );
}
