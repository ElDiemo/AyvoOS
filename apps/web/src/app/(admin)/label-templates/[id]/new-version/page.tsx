import { labelDesignerSettingsSchema, labelTemplateDetailSchema } from '@ayvo/types';
import { notFound } from 'next/navigation';
import { z } from 'zod';
import { isConfigured } from '@/components/production/label-templates/qr-settings';
import { TemplateEditor } from '@/components/production/label-templates/template-editor';
import { ProductionHeader } from '@/components/production/production-header';
import { productionCs } from '@/i18n/cs/production';
import { Notice } from '@/components/ui';
import { apiGet } from '@/lib/api';

export const dynamic = 'force-dynamic';

export default async function NewTemplateVersionPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  if (!z.uuid().safeParse(id).success) notFound();
  const [template, settings] = await Promise.all([
    apiGet(`admin/label-templates/${encodeURIComponent(id)}`, labelTemplateDetailSchema),
    apiGet('admin/label-designer/settings', labelDesignerSettingsSchema),
  ]);
  const latest = template.versions[0]!;
  return (
    <>
      <ProductionHeader
        active="templates"
        title={
          <span className="wrap-anywhere">{productionCs.templates.editTitle(template.name)}</span>
        }
        subtitle={productionCs.templates.editSubtitle(latest.label)}
        back={{ href: `/label-templates/${template.id}`, label: template.name }}
      />
      {isConfigured(settings) ? (
        <TemplateEditor
          mode={{ kind: 'version', templateId: template.id, templateName: template.name, latest }}
          settings={settings}
        />
      ) : (
        <div data-testid="qr-settings-missing">
          <Notice>{productionCs.qrSettingsMissing}</Notice>
        </div>
      )}
    </>
  );
}
