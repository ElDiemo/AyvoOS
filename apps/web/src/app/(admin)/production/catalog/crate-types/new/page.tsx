import { productCategorySchema } from '@ayvo/types';
import { z } from 'zod';
import { CatalogHeader } from '@/components/catalog/catalog-header';
import { CrateTypeForm } from '@/components/catalog/crate-type-form';
import { catalogCs } from '@/i18n/cs/catalog';
import { apiGet } from '@/lib/api';
import { requirePermission } from '@/lib/session';

export const dynamic = 'force-dynamic';

export default async function NewCrateTypePage() {
  await requirePermission('catalog:product_manage');
  const categories = await apiGet('admin/catalog/categories', z.array(productCategorySchema));
  return (
    <>
      <CatalogHeader
        view="crate-types"
        title={catalogCs.crateTypes.newTitle}
        back={{ href: '/production/catalog/crate-types', label: catalogCs.crateTypes.title }}
      />
      <CrateTypeForm categories={categories} />
    </>
  );
}
