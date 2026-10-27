'use client';

import { effectiveTermsPageSchema, invoiceDetailSchema, type EffectiveTerms } from '@ayvo/types';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { useAttempt } from '@/components/catalog/form-kit';
import { buttonClass, EmptyState, ErrorNote, inputClass } from '@/components/ui';
import { financeCs } from '@/i18n/cs/finance';
import { apiGet, apiSend, ClientApiError } from '@/lib/client-api';
import { financeAmount, sumAmounts, timesRooms } from './finance-format';

const t = financeCs.invoices;

const errorText = (e: unknown) =>
  e instanceof ClientApiError && e.code && t.errors[e.code]
    ? t.errors[e.code]!
    : e instanceof Error
      ? e.message
      : String(e);

/** An agreement of the month that can be invoiced as is: in effect, complete, with a price. */
const invoiceable = (i: EffectiveTerms) =>
  i.status === 'IN_EFFECT' && i.gaps.length === 0 && !!i.customer && i.price.perRoomMonth !== null;

/**
 * Choose the month and agreements of ONE customer: one = a separate TEST invoice, several = a
 * summary with a line per hotel. Agreements that cannot be invoiced say why; nothing is computed
 * beyond rooms × price (shown exactly, never a float).
 */
export function TestInvoiceForm({ month: initialMonth }: { month: string }) {
  const router = useRouter();
  const [month, setMonth] = useState(initialMonth);
  const [items, setItems] = useState<EffectiveTerms[] | null>(null);
  const [chosen, setChosen] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const attempt = useAttempt();

  async function load(e?: React.FormEvent, keepChoice = false) {
    e?.preventDefault();
    setLoading(true);
    if (!keepChoice) {
      setError(null);
      setChosen([]);
    }
    try {
      const page = await apiGet(
        `admin/finance/billing/agreements/effective?month=${month}`,
        effectiveTermsPageSchema,
      );
      setItems(page.items.filter((i) => i.status === 'IN_EFFECT'));
    } catch (err) {
      setError(errorText(err));
    } finally {
      setLoading(false);
    }
  }

  const byCode = new Map((items ?? []).map((i) => [i.agreement.code, i]));
  const customerOf = (code: string) => byCode.get(code)?.customer?.code ?? null;
  const toggle = (code: string) =>
    setChosen((c) =>
      c.includes(code)
        ? c.filter((x) => x !== code)
        : // One customer per invoice: choosing another customer's agreement starts a new choice.
          [...c.filter((x) => customerOf(x) === customerOf(code)), code],
    );
  const amountOf = (i: EffectiveTerms) => timesRooms(i.version!.billedRooms, i.price.perRoomMonth!);
  const selected = chosen.map((c) => byCode.get(c)!).filter(Boolean);
  const currency = selected[0]?.version?.currency ?? null;
  const groups = new Map<string, EffectiveTerms[]>();
  for (const i of items ?? []) {
    const key = i.customer?.code ?? '—';
    groups.set(key, [...(groups.get(key) ?? []), i]);
  }

  async function issue() {
    setError(null);
    // Exactly what the user sees: if the terms change before issuing, nothing is issued.
    const lines = selected.map((i) => ({
      agreementCode: i.agreement.code,
      agreementRevision: i.version!.revision,
      customerVersion: i.customer!.version,
      priceListVersionId: i.price.priceListVersionId,
      unitPrice: i.price.perRoomMonth!,
      billedRooms: i.version!.billedRooms,
    }));
    const body = { month, lines };
    const r = await attempt.run(JSON.stringify(body), (requestId) =>
      apiSend('POST', 'admin/finance/invoices/test', invoiceDetailSchema, { requestId, ...body }),
    );
    if (r.ok) router.push(`/finance/invoices/${r.value.number}`);
    else if (r.error) {
      setError(errorText(r.error));
      // Changed meanwhile: show the current terms; the user decides again (never issued by itself).
      if (r.error instanceof ClientApiError && r.error.code === 'TERMS_CHANGED')
        await load(undefined, true);
    }
  }

  return (
    <div className="flex flex-col gap-4" data-testid="test-invoice-form">
      <form className="flex flex-wrap items-end gap-3" onSubmit={load}>
        <label className="flex flex-col gap-1 text-sm font-medium">
          {t.month}
          <input
            type="month"
            required
            value={month}
            onChange={(e) => {
              setMonth(e.target.value);
              setItems(null);
              setChosen([]);
            }}
            className={inputClass}
            data-testid="invoice-month"
          />
        </label>
        <button type="submit" className={buttonClass.secondary} disabled={loading}>
          {t.load}
        </button>
      </form>
      {items !== null &&
        (items.length === 0 ? (
          <EmptyState>{t.noAgreements}</EmptyState>
        ) : (
          [...groups.entries()].map(([customer, list]) => (
            <fieldset key={customer} className="rounded-md border border-stone-200 p-3">
              <legend className="px-1 text-sm font-semibold">
                {list[0]?.customer?.customer.legalName ?? customer}{' '}
                <span className="font-mono text-xs text-stone-500">{customer}</span>
              </legend>
              <ul className="flex flex-col gap-2">
                {list.map((i) => {
                  const ok = invoiceable(i);
                  return (
                    <li key={i.agreement.code}>
                      <label className="flex items-start gap-2 text-sm">
                        <input
                          type="checkbox"
                          className="mt-1"
                          disabled={!ok}
                          checked={chosen.includes(i.agreement.code)}
                          onChange={() => toggle(i.agreement.code)}
                          data-testid={`invoice-agreement-${i.agreement.code}`}
                        />
                        <span className="min-w-0">
                          <span className="font-medium">{i.agreement.hotel.name}</span>{' '}
                          <span className="font-mono text-xs text-stone-500">
                            {i.agreement.code}
                          </span>
                          <span className="block text-stone-600">
                            {ok
                              ? t.line(
                                  i.version!.billedRooms,
                                  financeAmount(i.price.perRoomMonth, i.version!.currency),
                                  financeAmount(amountOf(i), i.version!.currency),
                                )
                              : `${t.notInvoiceable}: ${i.gaps.map((g) => t.gaps[g] ?? g).join(', ')}`}
                          </span>
                        </span>
                      </label>
                    </li>
                  );
                })}
              </ul>
            </fieldset>
          ))
        ))}
      {selected.length > 0 && (
        <p className="text-sm font-medium" data-testid="invoice-selection">
          {t.selected(selected.length, financeAmount(sumAmounts(selected.map(amountOf)), currency))}
        </p>
      )}
      {error && <ErrorNote>{error}</ErrorNote>}
      <div>
        <button
          type="button"
          className={buttonClass.primary}
          disabled={chosen.length === 0 || attempt.busy}
          onClick={issue}
          data-testid="invoice-issue"
        >
          {attempt.busy ? t.submitting : t.submit}
        </button>
      </div>
    </div>
  );
}
