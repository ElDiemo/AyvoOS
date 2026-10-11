import { labelDesignerSettingsSchema } from '@ayvo/types';
import { TemplateEditor } from '@/components/label-templates/template-editor';
import { PageHeader } from '@/components/ui';
import { apiGet } from '@/lib/api';

export const dynamic = 'force-dynamic';

export default async function NewLabelTemplatePage() {
  const settings = await apiGet('admin/label-designer/settings', labelDesignerSettingsSchema);
  return (
    <>
      <PageHeader
        title="Create label template"
        subtitle="Upload the artwork, set the printed size and place the QR code."
        back={{ href: '/label-templates', label: 'Label templates' }}
      />
      <TemplateEditor mode={{ kind: 'create' }} settings={settings} />
    </>
  );
}
