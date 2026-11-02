import { billingRunSettingsPageSchema } from '@ayvo/types';
import { FinanceHeader } from '@/components/finance/finance-header';
import { RunPlanForm, RunSettingsForm } from '@/components/finance/run-settings';
import { TestRunForm } from '@/components/finance/test-run-form';
import { Card, Notice } from '@/components/ui';
import { financeCs } from '@/i18n/cs/finance';
import { formatDateTimeCs } from '@/i18n/cs/format';
import { apiGet } from '@/lib/api';
import { hasPermission, requirePermission } from '@/lib/session';

export const dynamic = 'force-dynamic';
const t = financeCs.invoices;
const s = t.runSettings;

/**
 * Měsíční běh (doc 040 §11, §13): TEST invoices of a stated period from the agreements in effect.
 * The run settings (issue day, billed month per billing timing; finance:billing_manage to change)
 * plan an issue month and open the run with its period, issue date and timing filled in — the
 * person still reviews and confirms. Nothing runs by itself.
 */
export default async function TestRunPage({
  searchParams,
}: {
  searchParams: Promise<{ month?: string; issuedOn?: string; timing?: string; revision?: string }>;
}) {
  const me = await requirePermission('finance:invoices_test');
  await requirePermission('finance:billing_read');
  const canManage = hasPermission(me, 'finance:billing_manage');
  const [settings, q] = await Promise.all([
    apiGet('admin/finance/billing/run-settings', billingRunSettingsPageSchema),
    searchParams,
  ]);
  const timing: 'ADVANCE' | 'ARREARS' | null =
    q.timing === 'ADVANCE' || q.timing === 'ARREARS' ? q.timing : null;
  const c = settings.current;
  const fromPlan =
    !!q.month &&
    /^\d{4}-\d{2}$/.test(q.month) &&
    !!q.issuedOn &&
    /^\d{4}-\d{2}-\d{2}$/.test(q.issuedOn) &&
    !!timing;
  // Filled in only from a plan of the current settings revision (review RUN112-R1): a link from an
  // older plan fills nothing in and says so.
  const stale = fromPlan && (c === null || q.revision !== String(c.revision));
  const planned =
    fromPlan && !stale ? { month: q.month!, issuedOn: q.issuedOn!, timing: timing! } : undefined;
  return (
    <>
      <FinanceHeader
        active="invoices"
        title={t.run.title}
        subtitle={t.run.subtitle}
        back={{ href: '/finance/invoices', label: t.back }}
      />
      <div className="flex flex-col gap-4">
        <Notice tone="warning">{t.testOnly}</Notice>
        <Card title={s.title} testId="run-settings">
          <p className="mb-3 text-xs text-stone-500">{s.help}</p>
          <p className="text-sm" data-testid="run-settings-current">
            {c
              ? `${s.current(c.issueDay, s.billedMonth[c.advanceBilledMonth]!, s.billedMonth[c.arrearsBilledMonth]!)} (${s.revision(settings.versions.length)})`
              : s.none}
          </p>
          {settings.versions.length > 1 && (
            <details className="mt-2 text-sm">
              <summary className="cursor-pointer text-stone-600">{s.history}</summary>
              <ul className="mt-2 flex flex-col gap-1 text-xs text-stone-600">
                {settings.versions.slice(1).map((v, i) => (
                  <li key={v.revision}>
                    {s.revision(settings.versions.length - 1 - i)}:{' '}
                    {s.current(
                      v.issueDay,
                      s.billedMonth[v.advanceBilledMonth]!,
                      s.billedMonth[v.arrearsBilledMonth]!,
                    )}{' '}
                    – {v.reason} ({formatDateTimeCs(v.recordedAt)}, {v.recordedByName})
                  </li>
                ))}
              </ul>
            </details>
          )}
          {canManage && (
            <div className="mt-4 border-t border-stone-200 pt-4">
              <RunSettingsForm key={c?.revision ?? 0} current={c} />
            </div>
          )}
        </Card>
        <Card title={s.planTitle}>
          <RunPlanForm key={c?.revision ?? 0} settingsRevision={c?.revision ?? null} />
        </Card>
        <Card>
          {stale && (
            <p className="mb-3 text-sm text-amber-800" data-testid="run-planned-stale">
              {s.stale}
            </p>
          )}
          {planned && (
            <p className="mb-3 text-sm text-stone-700" data-testid="run-planned">
              {s.planned(s.timing[planned.timing]!)}
            </p>
          )}
          <TestRunForm key={JSON.stringify(planned ?? null)} planned={planned} />
        </Card>
      </div>
    </>
  );
}
