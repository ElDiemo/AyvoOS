import {
  catalogComponentSchema,
  crateTypeSchema,
  productCodeSchema,
  productSchema,
  recipeVersionNumberSchema,
  recipeVersionSchema,
} from '@ayvo/types';
import { notFound } from 'next/navigation';
import { z } from 'zod';
import { CatalogHeader } from '@/components/catalog/catalog-header';
import { RecipeStatusBadge } from '@/components/catalog/recipe-status';
import { RecipeWorkspace } from '@/components/catalog/recipe-workspace';
import { RequirementsCalculator } from '@/components/catalog/requirements-calculator';
import { Card, Field, FieldList, Notice } from '@/components/ui';
import { catalogCs } from '@/i18n/cs/catalog';
import { formatDateTimeCs, formatQuantityCs, unitCs } from '@/i18n/cs/format';
import { apiGet } from '@/lib/api';
import { stageOf } from '@/lib/catalog-forms';
import { currentUser, hasPermission, siteTimeZone } from '@/lib/session';

export const dynamic = 'force-dynamic';
const t = catalogCs.recipe;

/**
 * One recipe version (doc 023 §4): a DRAFT is edited here by users who may manage the catalogue;
 * ACTIVE and ARCHIVED versions are read-only (a change is a new version). The material
 * calculation works for every complete version, historic ones included.
 */
export default async function RecipeVersionPage({
  params,
}: {
  params: Promise<{ code: string; version: string }>;
}) {
  const { code, version: raw } = await params;
  const parsedVersion = recipeVersionNumberSchema.safeParse(raw);
  if (!productCodeSchema.safeParse(code).success || !parsedVersion.success) notFound();
  const version = parsedVersion.data;
  const base = `admin/catalog/products/${encodeURIComponent(code)}`;
  const [me, product, recipe, tz] = await Promise.all([
    currentUser(),
    apiGet(base, productSchema),
    apiGet(`${base}/recipes/${version}`, recipeVersionSchema),
    siteTimeZone(),
  ]);
  const canManage = hasPermission(me, 'catalog:product_manage');
  const canApprove = hasPermission(me, 'catalog:recipe_approve');
  const productActive = product.status === 'ACTIVE';
  const editable = recipe.status === 'DRAFT' && canManage && productActive;
  const needsComponents = editable;
  const [components, crateTypes] = needsComponents
    ? await Promise.all([
        apiGet('admin/catalog/components', z.array(catalogComponentSchema)),
        apiGet('admin/catalog/crate-types', z.array(crateTypeSchema)),
      ])
    : [[], []];
  const complete = recipe.missing.length === 0;

  return (
    <>
      <CatalogHeader
        view={null}
        title={
          <span className="flex flex-wrap items-center gap-2" data-testid="recipe-title">
            {t.title(recipe.product.name, recipe.version)}{' '}
            <RecipeStatusBadge status={recipe.status} />
          </span>
        }
        subtitle={
          <span>
            <span className="font-mono">{recipe.product.code}</span> ·{' '}
            {recipe.product.category.name} · {catalogCs.products.revision} {recipe.revision}
            {recipe.basedOnVersion
              ? ` · ${catalogCs.products.basedOn} V${recipe.basedOnVersion}`
              : ''}
          </span>
        }
        back={{
          href: `/production/catalog/products/${encodeURIComponent(code)}`,
          label: recipe.product.name,
        }}
      />
      <div className="flex flex-col gap-6">
        {recipe.status !== 'DRAFT' && <Notice tone="info">{t.readOnly}</Notice>}
        {recipe.status === 'DRAFT' && !productActive && (
          <Notice tone="warning">{t.readOnlyArchivedProduct}</Notice>
        )}
        {recipe.status === 'DRAFT' && productActive && !canManage && (
          <Notice tone="info">{t.noEditRight}</Notice>
        )}
        <div
          className={complete ? 'text-sm text-emerald-800' : 'text-sm text-amber-900'}
          data-testid="recipe-missing"
          role="status"
        >
          {complete
            ? t.complete
            : `${t.missing}: ${recipe.missing.map((m) => t.missingLabels[m] ?? m).join(', ')}`}
        </div>
        <RecipeWorkspace
          recipe={recipe}
          components={components}
          crateTypes={crateTypes}
          activeVersion={product.activeVersion}
          canManage={canManage}
          canApprove={canApprove}
          productActive={productActive}
          editable={editable}
        />
        {!editable && (
          <Card title={t.perBottle} testId="recipe-view">
            <ul className="flex flex-col">
              {recipe.components.map((c) => (
                <li
                  key={c.itemCode}
                  className="flex flex-wrap items-baseline justify-between gap-2 border-t border-stone-100 py-2 text-sm first:border-t-0"
                  data-kind={c.kind}
                >
                  <span className="min-w-0 wrap-anywhere">
                    <span className="font-medium">{t.rows[c.kind as keyof typeof t.rows]}</span>{' '}
                    <span className="text-stone-600">{c.itemName}</span>{' '}
                    <span className="font-mono text-xs text-stone-400">{c.itemCode}</span>{' '}
                    <span className="text-xs text-stone-500">
                      · {t.stage[stageOf(c.kind as 'PUMP')]}
                    </span>
                  </span>
                  <span className="font-medium tabular-nums">
                    {formatQuantityCs(c.quantity)} {unitCs(c.unit.code)}
                  </span>
                </li>
              ))}
            </ul>
            <FieldList>
              <Field label={t.crate}>
                {recipe.crateType
                  ? `${recipe.crateType.name} (${recipe.crateType.code}) – ${recipe.crateType.capacity}`
                  : catalogCs.common.none}
              </Field>
              <Field label={catalogCs.products.createdLabel}>
                {formatDateTimeCs(recipe.createdAt, tz)}
              </Field>
              {recipe.activatedAt && (
                <Field label={catalogCs.products.activated}>
                  {formatDateTimeCs(recipe.activatedAt, tz)}
                </Field>
              )}
              {recipe.archivedAt && (
                <Field label={catalogCs.products.archivedAt}>
                  {formatDateTimeCs(recipe.archivedAt, tz)}
                </Field>
              )}
            </FieldList>
            <p className="mt-3 text-xs text-stone-500">{t.stageNote}</p>
          </Card>
        )}
        <RequirementsCalculator
          // A new revision (saved draft) or status is another source: start a fresh calculation.
          key={`${recipe.product.code}:${recipe.version}:${recipe.revision}:${recipe.status}`}
          productCode={recipe.product.code}
          version={recipe.version}
          complete={complete}
          historic={recipe.status === 'ARCHIVED'}
        />
      </div>
    </>
  );
}
