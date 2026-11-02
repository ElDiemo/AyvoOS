import { priceListVersionSchema } from '@ayvo/types';
import { z } from 'zod';
import { PriceForm } from '@/components/finance/billing-forms';
import { financeAmount, financeMonth } from '@/components/finance/finance-format';
import { FinanceHeader } from '@/components/finance/finance-header';
import { Card } from '@/components/ui';
import { billingCs as t } from '@/i18n/cs/finance-billing';
import { apiGet } from '@/lib/api';
import { hasPermission, requirePermission } from '@/lib/session';

export const dynamic = 'force-dynamic';

/**
 * Výchozí ceník (doc 044 U3): the only editor. finance:billing_read to read and
 * finance:billing_manage to change, not the issuer's permission of the neighbouring page.
 */
export default async function PricesPage() {
  const me = await requirePermission('finance:billing_read');
  const prices = await apiGet('admin/finance/billing/price-list', z.array(priceListVersionSchema));
  return (
    <>
      <FinanceHeader
        active="settings"
        view="prices"
        title={t.pricesTitle}
        subtitle={t.pricesSubtitle}
      />
      <Card testId="billing-prices">
        <p className="mb-3 text-xs text-stone-500">{t.priceListHelp}</p>
        {prices.length === 0 ? (
          <p className="text-sm text-stone-500">{t.noPrices}</p>
        ) : (
          <ul className="divide-y divide-stone-100 text-sm">
            {prices.map((p) => (
              <li key={p.id} className="flex flex-wrap items-baseline gap-x-4 gap-y-1 py-2">
                <span className="tabular-nums font-medium">
                  {financeAmount(p.pricePerRoomMonth, p.currency)}
                </span>
                <span>od {financeMonth(p.effectiveFrom)}</span>
                <span className="text-stone-600">{p.reason}</span>
                <span className="text-xs text-stone-500">{t.revision(p.revision)}</span>
              </li>
            ))}
          </ul>
        )}
        {hasPermission(me, 'finance:billing_manage') && (
          <details className="mt-4">
            <summary className="cursor-pointer text-sm font-medium">{t.newPrice}</summary>
            <div className="mt-3">
              <PriceForm prices={prices} />
            </div>
          </details>
        )}
      </Card>
    </>
  );
}
