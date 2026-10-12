import { AdminHeader } from '@/components/admin/admin-header';
import { SiteForm } from '@/components/admin/site-form';
import { identityCs } from '@/i18n/cs/identity';

const t = identityCs.sites_admin;

export default function NewSitePage() {
  return (
    <>
      <AdminHeader
        active="sites"
        title={t.newTitle}
        subtitle={t.subtitle}
        back={{ href: '/admin/sites', label: t.back }}
      />
      <SiteForm />
    </>
  );
}
