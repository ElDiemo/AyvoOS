import Link from 'next/link';
import { notFound } from 'next/navigation';
import type { PortalInvoice } from '@ayvo/types';
import { Shell } from '@/components/shell';
import { cs } from '@/i18n/cs';
import { PortalRefusal, PortalUnavailable } from '@/lib/backend';
import { portalEnv } from '@/lib/env';
import { formatDate, formatMoney } from '@/lib/format';
import { myInvoice, portalSession } from '@/lib/portal';

export const dynamic = 'force-dynamic';

export default async function InvoicePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!/^[0-9a-f-]{36}$/.test(id)) notFound();
  const { token, view } = await portalSession();
  let invoice: PortalInvoice | null = null;
  try {
    invoice = await myInvoice(token, id);
  } catch (error) {
    // Another payer's or hotel's invoice: not found, exactly like a missing one.
    if (error instanceof PortalRefusal && error.status === 404) notFound();
    if (!(error instanceof PortalUnavailable)) throw error;
  }
  return (
    <Shell user={view.user} active="invoices" testInvoices={portalEnv().APP_ENV !== 'production'}>
      <Link href="/invoices" className="text-sm underline">
        {cs.invoices.back}
      </Link>
      {!invoice ? (
        <p role="alert" className="text-sm text-amber-900" data-testid="invoices-unavailable">
          {cs.invoices.unavailable}
        </p>
      ) : (
        <>
          <h1 className="text-xl font-semibold" data-testid="portal-invoice-number">
            {invoice.kind === 'TEST' && (
              <span className="mr-2 rounded bg-amber-100 px-1 text-xs font-semibold text-amber-900">
                {cs.invoices.test}
              </span>
            )}
            {invoice.number}
          </h1>
          <dl className="grid grid-cols-1 gap-1 text-sm sm:grid-cols-[10rem_1fr]">
            <dt className="text-stone-500">{cs.invoices.issued}</dt>
            <dd>{formatDate(invoice.issuedOn)}</dd>
            <dt className="text-stone-500">{cs.invoices.due}</dt>
            <dd>{formatDate(invoice.dueOn)}</dd>
            <dt className="text-stone-500">{cs.invoices.month}</dt>
            <dd>{invoice.periodMonth}</dd>
            <dt className="text-stone-500">{cs.invoices.total}</dt>
            <dd>{formatMoney(invoice.total, invoice.currency)}</dd>
            <dt className="text-stone-500">{cs.invoices.hotels}</dt>
            <dd>{invoice.hotels.map((h) => h.name).join(', ')}</dd>
            <dt className="text-stone-500">{cs.invoices.state}</dt>
            <dd data-testid="portal-invoice-state">
              {invoice.cancelled ? cs.invoices.cancelled : cs.invoices.states[invoice.paymentState]}
            </dd>
          </dl>
          <a
            href={`/invoices/${invoice.id}/pdf`}
            download
            className="self-start rounded-md bg-stone-900 px-4 py-2 text-sm font-medium text-white"
          >
            {cs.invoices.pdf}
          </a>
        </>
      )}
    </Shell>
  );
}
