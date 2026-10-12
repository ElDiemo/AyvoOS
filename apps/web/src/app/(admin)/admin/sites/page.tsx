import { siteSchema } from '@ayvo/types';
import Link from 'next/link';
import { z } from 'zod';
import { AdminHeader } from '@/components/admin/admin-header';
import { buttonClass, Card, EmptyState } from '@/components/ui';
import { identityCs } from '@/i18n/cs/identity';
import { apiGet } from '@/lib/api';

export const dynamic = 'force-dynamic';
const t = identityCs.sites_admin;

export default async function SitesPage() {
  const sites = await apiGet('admin/sites', z.array(siteSchema));
  return (
    <>
      <AdminHeader
        active="sites"
        title={t.title}
        subtitle={t.subtitle}
        actions={
          <Link href="/admin/sites/new" className={buttonClass.primary}>
            {t.create}
          </Link>
        }
      />
      <Card className="relative overflow-x-auto p-0">
        {sites.length === 0 ? (
          <EmptyState>{t.empty}</EmptyState>
        ) : (
          <table className="w-full text-left text-sm" data-testid="sites">
            <thead className="border-b border-stone-200 text-xs tracking-wide text-stone-500 uppercase">
              <tr>
                <th className="px-5 py-3 font-medium">{t.name}</th>
                <th className="px-5 py-3 font-medium">{t.capabilities}</th>
                <th className="px-5 py-3 font-medium">{t.warehouses}</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-stone-100">
              {sites.map((s) => (
                <tr key={s.id} className="hover:bg-stone-50" data-site={s.code}>
                  <td className="px-5 py-3 align-top">
                    <Link href={`/admin/sites/${s.id}`} className="font-medium hover:underline">
                      {s.name}
                    </Link>
                    <span className="block font-mono text-xs wrap-anywhere text-stone-500">
                      {s.code} · {s.countryCode} · {s.timeZone}
                      {!s.active && ` · ${t.inactive}`}
                    </span>
                    {!s.addressComplete && (
                      <span className="block text-xs text-amber-800">{t.addressMissing}</span>
                    )}
                  </td>
                  <td className="px-5 py-3 align-top">
                    {s.capabilities.map((c) => t.capability[c]).join(', ') || '—'}
                  </td>
                  <td className="px-5 py-3 align-top font-mono text-xs">
                    {s.warehouses.map((w) => w.code).join(', ') || '—'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>
    </>
  );
}
