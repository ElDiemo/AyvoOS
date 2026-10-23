import {
  bottleListResponseSchema,
  labelDesignerSettingsSchema,
  labelTemplateSummarySchema,
  productLabelApprovalSchema,
} from '@ayvo/types';
import Link from 'next/link';
import { z } from 'zod';
import { CreateBottlesForm } from '@/components/production/create-bottles-form';
import { buttonClass, Notice } from '@/components/ui';
import { ProductionHeader } from '@/components/production/production-header';
import { productionCs } from '@/i18n/cs/production';
import { apiGet } from '@/lib/api';
import { fetchApiHealth } from '@/lib/api-health';
import { serverEnv } from '@/lib/env';
import { currentUser, hasPermission } from '@/lib/session';
import { setupReturn } from '@/lib/setup-return';

export const dynamic = 'force-dynamic';

export default async function CreateBottlesPage({
  searchParams,
}: {
  searchParams: Promise<{ version?: string; product?: string; back?: string }>;
}) {
  const params = await searchParams;
  const version = typeof params.version === 'string' ? params.version : undefined;
  // From "Připravit výrobu" (issue #11 UI-21): only the approved, usable designs of THAT product.
  const product =
    typeof params.product === 'string' && /^[A-Za-z0-9_-]{1,40}$/.test(params.product)
      ? params.product
      : null;
  const back = setupReturn(params.back);
  const me = await currentUser();
  const [allTemplates, latest, settings, health, approvals] = await Promise.all([
    apiGet('admin/label-templates', z.array(labelTemplateSummarySchema)),
    // Newest bottle first: only its code is needed for the expected code range.
    apiGet('admin/bottles', bottleListResponseSchema, { page: 1, pageSize: 1 }),
    apiGet('admin/label-designer/settings', labelDesignerSettingsSchema),
    fetchApiHealth(serverEnv.API_URL),
    product && hasPermission(me, 'catalog:read')
      ? apiGet(
          `admin/catalog/products/${encodeURIComponent(product)}/label-approvals`,
          z.array(productLabelApprovalSchema),
        )
      : Promise.resolve(null),
  ]);
  const approved = new Set(
    (approvals ?? []).filter((a) => a.revokedAt === null).map((a) => a.design.versionId),
  );
  // Without a product context every active template is offered, as before.
  const templates =
    product === null
      ? allTemplates
      : allTemplates.filter(
          (tpl) =>
            tpl.archivedAt === null &&
            approved.has(tpl.latestVersion.versionId) &&
            (!version || tpl.latestVersion.versionId === version),
        );
  const c = productionCs.create;
  // The preview URL is this environment's base URL plus a sample token.
  const qrUrlPattern = `${settings.qrPreviewUrl.slice(0, settings.qrPreviewUrl.lastIndexOf('/'))}/<token>`;
  return (
    <>
      <ProductionHeader
        active="bottles"
        title={productionCs.create.title}
        subtitle={productionCs.create.subtitle}
        back={back ? { href: back, label: c.backToSetup } : { href: '/bottles', label: c.back }}
      />
      {product && (
        <p className="mb-4 text-sm text-stone-700" data-testid="bottles-for-product">
          {c.forProduct(product)}
        </p>
      )}
      {/* Identity ≠ labelled body ≠ filled bottle (issue #11 UI-22). */}
      <ol
        className="mb-6 grid gap-2 rounded-lg border border-stone-200 bg-stone-50 p-4 text-sm sm:grid-cols-3"
        aria-label={productionCs.create.stepsTitle}
        data-testid="bottle-steps"
      >
        <li className="font-medium text-stone-900">{productionCs.create.steps.identity}</li>
        <li className="text-stone-600">{productionCs.create.steps.labeled}</li>
        <li className="text-stone-600">{productionCs.create.steps.filled}</li>
      </ol>
      {settings.qrErrorCorrection === null ? (
        // Identities exist only to be labelled: the API refuses the registration (nothing created).
        <div data-testid="qr-settings-missing">
          <Notice>{productionCs.qrSettingsMissing}</Notice>
        </div>
      ) : product && templates.length === 0 ? (
        <div className="flex flex-col gap-3" data-testid="bottles-no-design">
          <Notice tone="warning">{c.noApprovedDesign(product)}</Notice>
          <Link
            href={`/production/catalog/products/${product}#designs`}
            className={`${buttonClass.secondary} self-start`}
          >
            {c.openDesigns}
          </Link>
        </div>
      ) : (
        <CreateBottlesForm
          templates={templates}
          preselectedVersionId={version}
          latestBottleCode={latest.items[0]?.code ?? null}
          qrUrlPattern={qrUrlPattern}
          environment={health.reachable ? health.health.environment : 'unknown'}
        />
      )}
    </>
  );
}
