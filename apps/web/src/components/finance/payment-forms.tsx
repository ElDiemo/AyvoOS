'use client';

import {
  incomingPaymentSchema,
  paymentLoadResultSchema,
  type IncomingPayment,
  type PaymentLoadResult,
} from '@ayvo/types';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { useAttempt } from '@/components/catalog/form-kit';
import { buttonClass, ErrorNote, inputClass } from '@/components/ui';
import { financeCs } from '@/i18n/cs/finance';
import { apiSend, ClientApiError } from '@/lib/client-api';

const t = financeCs.payments;
const errorText = (e: unknown) =>
  e instanceof ClientApiError && e.code && t.errors[e.code]
    ? t.errors[e.code]!
    : e instanceof Error
      ? e.message
      : String(e);
const loadedText = (r: PaymentLoadResult) =>
  t.loaded(r.created.length, r.alreadyLoaded, r.matched, r.toReview) +
  (r.changedAtBank > 0 ? ` ${t.changedAtBank(r.changedAtBank)}` : '');

interface Row {
  reference: string;
  amount: string;
  variableSymbol: string;
  message: string;
}
const newReference = () => `SIM-${crypto.randomUUID().slice(0, 8).toUpperCase()}`;

/**
 * A simulated statement (outside production): entries with their own references. Loading the same
 * statement again records nothing new — the result says how many were loaded before.
 */
export function SimulateStatementForm() {
  const router = useRouter();
  const [rows, setRows] = useState<Row[]>([
    { reference: newReference(), amount: '', variableSymbol: '', message: '' },
  ]);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const attempt = useAttempt();
  const set = (i: number, patch: Partial<Row>) =>
    setRows((r) => r.map((x, j) => (j === i ? { ...x, ...patch } : x)));
  return (
    <form
      className="flex flex-col gap-3"
      data-testid="simulate-statement"
      onSubmit={async (e) => {
        e.preventDefault();
        setError(null);
        setMessage(null);
        const entries = rows.map((r) => ({
          reference: r.reference.trim(),
          amount: r.amount.trim(),
          currency: 'CZK',
          bookedOn: new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Prague' }).format(
            new Date(),
          ),
          variableSymbol: r.variableSymbol.trim() || null,
          counterpartyName: null,
          message: r.message.trim() || null,
        }));
        // A new request each time: loading the same statement again is the point to show.
        const res = await attempt.run(crypto.randomUUID(), (requestId) =>
          apiSend('POST', 'admin/finance/payments/simulate', paymentLoadResultSchema, {
            requestId,
            entries,
          }),
        );
        if (res.ok) {
          setMessage(loadedText(res.value));
          router.refresh();
        } else if (res.error) setError(errorText(res.error));
      }}
    >
      {rows.map((r, i) => (
        <div
          key={i}
          className="grid grid-cols-2 gap-2 sm:grid-cols-4"
          data-testid={`simulate-row-${i + 1}`}
        >
          <label className="flex min-w-0 flex-col gap-1 text-xs font-medium">
            {t.reference}
            <input
              required
              value={r.reference}
              onChange={(e) => set(i, { reference: e.target.value.toUpperCase() })}
              className={`${inputClass} font-mono`}
            />
          </label>
          <label className="flex min-w-0 flex-col gap-1 text-xs font-medium">
            {t.amount}
            <input
              required
              inputMode="decimal"
              value={r.amount}
              onChange={(e) => set(i, { amount: e.target.value })}
              className={inputClass}
              data-testid={`simulate-amount-${i + 1}`}
            />
          </label>
          <label className="flex min-w-0 flex-col gap-1 text-xs font-medium">
            {t.variableSymbol}
            <input
              inputMode="numeric"
              value={r.variableSymbol}
              onChange={(e) => set(i, { variableSymbol: e.target.value })}
              className={inputClass}
              data-testid={`simulate-vs-${i + 1}`}
            />
          </label>
          <label className="flex min-w-0 flex-col gap-1 text-xs font-medium">
            {t.message}
            <input
              value={r.message}
              onChange={(e) => set(i, { message: e.target.value })}
              className={inputClass}
            />
          </label>
        </div>
      ))}
      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          className={buttonClass.secondary}
          onClick={() =>
            setRows((r) => [
              ...r,
              { reference: newReference(), amount: '', variableSymbol: '', message: '' },
            ])
          }
          data-testid="simulate-add"
        >
          {t.addRow}
        </button>
        <button
          type="submit"
          className={buttonClass.primary}
          disabled={attempt.busy}
          data-testid="simulate-submit"
        >
          {t.simulate}
        </button>
      </div>
      {error && <ErrorNote>{error}</ErrorNote>}
      {message && (
        <p className="text-sm text-emerald-800" role="status" data-testid="simulate-result">
          {message}
        </p>
      )}
    </form>
  );
}

