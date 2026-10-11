import {
  bottleListResponseSchema,
  labelDesignerSettingsSchema,
  labelTemplateSummarySchema,
} from '@ayvo/types';
import { z } from 'zod';
import { CreateBottlesForm } from '@/components/production/create-bottles-form';
import { ProductionHeader } from '@/components/production/production-header';
import { productionCs } from '@/i18n/cs/production';
import { apiGet } from '@/lib/api';
import { fetchApiHealth } from '@/lib/api-health';
import { serverEnv } from '@/lib/env';

export const dynamic = 'force-dynamic';

export default async function CreateBottlesPage({
  searchParams,
}: {
  searchParams: Promise<{ version?: string }>;
}) {
  const { version } = await searchParams;
  const [templates, latest, settings, health] = await Promise.all([
    apiGet('admin/label-templates', z.array(labelTemplateSummarySchema)),
    // Newest bottle first: only its code is needed for the expected code range.
    apiGet('admin/bottles', bottleListResponseSchema, { page: 1, pageSize: 1 }),
    apiGet('admin/label-designer/settings', labelDesignerSettingsSchema),
    fetchApiHealth(serverEnv.API_URL),
  ]);
  // The preview URL is this environment's base URL plus a sample token.
  const qrUrlPattern = `${settings.qrPreviewUrl.slice(0, settings.qrPreviewUrl.lastIndexOf('/'))}/<token>`;
  return (
    <>
      <ProductionHeader
        active="bottles"
        title={productionCs.create.title}
        subtitle={productionCs.create.subtitle}
        back={{ href: '/bottles', label: productionCs.create.back }}
      />
      <CreateBottlesForm
        templates={templates}
        preselectedVersionId={version}
        latestBottleCode={latest.items[0]?.code ?? null}
        qrUrlPattern={qrUrlPattern}
        environment={health.reachable ? health.health.environment : 'unknown'}
      />
    </>
  );
}
