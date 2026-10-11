import {
  bottleListResponseSchema,
  labelDesignerSettingsSchema,
  labelTemplateSummarySchema,
} from '@ayvo/types';
import { z } from 'zod';
import { CreateBottlesForm } from '@/components/bottles/create-bottles-form';
import { PageHeader } from '@/components/ui';
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
      <PageHeader
        title="Create bottles"
        subtitle="Each new bottle gets a permanent code and QR code; its labels are prepared for printing."
        back={{ href: '/bottles', label: 'Bottles' }}
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
