import { crateTypeSchema } from '@ayvo/types';
import { z } from 'zod';
import { RegisterCratesForm } from '@/components/crates/register-crates-form';
import { ProductionHeader } from '@/components/production/production-header';
import { cratesCs } from '@/i18n/cs/crates';
import { apiGet } from '@/lib/api';
import { requirePermission } from '@/lib/session';
import { setupReturn } from '@/lib/setup-return';

export const dynamic = 'force-dynamic';
const t = cratesCs.new;

/** Evidovat nové bedny (crates:register; crate types from the catalogue). */
export default async function NewCratesPage({
  searchParams,
}: {
  searchParams: Promise<{ back?: string }>;
}) {
  const back = setupReturn((await searchParams).back);
  await requirePermission('crates:register');
  await requirePermission('catalog:read');
  const types = await apiGet('admin/catalog/crate-types', z.array(crateTypeSchema));
  return (
    <>
      <ProductionHeader
        active="crates"
        title={t.title}
        subtitle={t.subtitle}
        back={
          back
            ? { href: back, label: cratesCs.backToSetup }
            : { href: '/production/crates', label: cratesCs.backToList }
        }
      />
      <RegisterCratesForm crateTypes={types} />
    </>
  );
}
