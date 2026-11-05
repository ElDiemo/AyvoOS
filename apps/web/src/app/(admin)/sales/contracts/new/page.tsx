import { contractDraftPrefillSchema, hotelCodeSchema, prospectCodeSchema } from '@ayvo/types';
import { notFound } from 'next/navigation';
import { ContractDraftWizard } from '@/components/contracts/contract-draft-wizard';
import { SalesHeader } from '@/components/sales/sales-header';
import { Card, Notice } from '@/components/ui';
import { contractsCs as t } from '@/i18n/cs/contracts';
import { apiGet } from '@/lib/api';
import { requirePermission } from '@/lib/session';

export const dynamic = 'force-dynamic';

/**
 * Nový návrh smlouvy (doc 045 §2) from a prospect (`?prospect=AKV-…`, in the caller's scope) or a
 * hotel (`?hotel=HT-…`, sales:manage + hotels:read). Opening this page writes nothing; the draft
 * exists only after "Uložit návrh". Out of scope is 404, as the prospect itself.
 */
export default async function NewContractDraftPage({
  searchParams,
}: {
  searchParams: Promise<{ prospect?: string; hotel?: string }>;
}) {
  await requirePermission('sales:work');
  const { prospect, hotel } = await searchParams;
  const p = prospect && prospectCodeSchema.safeParse(prospect).success ? prospect : undefined;
  const h = hotel && hotelCodeSchema.safeParse(hotel).success ? hotel : undefined;
  if (!p && !h) notFound();
  const prefill = await apiGet(
    'admin/contracts/drafts/prefill',
    contractDraftPrefillSchema,
    p ? { prospect: p } : { hotel: h },
  );
  const back = prefill.prospect
    ? { href: `/sales/prospects/${prefill.prospect.code}`, label: prefill.prospect.name }
    : { href: `/hotels/${prefill.hotel!.code}#navrhy-smluv`, label: prefill.hotel!.name };
  return (
    <>
      <SalesHeader
        active="prospects"
        title={t.newTitle}
        subtitle={
          prefill.prospect
            ? t.context.prospect(prefill.prospect.name)
            : t.context.hotel(prefill.hotel!.name)
        }
        back={back}
      />
      <div className="flex flex-col gap-6">
        <Notice tone="warning">
          <span className="font-semibold">{t.mark}.</span> {t.workingText}
        </Notice>
        <Card testId="contract-new">
          <p className="mb-4 text-sm text-stone-600">{t.nothingYet}</p>
          <ContractDraftWizard mode="create" prefill={prefill} />
        </Card>
      </div>
    </>
  );
}
