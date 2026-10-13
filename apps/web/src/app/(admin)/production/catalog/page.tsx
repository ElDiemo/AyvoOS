import { productSchema } from '@ayvo/types';
import Link from 'next/link';
import { z } from 'zod';
import { CatalogHeader, CatalogRow, RowValue } from '@/components/catalog/catalog-header';
import { buttonClass, Card, EmptyState } from '@/components/ui';
import { catalogCs } from '@/i18n/cs/catalog';
import { formatQuantityCs, unitCs } from '@/i18n/cs/format';
import { apiGet } from '@/lib/api';
import { currentUser, hasPermission } from '@/lib/session';

export const dynamic = 'force-dynamic';
const t = catalogCs.products;

/** Produkty a receptury → Produkty. */
export default async function ProductsPage() {
  const [me, products] = await Promise.all([
    currentUser(),
    apiGet('admin/catalog/products', z.array(productSchema)),
  ]);
  const canManage = hasPermission(me, 'catalog:product_manage');
  return (
    <>
      <CatalogHeader
        view="products"
        title={catalogCs.title}
        subtitle={catalogCs.subtitle}
        actions={
          canManage ? (
            <Link href="/production/catalog/products/new" className={buttonClass.primary}>
              {t.new}
            </Link>
          ) : null
        }
      />
      <Card>
        {products.length === 0 ? (
          <EmptyState>{t.empty}</EmptyState>
        ) : (
          <ul data-testid="products">
            {products.map((p) => (
              <CatalogRow key={p.code} testId={`product-${p.code}`}>
                <div className="min-w-0 wrap-anywhere">
                  <Link
                    href={`/production/catalog/products/${encodeURIComponent(p.code)}`}
                    className="font-medium underline-offset-2 hover:underline"
                  >
                    {p.name}
                  </Link>{' '}
                  <span className="font-mono text-xs text-stone-500">{p.code}</span>
                </div>
                <RowValue label={t.category}>{p.category.name}</RowValue>
                <RowValue label={t.nominal}>
                  {formatQuantityCs(p.nominalQuantity)} {unitCs(p.nominalUnit.code)}
                </RowValue>
                <RowValue label={t.activeVersion}>
                  {p.status === 'ARCHIVED' ? (
                    <span className="text-stone-500">{catalogCs.productStatus.ARCHIVED}</span>
                  ) : p.activeVersion ? (
                    `V${p.activeVersion}`
                  ) : (
                    <span className="text-stone-500">{t.noActive}</span>
                  )}
                </RowValue>
              </CatalogRow>
            ))}
          </ul>
        )}
      </Card>
    </>
  );
}
