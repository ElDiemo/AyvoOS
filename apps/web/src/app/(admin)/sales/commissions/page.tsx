import {
  commissionTermsOverviewSchema,
  commissionTermsSchema,
  type CommissionTerms,
  type CommissionTermsVersion,
} from '@ayvo/types';
import { cn } from '@ayvo/ui';
import Link from 'next/link';
import { CommissionTermsForm } from '@/components/sales/commission-terms-form';
import { SalesHeader } from '@/components/sales/sales-header';
import { Card, EmptyState, Notice } from '@/components/ui';
import { commissionsCs } from '@/i18n/cs/commissions';
import { formatDateTimeCs } from '@/i18n/cs/format';
import { apiGet } from '@/lib/api';
import { hasPermission, requirePermission } from '@/lib/session';

export const dynamic = 'force-dynamic';
const t = commissionsCs;
const cz = (rate: string) => rate.replace('.', ',');
const summary = (v: CommissionTermsVersion) =>
  t.terms(cz(v.initialRate), v.initialMonths, cz(v.maintenanceRate));

function History({ terms }: { terms: CommissionTerms }) {
  const c = t.history.columns;
  if (terms.history.length === 0) return <EmptyState>{t.history.empty}</EmptyState>;
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-left text-sm" data-testid="terms-history">
        <thead className="text-xs text-stone-500">
          <tr>
            <th scope="col" className="py-2 pr-4 font-medium">
              {c.version}
            </th>
            <th scope="col" className="py-2 pr-4 font-medium">
              {c.terms}
            </th>
            <th scope="col" className="py-2 pr-4 font-medium">
              {c.reason}
            </th>
            <th scope="col" className="py-2 font-medium">
              {c.recorded}
            </th>
          </tr>
        </thead>
        <tbody className="divide-y divide-stone-100">
          {terms.history.map((v, i) => (
            <tr key={v.version}>
              <td className="py-2 pr-4 tabular-nums">
                {v.version}
                {i === 0 && (
                  <span className="ml-2 rounded bg-emerald-50 px-1.5 py-0.5 text-xs text-emerald-800">
                    {t.history.valid}
                  </span>
                )}
              </td>
              <td className="py-2 pr-4">{summary(v)}</td>
              <td className="py-2 pr-4 wrap-anywhere">{v.reason}</td>
              <td className="py-2 text-stone-600">
                {formatDateTimeCs(v.recordedAt)} · {v.recordedByName}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Valid({ terms }: { terms: CommissionTerms }) {
  if (!terms.valid)
    return (
      <Notice>
        <strong>{t.missing}.</strong> {t.missingHelp}
      </Notice>
    );
  return (
    <p className="text-lg font-semibold" data-testid="terms-valid">
      {summary(terms.valid)}
    </p>
  );
}

/**
 * Obchod → Provize (doc 068 §2, PR 1a PROTOTYPE). A salesperson reads their own terms; the admin
 * (`sales:commission_terms_manage`, ADMIN only) also picks a salesperson, sees the history and
 * records a new version. The API enforces the same; this page only hides what is refused.
 */
export default async function SalesCommissionsPage({
  searchParams,
}: {
  searchParams: Promise<{ tab?: string; salesperson?: string }>;
}) {
  const me = await requirePermission('sales:work');
  const manage = hasPermission(me, 'sales:commission_terms_manage');
  const q = await searchParams;
  const tab = manage && q.tab !== 'mine' ? 'settings' : 'mine';
  const tabClass = (on: boolean) =>
    cn(
      'rounded-md px-3 py-1.5 text-sm font-medium focus-visible:ring-2 focus-visible:ring-stone-400 focus-visible:outline-none',
      on
        ? 'bg-stone-900 text-white'
        : 'border border-stone-300 bg-white text-stone-700 hover:bg-stone-50',
    );

  let body: React.ReactNode;
  if (tab === 'mine') {
    const mine = await apiGet('admin/sales/commission-terms/mine', commissionTermsSchema);
    body = (
      <div className="flex flex-col gap-4">
        <Card title={t.mine.heading} testId="terms-mine">
          <p className="mb-3 text-sm text-stone-600">{t.mine.readOnly}</p>
          <Valid terms={mine} />
        </Card>
        <Card title={t.history.heading}>
          <History terms={mine} />
        </Card>
      </div>
    );
  } else {
    const people = await apiGet('admin/sales/commission-terms', commissionTermsOverviewSchema);
    const selectedId =
      people.find((p) => p.salesperson.id === q.salesperson)?.salesperson.id ??
      people[0]?.salesperson.id;
    const selected = selectedId
      ? await apiGet('admin/sales/commission-terms', commissionTermsSchema, {
          salesperson: selectedId,
        })
      : null;
    body =
      people.length === 0 || !selected ? (
        <EmptyState>{t.settings.none}</EmptyState>
      ) : (
        <div className="grid gap-4 lg:grid-cols-[16rem_1fr]">
          <Card title={t.settings.pick}>
            <ul className="flex flex-col gap-1" data-testid="terms-people">
              {people.map((p) => (
                <li key={p.salesperson.id}>
                  <Link
                    href={`/sales/commissions?salesperson=${p.salesperson.id}`}
                    aria-current={p.salesperson.id === selectedId ? 'page' : undefined}
                    className={cn(
                      'block rounded-md px-3 py-2 text-sm focus-visible:ring-2 focus-visible:ring-stone-400 focus-visible:outline-none',
                      p.salesperson.id === selectedId
                        ? 'bg-stone-100 font-medium'
                        : 'hover:bg-stone-50',
                    )}
                  >
                    {p.salesperson.name}
                    <span className="block text-xs text-stone-500">
                      {p.valid ? summary(p.valid) : t.missing}
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
          </Card>
          <div className="flex flex-col gap-4">
            <Card title={selected.salesperson.name} testId="terms-selected">
              <Valid terms={selected} />
            </Card>
            <Card title={t.settings.newVersion}>
              <CommissionTermsForm
                key={`${selected.salesperson.id}:${selected.valid?.version ?? 0}`}
                salespersonId={selected.salesperson.id}
                expectedVersion={selected.valid?.version ?? 0}
              />
            </Card>
            <Card title={t.history.heading}>
              <History terms={selected} />
            </Card>
          </div>
        </div>
      );
  }

  return (
    <>
      <SalesHeader active="commissions" title={t.title} subtitle={t.subtitle} />
      {manage && (
        <nav aria-label={t.title} className="mb-4 flex gap-2">
          <Link
            href="/sales/commissions"
            aria-current={tab === 'settings' ? 'page' : undefined}
            className={tabClass(tab === 'settings')}
          >
            {t.tabs.settings}
          </Link>
          <Link
            href="/sales/commissions?tab=mine"
            aria-current={tab === 'mine' ? 'page' : undefined}
            className={tabClass(tab === 'mine')}
          >
            {t.tabs.mine}
          </Link>
        </nav>
      )}
      {body}
    </>
  );
}
