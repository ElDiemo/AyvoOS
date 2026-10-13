import { productCodeSchema, productSchema } from '@ayvo/types';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { CatalogHeader, CatalogRow, RowValue } from '@/components/catalog/catalog-header';
import { SuccessNote } from '@/components/catalog/form-kit';
import {
  ArchiveProduct,
  NewDraftButton,
  RenameProduct,
} from '@/components/catalog/product-actions';
import { RecipeStatusBadge } from '@/components/catalog/recipe-status';
import { Card, EmptyState, Field, FieldList, Notice } from '@/components/ui';
import { catalogCs } from '@/i18n/cs/catalog';
import { formatDateTimeCs, formatQuantityCs, unitCs } from '@/i18n/cs/format';
import { apiGet } from '@/lib/api';
import { currentUser, hasPermission, siteTimeZone } from '@/lib/session';

export const dynamic = 'force-dynamic';
const t = catalogCs.products;

/** Product detail: immutable identity, name correction, archiving and the recipe version history. */
export default async function ProductPage({
  params,
  searchParams,
}: {
  params: Promise<{ code: string }>;
  searchParams: Promise<{ created?: string }>;
}) {
  const { code } = await params;
  if (!productCodeSchema.safeParse(code).success) notFound();
  const [me, product, { created }, tz] = await Promise.all([
    currentUser(),
    apiGet(`admin/catalog/products/${encodeURIComponent(code)}`, productSchema),
    searchParams,
    siteTimeZone(),
  ]);
  const canManage = hasPermission(me, 'catalog:product_manage');
  const active = product.status === 'ACTIVE';
  return (
    <>
      <CatalogHeader
        view={null}
        title={<span data-testid="product-name">{product.name}</span>}
        subtitle={
          <span className="font-mono" data-testid="product-code">
            {product.code}
          </span>
        }
        back={{ href: '/production/catalog', label: catalogCs.common.back }}
      />
      <div className="flex flex-col gap-6">
        {created && <SuccessNote>{t.created(product.name)}</SuccessNote>}
        {!active && <Notice tone="warning">{t.archivedNote}</Notice>}
        <div className="grid grid-cols-1 gap-6 xl:grid-cols-[minmax(0,1fr)_24rem]">
          <div className="flex min-w-0 flex-col gap-6">
            <Card>
              <FieldList>
                <Field label={t.category}>{product.category.name}</Field>
                <Field label={t.nominal}>
                  {formatQuantityCs(product.nominalQuantity)} {unitCs(product.nominalUnit.code)}
                </Field>
                <Field label={t.status}>
                  <span data-testid="product-status">
                    {catalogCs.productStatus[product.status]}
                  </span>
                </Field>
                <Field label={t.activeVersion}>
                  {product.activeVersion ? (
                    <Link
                      className="underline"
                      href={`/production/catalog/products/${encodeURIComponent(product.code)}/recipes/${product.activeVersion}`}
                    >
                      V{product.activeVersion}
                    </Link>
                  ) : (
                    t.noActive
                  )}
                </Field>
              </FieldList>
              <p className="mt-3 text-xs text-stone-500">{t.immutable}</p>
            </Card>
            <Card title={t.versions}>
              <div className="flex flex-col gap-4">
                {canManage && active && (
                  <NewDraftButton
                    productCode={product.code}
                    basedOn={null}
                    label={t.newDraft}
                    title={t.newDraftTitle}
                    help={t.newDraftHelp}
                  />
                )}
                {product.versions.length === 0 ? (
                  <EmptyState>{t.noVersions}</EmptyState>
                ) : (
                  <ul data-testid="versions">
                    {[...product.versions].reverse().map((v) => (
                      <CatalogRow key={v.version} testId={`version-${v.version}`}>
                        <div className="flex min-w-0 flex-wrap items-center gap-2">
                          <Link
                            className="font-medium underline-offset-2 hover:underline"
                            href={`/production/catalog/products/${encodeURIComponent(product.code)}/recipes/${v.version}`}
                          >
                            {t.version} V{v.version}
                          </Link>
                          <RecipeStatusBadge status={v.status} />
                        </div>
                        <RowValue label={t.revision}>
                          {t.revision} {v.revision}
                          {v.basedOnVersion ? ` · ${t.basedOn} V${v.basedOnVersion}` : ''}
                        </RowValue>
                        <RowValue label={t.createdLabel}>
                          {formatDateTimeCs(v.createdAt, tz)}
                        </RowValue>
                        <RowValue label={v.archivedAt ? t.archivedAt : t.activated}>
                          {v.archivedAt
                            ? `${t.archivedAt} ${formatDateTimeCs(v.archivedAt, tz)}`
                            : v.activatedAt
                              ? `${t.activated} ${formatDateTimeCs(v.activatedAt, tz)}`
                              : catalogCs.common.none}
                        </RowValue>
                      </CatalogRow>
                    ))}
                  </ul>
                )}
                <p className="text-xs text-stone-500">{t.authorNote}</p>
              </div>
            </Card>
          </div>
          {canManage && active && (
            <div className="flex min-w-0 flex-col gap-6">
              <RenameProduct product={product} />
              <Card>
                <ArchiveProduct product={product} />
              </Card>
            </div>
          )}
        </div>
      </div>
    </>
  );
}
