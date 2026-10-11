import { roleCatalogSchema } from '@ayvo/types';
import { z } from 'zod';
import { AdminHeader } from '@/components/admin/admin-header';
import { CreateUserForm } from '@/components/admin/create-user-form';
import { identityCs } from '@/i18n/cs/identity';
import { apiGet } from '@/lib/api';
import { requirePermission } from '@/lib/session';

export const dynamic = 'force-dynamic';
const t = identityCs.admin;

export default async function NewUserPage() {
  await requirePermission('identity:users_manage');
  const [roles, warehouses] = await Promise.all([
    apiGet('admin/identity/roles', roleCatalogSchema),
    apiGet('admin/identity/warehouses', z.array(z.object({ code: z.string(), name: z.string() }))),
  ]);
  return (
    <>
      <AdminHeader
        title={t.createTitle}
        subtitle={t.createSubtitle}
        back={{ href: '/admin/users', label: t.back }}
      />
      <CreateUserForm roles={roles} warehouses={warehouses} />
    </>
  );
}
