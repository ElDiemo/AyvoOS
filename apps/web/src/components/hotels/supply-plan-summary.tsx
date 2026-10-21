import type { SupplyPlan } from '@ayvo/types';
import Link from 'next/link';
import { buttonClass, EmptyState, Field, FieldList, Notice } from '@/components/ui';
import { formatDateCs, formatDateTimeCs } from '@/i18n/cs/format';
import { supplyPlansCs as t } from '@/i18n/cs/supply-plans';

const tone: Record<string, string> = {
  INACTIVE: 'border-stone-300 bg-stone-100 text-stone-700',
  ACTIVE: 'border-emerald-300 bg-emerald-50 text-emerald-900',
  PAUSED: 'border-amber-300 bg-amber-50 text-amber-950',
};

export function PlanStatusBadge({ status }: { status: string }) {
  return (
    <span
      className={`rounded border px-1.5 py-0.5 text-xs font-semibold ${tone[status] ?? ''}`}
      data-testid="plan-status"
    >
      {t.status[status]}
    </span>
  );
}

/**
 * Plán zásobování on the hotel detail (doc 032): state, rules, the nearest ship day, the last
 * successful evaluation and any blocker with its reason; technical details collapsed.
 */
export function SupplyPlanSummary({
  hotel,
  plan,
  canManage,
  timeZone,
}: {
  hotel: string;
  plan: SupplyPlan | null;
  canManage: boolean;
  timeZone: string;
}) {
  const href = `/hotels/${hotel}/plan`;
  if (!plan) {
    return (
      <div className="flex flex-col gap-3 text-sm">
        <EmptyState>{t.none}</EmptyState>
        {canManage && (
          <div>
            <Link href={href} className={buttonClass.primary} data-testid="create-plan">
              {t.create}
            </Link>
          </div>
        )}
      </div>
    );
  }
  return (
    <div className="flex flex-col gap-3 text-sm" data-testid="plan-summary">
      <p className="flex flex-wrap items-center gap-2">
        <PlanStatusBadge status={plan.status} />
        <span className="text-stone-600">{t.statusHelp[plan.status]}</span>
      </p>
      <FieldList>
        <Field label={t.next}>
          <span data-testid="plan-next">
            {plan.nextShipDate ? formatDateCs(plan.nextShipDate) : t.noNext}
          </span>
        </Field>
        <Field label={t.lastRunOk}>
          {plan.lastRunOkAt ? formatDateTimeCs(plan.lastRunOkAt, timeZone) : t.neverRun}
        </Field>
        <Field label={t.rulesTitle}>
          <ul className="flex flex-col gap-0.5" data-testid="plan-rules">
            {plan.rules.map((r, i) => (
              <li key={i}>
                <span className="font-medium">{r.productName}</span> ·{' '}
                {t.rulesLine(r.crates, r.days.join(', '))}
              </li>
            ))}
          </ul>
        </Field>
      </FieldList>
      {plan.lastRunError && <Notice tone="warning">{t.lastRunError(plan.lastRunError)}</Notice>}
      {plan.blocked.length > 0 && (
        <Notice tone="warning">
          <span className="font-semibold">{t.blocked}</span>
          <ul className="mt-1 list-disc pl-5" data-testid="plan-blocked">
            {plan.blocked.map((b) => (
              <li key={b.shipDate}>
                {t.blockedLine(
                  formatDateCs(b.shipDate),
                  b.blockers
                    .map((x) =>
                      t.blockers[x.code]!(
                        x.code === 'ORDER_REFUSED'
                          ? x.detail
                          : // The product's name from the plan's rules (its code otherwise).
                            (plan.rules.find((r) => r.productCode === x.product)?.productName ??
                              x.product),
                      ),
                    )
                    .join(' '),
                )}
              </li>
            ))}
          </ul>
        </Notice>
      )}
      <details className="text-xs text-stone-600">
        <summary className="cursor-pointer">{t.technical}</summary>
        <ul className="mt-1 flex flex-col gap-0.5">
          <li>
            {t.version(plan.version)} ·{' '}
            {t.validity(
              formatDateCs(plan.validFrom),
              plan.validTo ? formatDateCs(plan.validTo) : null,
            )}
          </li>
          {plan.activatedBy && plan.activatedAt && (
            <li>{t.activatedBy(plan.activatedBy, formatDateTimeCs(plan.activatedAt, timeZone))}</li>
          )}
          <li>{t.updatedBy(plan.updatedBy, formatDateTimeCs(plan.updatedAt, timeZone))}</li>
          {plan.lastRunAt && (
            <li>{`${t.lastRun}: ${formatDateTimeCs(plan.lastRunAt, timeZone)}`}</li>
          )}
        </ul>
      </details>
      <div>
        <Link href={href} className={buttonClass.secondary} data-testid="open-plan">
          {canManage ? t.edit : t.open}
        </Link>
      </div>
    </div>
  );
}
