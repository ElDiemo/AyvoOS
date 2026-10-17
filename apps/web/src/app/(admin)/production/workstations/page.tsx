import { managedWorkstationSchema, productCategorySchema } from '@ayvo/types';
import { z } from 'zod';
import { ProductionHeader } from '@/components/production/production-header';
import { Card, EmptyState } from '@/components/ui';
import { WorkstationForm } from '@/components/workstations/workstation-form';
import { WorkstationRow } from '@/components/workstations/workstation-row';
import { workstationsCs } from '@/i18n/cs/workstations';
import { apiGet } from '@/lib/api';
import { requirePermission, siteTimeZone } from '@/lib/session';
import { setupReturn } from '@/lib/setup-return';

export const dynamic = 'force-dynamic';
const t = workstationsCs.manage;

/** Výroba → Správa pracovišť (doc 026): stations of the active site. */
export default async function WorkstationsPage({
  searchParams,
}: {
  searchParams: Promise<{ mode?: string; category?: string; back?: string }>;
}) {
  await requirePermission('production:workstations_manage');
  const params = await searchParams;
  const [stations, categories, timeZone] = await Promise.all([
    apiGet('admin/workstations', z.array(managedWorkstationSchema)),
    apiGet('admin/catalog/categories', z.array(productCategorySchema)),
    siteTimeZone(),
  ]);
  // From "Připravit výrobu": the known mode and category, validated against the real lists.
  const mode = params.mode === 'LABELING' || params.mode === 'FILLING' ? params.mode : '';
  const category = categories.some((c) => c.code === params.category) ? params.category! : '';
  const back = setupReturn(params.back);
  return (
    <>
      <ProductionHeader
        active="workstations"
        title={t.title}
        subtitle={t.subtitle}
        back={back ? { href: back, label: t.backToSetup } : undefined}
      />
      <div className="flex flex-col gap-6">
        <Card testId="workstations">
          {stations.length === 0 ? (
            <EmptyState>{t.empty}</EmptyState>
          ) : (
            <ul>
              {stations.map((s) => (
                <WorkstationRow key={s.code} station={s} timeZone={timeZone} />
              ))}
            </ul>
          )}
          <p className="mt-3 text-xs text-stone-500">{t.printHelp}</p>
        </Card>
        <WorkstationForm
          categories={categories}
          initialMode={mode}
          initialCategory={mode === 'FILLING' ? category : ''}
        />
      </div>
    </>
  );
}
