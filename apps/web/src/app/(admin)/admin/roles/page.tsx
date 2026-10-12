import { isPlannedRole, roleCatalogSchema } from '@ayvo/types';
import Link from 'next/link';
import { AdminHeader } from '@/components/admin/admin-header';
import { buttonClass, Card, EmptyState } from '@/components/ui';
import { identityCs } from '@/i18n/cs/identity';
import { apiGet } from '@/lib/api';
import { currentUser, hasPermission } from '@/lib/session';

export const dynamic = 'force-dynamic';
const t = identityCs.roles_admin;

export default async function RolesPage() {
  const [me, roles] = await Promise.all([
    currentUser(),
    apiGet('admin/identity/roles', roleCatalogSchema),
  ]);
  return (
    <>
      <AdminHeader
        active="roles"
        title={t.title}
        subtitle={t.subtitle}
        actions={
          hasPermission(me, 'identity:roles_manage') ? (
            <Link href="/admin/roles/new" className={buttonClass.primary}>
              {t.create}
            </Link>
          ) : null
        }
      />
      <Card className="relative overflow-x-auto p-0">
        {roles.length === 0 ? (
          <EmptyState>{t.empty}</EmptyState>
        ) : (
          <table className="w-full text-left text-sm" data-testid="roles">
            <thead className="border-b border-stone-200 text-xs tracking-wide text-stone-500 uppercase">
              <tr>
                <th className="px-5 py-3 font-medium">{t.name}</th>
                <th className="px-5 py-3 font-medium">{t.permissions}</th>
                <th className="px-5 py-3 font-medium">{t.holders}</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-stone-100">
              {roles.map((r) => (
                <tr key={r.id} className="hover:bg-stone-50" data-role={r.code}>
                  <td className="px-5 py-3 align-top">
                    <Link href={`/admin/roles/${r.id}`} className="font-medium hover:underline">
                      {r.name}
                    </Link>
                    <span className="block font-mono text-xs wrap-anywhere text-stone-500">
                      {r.code} · {r.system ? t.system : t.custom}
                      {!r.active && ` · ${t.inactive}`}
                    </span>
                    {isPlannedRole(r.code) && (
                      <span
                        className="mt-1 block text-xs text-stone-500"
                        data-planned-role={r.code}
                      >
                        <span className="rounded bg-stone-100 px-1.5 py-0.5 text-stone-600">
                          {identityCs.planned.label}
                        </span>{' '}
                        {identityCs.planned.roles[r.code]}
                      </span>
                    )}
                  </td>
                  <td className="px-5 py-3 align-top whitespace-nowrap">
                    {t.count(r.permissions.length)}
                  </td>
                  <td className="px-5 py-3 align-top">{r.assignedUsers}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>
    </>
  );
}
