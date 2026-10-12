import { permissionCatalogSchema, roleCatalogSchema } from '@ayvo/types';
import { AdminHeader } from '@/components/admin/admin-header';
import { RoleForm } from '@/components/admin/role-form';
import { Notice } from '@/components/ui';
import { identityCs } from '@/i18n/cs/identity';
import { apiGet } from '@/lib/api';

export const dynamic = 'force-dynamic';
const t = identityCs.roles_admin;

/** A new custom role — empty, or duplicated from an existing role (`?from=<role id>`). */
export default async function NewRolePage({
  searchParams,
}: {
  searchParams: Promise<{ from?: string }>;
}) {
  const { from } = await searchParams;
  const [catalogue, roles] = await Promise.all([
    apiGet('admin/identity/permissions', permissionCatalogSchema),
    apiGet('admin/identity/roles', roleCatalogSchema),
  ]);
  const source = roles.find((r) => r.id === from);
  return (
    <>
      <AdminHeader
        active="roles"
        title={t.newTitle}
        subtitle={t.newSubtitle}
        back={{ href: '/admin/roles', label: t.back }}
      />
      {source && (
        <div className="mb-4">
          <Notice tone="info">{t.copiedFrom(source.name)}</Notice>
        </div>
      )}
      <RoleForm
        catalogue={catalogue}
        initial={{
          name: source ? `${source.name} (kopie)` : '',
          description: source?.description ?? '',
          permissions: source?.permissions ?? [],
          copiedFrom: source?.code ?? null,
        }}
      />
    </>
  );
}