/** Records the credit bank transactions already read (never calls the bank). */
export function ImportBankButton() {
  const router = useRouter();
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const attempt = useAttempt();
  return (
    <div className="flex flex-col gap-2">
      <p className="text-xs text-stone-500">{t.importHelp}</p>
      <div>
        <button
          type="button"
          className={buttonClass.secondary}
          disabled={attempt.busy}
          data-testid="import-bank"
          onClick={async () => {
            setError(null);
            const res = await attempt.run(crypto.randomUUID(), (requestId) =>
              apiSend('POST', 'admin/finance/payments/import-bank', paymentLoadResultSchema, {
                requestId,
              }),
            );
            if (res.ok) {
              setMessage(loadedText(res.value));
              router.refresh();
            } else if (res.error) setError(errorText(res.error));
          }}
        >
          {t.importBank}
        </button>
      </div>
      {error && <ErrorNote>{error}</ErrorNote>}
      {message && (
        <p className="text-sm text-emerald-800" role="status">
          {message}
        </p>
      )}
    </div>
  );
}

/** A person allocates (a part of) a payment to an invoice, with a reason. */
export function AllocatePaymentForm({
  payment,
  openInvoices,
}: {
  payment: IncomingPayment;
  openInvoices: string[];
}) {
  const router = useRouter();
  const [invoice, setInvoice] = useState(payment.suggestions[0] ?? '');
  const [amount, setAmount] = useState(payment.unallocated);
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);
  const attempt = useAttempt();
  return (
    <form
      className="grid grid-cols-1 gap-2 sm:grid-cols-4"
      data-testid={`allocate-${payment.code}`}
      onSubmit={async (e) => {
        e.preventDefault();
        setError(null);
        const body = { invoiceNumber: invoice, amount: amount.trim(), reason: reason.trim() };
        const res = await attempt.run(`${payment.code}:${JSON.stringify(body)}`, (requestId) =>
          apiSend(
            'POST',
            `admin/finance/payments/${payment.code}/allocations`,
            incomingPaymentSchema,
            { requestId, ...body },
          ),
        );
        if (res.ok) router.refresh();
        else if (res.error) setError(errorText(res.error));
      }}
    >
      <label className="flex min-w-0 flex-col gap-1 text-xs font-medium">
        {t.invoice}
        <select
          required
          value={invoice}
          onChange={(e) => setInvoice(e.target.value)}
          className={inputClass}
        >
          <option value="">–</option>
          {openInvoices.map((n) => (
            <option key={n} value={n}>
              {n}
            </option>
          ))}
        </select>
      </label>
      <label className="flex min-w-0 flex-col gap-1 text-xs font-medium">
        {t.amount}
        <input
          required
          inputMode="decimal"
          value={amount}
          onChange={(e) => setAmount(e.target.value)}
          className={inputClass}
        />
      </label>
      <label className="flex min-w-0 flex-col gap-1 text-xs font-medium sm:col-span-2">
        {t.reason}
        <input
          required
          minLength={3}
          maxLength={500}
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          className={inputClass}
          data-testid={`allocate-${payment.code}-reason`}
        />
      </label>
      <div className="sm:col-span-4">
        <button
          type="submit"
          className={buttonClass.primary}
          disabled={attempt.busy}
          data-testid={`allocate-${payment.code}-submit`}
        >
          {t.allocate}
        </button>
      </div>
      {error && (
        <div className="sm:col-span-4">
          <ErrorNote>{error}</ErrorNote>
        </div>
      )}
    </form>
  );
}
