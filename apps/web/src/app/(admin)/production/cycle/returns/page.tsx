import {
  returnHotelOptionSchema,
  returnReceiptListSchema,
  returnsOverviewSchema,
} from '@ayvo/types';
import Link from 'next/link';
import { z } from 'zod';
import { OpenReturnReceipt } from '@/components/returns/open-receipt';
import { CycleHeader } from '@/components/returns/cycle-header';
import { buttonClass, Card, EmptyState } from '@/components/ui';
import { formatDateTimeCs } from '@/i18n/cs/format';
import { returnsCs } from '@/i18n/cs/returns';
import { apiGet } from '@/lib/api';
import { requirePermission } from '@/lib/session';

export const dynamic = 'force-dynamic';
const t = returnsCs;

/** Výroba → Oběh lahví → Příjem vratek (doc 047 §4.9): receipts of the active site, waiting bottles, issues. */
export default async function ReturnsPage() {
  await requirePermission('returns:receive');
  const [list, overview, hotels] = await Promise.all([
    apiGet('admin/returns/receipts', returnReceiptListSchema),
    apiGet('admin/returns/overview', returnsOverviewSchema),
    apiGet('admin/returns/hotels', z.array(returnHotelOptionSchema)),
  ]);
  return (
    <>
      <CycleHeader
        active="returns"
        title={t.title}
        subtitle={t.subtitle}
        actions={
          <Link href="/production/cycle/after-wash" className={buttonClass.secondary}>
            {t.cycle.next}
          </Link>
        }
      />
      <div className="flex flex-col gap-6">
        <Card title={t.open.title}>
          <OpenReturnReceipt hotels={hotels} />
        </Card>
        <Card title={t.list.title} className="overflow-x-auto">
          {list.items.length === 0 ? (
            <EmptyState>{t.list.empty}</EmptyState>
          ) : (
            <table className="w-full text-left text-sm" data-testid="return-receipts">
              <thead className="border-b border-stone-200 text-xs uppercase tracking-wide text-stone-500">
                <tr>
                  <th className="py-2 pr-4 font-medium">{t.list.code}</th>
                  <th className="py-2 pr-4 font-medium">{t.list.state}</th>
                  <th className="py-2 pr-4 font-medium">{t.list.hotel}</th>
                  <th className="py-2 pr-4 font-medium">{t.list.opened}</th>
                  <th className="py-2 pr-4 font-medium">{t.list.identified}</th>
                  <th className="py-2 font-medium">{t.list.openIssues}</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-stone-100">
                {list.items.map((r) => (
                  <tr key={r.code}>
                    <td className="py-2 pr-4">
                      <Link
                        className="font-medium underline"
                        href={`/production/cycle/returns/${r.code}`}
                      >
                        {r.code}
                      </Link>
                    </td>
                    <td className="py-2 pr-4">{t.state[r.state]}</td>
                    <td className="py-2 pr-4 wrap-anywhere">{r.hotelName ?? '—'}</td>
                    <td className="py-2 pr-4">{formatDateTimeCs(r.openedAt)}</td>
                    <td className="py-2 pr-4">{r.identified}</td>
                    <td className="py-2">{r.openIssues}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Card>
        <div className="grid gap-6 lg:grid-cols-2">
          <Card title={t.overview.waiting}>
            {overview.waitingForWash.length === 0 ? (
              <EmptyState>{t.overview.waitingEmpty}</EmptyState>
            ) : (
              <ul className="flex flex-col gap-1 text-sm" data-testid="waiting-for-wash">
                {overview.waitingForWash.map((b) => (
                  <li key={b.bottleCode} className="flex flex-wrap justify-between gap-2">
                    <span className="font-medium">{b.bottleCode}</span>
                    <span className="text-stone-500">
                      {t.overview.since} {formatDateTimeCs(b.since)} · {b.receipt}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </Card>
          <Card title={t.overview.issues}>
            {overview.openIssues.length === 0 ? (
              <EmptyState>{t.overview.issuesEmpty}</EmptyState>
            ) : (
              <ul className="flex flex-col gap-1 text-sm" data-testid="open-issues">
                {overview.openIssues.map((i) => (
                  <li key={i.code} className="flex flex-wrap justify-between gap-2">
                    <span>
                      <span className="font-medium">{i.code}</span> · {t.issue.kind[i.kind]}
                      {i.bottleCode ? ` · ${i.bottleCode}` : ''}
                    </span>
                    <Link className="underline" href={`/production/cycle/returns/${i.receipt}`}>
                      {t.overview.resolve} ({i.receipt})
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </Card>
        </div>
      </div>
    </>
  );
}
