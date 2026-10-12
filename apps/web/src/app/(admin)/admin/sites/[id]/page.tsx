import { siteDetailSchema } from '@ayvo/types';
import { notFound } from 'next/navigation';
import { z } from 'zod';
import { AdminHeader } from '@/components/admin/admin-header';
import { AuditList } from '@/components/admin/audit-list';
import { SiteForm, SiteStatus } from '@/components/admin/site-form';
import { Card, Notice } from '@/components/ui';
import { identityCs } from '@/i18n/cs/identity';
import { apiGet } from '@/lib/api';

export const dynamic = 'force-dynamic';
const t = identityCs.sites_admin;

export default async function SitePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!z.uuid().safeParse(id).success) notFound();
  const site = await apiGet(`admin/sites/${id}`, siteDetailSchema);
  return (
    <>
      <AdminHeader
        active="sites"
        title={<span className="wrap-anywhere">{site.name}</span>}
        subtitle={
          <span className="font-mono">
            {site.code} · {site.active ? t.active : t.inactive}
          </span>
        }
        back={{ href: '/admin/sites', label: t.back }}
      />
      <div className="grid grid-cols-1 gap-6 xl:grid-cols-[minmax(0,1fr)_24rem]">
        <div className="flex min-w-0 flex-col gap-6">
          {!site.addressComplete && <Notice tone="warning">{t.addressMissing}</Notice>}
          <SiteForm site={site} />
          <Card title={t.audit} className="relative overflow-x-auto">
            <AuditList events={site.audit} testId="site-audit" />
          </Card>
        </div>
        <div className="flex flex-col gap-6">
          <Card title={t.warehouses}>
            {site.warehouses.length === 0 ? (
              <p className="text-sm text-stone-500">{t.noWarehouses}</p>
            ) : (
              <ul className="flex flex-col gap-1 text-sm">
                {site.warehouses.map((w) => (
                  <li key={w.code}>
                    {w.name} <span className="font-mono text-xs text-stone-500">{w.code}</span>
                    {w.default && (
                      <span className="ml-1 text-xs text-stone-500">({t.defaultWarehouse})</span>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </Card>
          <Card title={site.active ? t.deactivate : t.reactivate}>
            {site.active && (
              <div className="mb-3 text-sm" data-testid="site-blockers">
                {site.deactivationBlockers.length === 0 ? (
                  <p className="text-stone-600">{t.canDeactivate}</p>
                ) : (
                  <>
                    <p className="font-medium">{t.blockers}</p>
                    <ul className="list-disc pl-5">
                      {site.deactivationBlockers.map((b) => (
                        <li key={b.code}>{t.blocker[b.code] ?? b.detail}</li>
                      ))}
                    </ul>
                  </>
                )}
              </div>
            )}
            <SiteStatus
              id={site.id}
              active={site.active}
              blocked={site.active && site.deactivationBlockers.length > 0}
            />
          </Card>
        </div>
      </div>
    </>
  );
}
