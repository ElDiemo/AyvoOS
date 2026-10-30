import type { InvoiceSummary } from '@ayvo/types';
import Link from 'next/link';
import { financeAmount, financeDate, financeMonth } from '@/components/finance/finance-format';
import { financeCs } from '@/i18n/cs/finance';

const t = financeCs.invoices;

/** Rows of invoices (Faktury, the related invoices of an agreement — doc 042): each to its detail. */
export function InvoiceList({ invoices }: { invoices: readonly InvoiceSummary[] }) {
  return (
    <ul className="divide-y divide-stone-100 text-sm">
      {invoices.map((i) => (
        <li
          key={i.number}
          className={`flex flex-wrap items-baseline gap-x-4 gap-y-1 py-2 ${
            i.status === 'CANCELLED' ? 'text-stone-400' : ''
          }`}
          data-testid={`invoice-row-${i.number}`}
        >
          <Link href={`/finance/invoices/${i.number}`} className="font-mono underline">
            {i.number}
          </Link>
          <span className="min-w-0 flex-1">
            {i.customer.legalName} · {financeMonth(i.period)} ·{' '}
            {i.hotels.map((h) => h.name).join(', ')}
          </span>
          <span className="tabular-nums">{financeAmount(i.total, i.currency)}</span>
          <span>
            {t.dueOn} {financeDate(i.dueOn)}
          </span>
          <span className="font-medium">
            {i.status === 'CANCELLED'
              ? t.status[i.status]
              : `${t.paymentState[i.paymentState.state]}${
                  i.paymentState.overdue ? ` · ${t.overdue}` : ''
                }`}
          </span>
          {i.deliveryState && (
            <span className="text-stone-600" data-testid={`invoice-delivery-${i.number}`}>
              {t.delivery.state[i.deliveryState]}
            </span>
          )}
        </li>
      ))}
    </ul>
  );
}
