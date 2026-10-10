import { labelDesignerSettingsSchema, labelTemplateDetailSchema } from '@ayvo/types';
import { TemplateEditor } from '@/components/label-templates/template-editor';
import { PageHeader } from '@/components/ui';
import { apiGet } from '@/lib/api';

export const dynamic = 'force-dynamic';

export default async function NewTemplateVersionPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const [template, settings] = await Promise.all([
    apiGet(`admin/label-templates/${encodeURIComponent(id)}`, labelTemplateDetailSchema),
    apiGet('admin/label-designer/settings', labelDesignerSettingsSchema),
  ]);
  const latest = template.versions[0]!;
  return (
    <>
      <PageHeader
        title={`Edit ${template.name}`}
        subtitle={`Starting from ${latest.label}. Replace the artwork, change the size or move the QR code.`}
        back={{ href: `/label-templates/${template.id}`, label: template.name }}
      />
      <TemplateEditor
        mode={{ kind: 'version', templateId: template.id, templateName: template.name, latest }}
        settings={settings}
      />
    </>
  );
}
