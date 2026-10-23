import { labelDesignerSettingsSchema } from '@ayvo/types';
import { isConfigured } from '@/components/production/label-templates/qr-settings';
import { TemplateEditor } from '@/components/production/label-templates/template-editor';
import { ProductionHeader } from '@/components/production/production-header';
import { productionCs } from '@/i18n/cs/production';
import { Notice } from '@/components/ui';
import { apiGet } from '@/lib/api';

export const dynamic = 'force-dynamic';

export default async function NewLabelTemplatePage() {
  const settings = await apiGet('admin/label-designer/settings', labelDesignerSettingsSchema);
  return (
    <>
      <ProductionHeader
        active="templates"
        title={productionCs.templates.newTitle}
        subtitle={productionCs.templates.newSubtitle}
        back={{ href: '/label-templates', label: productionCs.templates.back }}
      />
      {isConfigured(settings) ? (
        <TemplateEditor mode={{ kind: 'create' }} settings={settings} />
      ) : (
        <div data-testid="qr-settings-missing">
          <Notice>{productionCs.qrSettingsMissing}</Notice>
        </div>
      )}
    </>
  );
}
