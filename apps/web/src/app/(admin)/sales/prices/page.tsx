import { salesIndicativePricesSchema } from '@ayvo/types';
import { PriceForm } from '@/components/sales/price-form';
import { cents, formatCents } from '@/components/sales/sales-money';
import { salesDateTime } from '@/components/sales/sales-format';
import { SalesHeader } from '@/components/sales/sales-header';
import { Card, EmptyState } from '@/components/ui';
import { salesCs } from '@/i18n/cs/sales';
import { apiGet } from '@/lib/api';
import { requirePermission } from '@/lib/session';

export const dynamic = 'force-dynamic';
const t = salesCs.prices;
const show = (amount: string) => formatCents(cents(amount));

/** Orientační cena (sales:manage): the current price per currency, a new version, the history. */
export default async function SalesPricesPage() {
  await requirePermission('sales:manage');
  const prices = await apiGet('admin/sales/indicative-prices', salesIndicativePricesSchema);
  return (
    <>
      <SalesHeader active="prices" title={t.title} subtitle={t.subtitle} />
      <div className="flex flex-col gap-6">
        <Card title={t.current} testId="prices-current">
          {prices.current.length === 0 ? (
            <EmptyState>{t.none}</EmptyState>
          ) : (
            <ul className="flex flex-col gap-2 text-sm">
              {prices.current.map((p) => (
                <li key={p.currency} data-testid={`price-current-${p.currency}`}>
                  <strong>
                    {show(p.amount)} {p.currency}
                  </strong>{' '}
                  · {p.note}
                </li>
              ))}
            </ul>
          )}
        </Card>
        <Card title={t.form}>
          <PriceForm />
        </Card>
        {prices.history.length > 0 && (
          <Card title={t.history} testId="prices-history">
            <ul className="flex flex-col divide-y divide-stone-100 text-sm">
              {prices.history.map((p) => (
                <li key={p.id} className="flex flex-wrap justify-between gap-2 py-2">
                  <span>
                    {show(p.amount)} {p.currency} · {p.note}
                  </span>
                  <span className="text-xs text-stone-500">
                    {t.setBy(p.setBy, salesDateTime(p.setAt))}
                  </span>
                </li>
              ))}
            </ul>
          </Card>
        )}
      </div>
    </>
  );
}
