import { crateTypeSchema } from '@ayvo/types';
import { z } from 'zod';
import { RegisterCratesForm } from '@/components/crates/register-crates-form';
import { ProductionHeader } from '@/components/production/production-header';
import { cratesCs } from '@/i18n/cs/crates';
import { apiGet } from '@/lib/api';
import { requirePermission } from '@/lib/session';

export const dynamic = 'force-dynamic';
const t = cratesCs.new;

/** Evidovat nové bedny (crates:register; crate types from the catalogue). */
export default async function NewCratesPage() {
  await requirePermission('crates:register');
  await requirePermission('catalog:read');
  const types = await apiGet('admin/catalog/crate-types', z.array(crateTypeSchema));
  return (
    <>
      <ProductionHeader
        active="crates"
        title={t.title}
        subtitle={t.subtitle}
        back={{ href: '/production/crates', label: cratesCs.backToList }}
      />
      <RegisterCratesForm crateTypes={types} />
    </>
  );
}
