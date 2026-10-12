import { permissionCatalogSchema, roleDetailSchema } from '@ayvo/types';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { z } from 'zod';
import { AccessPreview } from '@/components/admin/access-preview';
import { AdminHeader } from '@/components/admin/admin-header';
import { AuditList } from '@/components/admin/audit-list';
import { RoleForm, RoleStatus } from '@/components/admin/role-form';
import { buttonClass, Card, Notice } from '@/components/ui';
import { identityCs } from '@/i18n/cs/identity';
import { apiGet } from '@/lib/api';
import { currentUser, hasPermission } from '@/lib/session';

export const dynamic = 'force-dynamic';
const t = identityCs.roles_admin;

export default async function RolePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!z.uuid().safeParse(id).success) notFound();
  const [me, role, catalogue] = await Promise.all([
    currentUser(),
    apiGet(`admin/identity/roles/${id}`, roleDetailSchema),
    apiGet('admin/identity/permissions', permissionCatalogSchema),
  ]);
  const canManage = hasPermission(me, 'identity:roles_manage');
  return (
    <>
      <AdminHeader
        active="roles"
        title={<span className="wrap-anywhere">{role.name}</span>}
        subtitle={
          <span className="font-mono wrap-anywhere">
            {role.code} · {role.system ? t.system : t.custom} ·{' '}
            {role.active ? t.active : t.inactive}
          </span>
        }
        back={{ href: '/admin/roles', label: t.back }}
        actions={
          canManage ? (
            <Link href={`/admin/roles/new?from=${role.id}`} className={buttonClass.secondary}>
              {t.duplicate}
            </Link>
          ) : null
        }
      />
      <div className="grid grid-cols-1 gap-6 xl:grid-cols-[minmax(0,1fr)_24rem]">
        <div className="flex min-w-0 flex-col gap-6">
          {role.system || !canManage ? (
            <Card title={t.permissions}>
              {role.system && (
                <div className="mb-4">
                  <Notice tone="info">{t.readOnly}</Notice>
                </div>
              )}
              {role.description && (
                <p className="mb-4 text-sm text-stone-600">{role.description}</p>
              )}
              <AccessPreview
                permissions={role.permissions}
                sites={[]}
                global={role.permissions.includes('sites:all_access')}
                testId="role-permissions-view"
              />
            </Card>
          ) : (
            <RoleForm
              catalogue={catalogue}
              role={{ id: role.id, code: role.code }}
              initial={{
                name: role.name,
                description: role.description,
                permissions: role.permissions,
                copiedFrom: null,
              }}
            />
          )}
          <Card title={t.audit} className="relative overflow-x-auto">
            <AuditList events={role.audit} testId="role-audit" />
          </Card>
        </div>
        <div className="flex flex-col gap-6">
          <Card title={`${t.holders} (${role.holders.length})`}>
            {role.holders.length === 0 ? (
              <p className="text-sm text-stone-500">{t.noHolders}</p>
            ) : (
              <ul className="flex flex-col gap-1 text-sm" data-testid="role-holders">
                {role.holders.map((h) => (
                  <li key={h.id} className="wrap-anywhere">
                    <Link href={`/admin/users/${h.id}`} className="hover:underline">
                      {h.displayName}
                    </Link>{' '}
                    <span className="text-xs text-stone-500">{h.email}</span>
                  </li>
                ))}
              </ul>
            )}
          </Card>
          {canManage && !role.system && (
            <Card title={role.active ? t.deactivate : t.reactivate}>
              <RoleStatus id={role.id} active={role.active} />
            </Card>
          )}
        </div>
      </div>
    </>
  );
}
