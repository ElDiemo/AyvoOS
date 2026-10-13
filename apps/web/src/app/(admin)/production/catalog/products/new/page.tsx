import { catalogUnitSchema, productCategorySchema } from '@ayvo/types';
import { z } from 'zod';
import { CatalogHeader } from '@/components/catalog/catalog-header';
import { ProductForm } from '@/components/catalog/product-form';
import { catalogCs } from '@/i18n/cs/catalog';
import { apiGet } from '@/lib/api';
import { requirePermission } from '@/lib/session';

export const dynamic = 'force-dynamic';

export default async function NewProductPage() {
  await requirePermission('catalog:product_manage');
  const [units, categories] = await Promise.all([
    apiGet('admin/catalog/units', z.array(catalogUnitSchema)),
    apiGet('admin/catalog/categories', z.array(productCategorySchema)),
  ]);
  return (
    <>
      <CatalogHeader
        view="products"
        title={catalogCs.products.newTitle}
        back={{ href: '/production/catalog', label: catalogCs.products.title }}
      />
      <ProductForm units={units} categories={categories} />
    </>
  );
}
