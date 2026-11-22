'use client';

import { commissionStatementSchema } from '@ayvo/types';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import {
  describedBy,
  fieldClass,
  FormField,
  uncertain,
  useAttempt,
} from '@/components/catalog/form-kit';
import { buttonClass, ErrorNote } from '@/components/ui';
import { commissionsCs } from '@/i18n/cs/commissions';
import { apiSend, ClientApiError } from '@/lib/client-api';
import { invoiceBase, refusalText } from './commission-closing-format';

const t = commissionsCs.closing.invoice;
type Key = 'invoiceNumber' | 'issuedOn' | 'receivedOn' | 'base';

/**
 * Records the salesperson's one invoice on an approved statement (ADMIN; doc 069 §5d, doc 068
 * I3). The form checks only that the fields are filled in; every rule (dates, base = amount to
 * invoice, one number per salesperson) is the server's, and its refusal is shown in Czech. The
 * planned payout day comes from the server's answer. Nothing is paid.
 */
export function SalespersonInvoiceForm({
  statementId,
  amountLabel,
  today,
}: {
  statementId: string;
  amountLabel: string;
  today: string;
}) {
  const router = useRouter();
  const { busy, run } = useAttempt();
  const [values, setValues] = useState<Record<Key, string>>({
    invoiceNumber: '',
    issuedOn: '',
    receivedOn: today,
    base: '',
  });
  const [errors, setErrors] = useState<Partial<Record<Key, string>>>({});
  const [failure, setFailure] = useState<string | null>(null);
  const id = (k: Key) => `si-${statementId}-${k}`;

  async function submit(ev: React.FormEvent) {
    ev.preventDefault();
    setFailure(null);
    const base = invoiceBase(values.base);
    const e: Partial<Record<Key, string>> = {};
    if (!values.invoiceNumber.trim()) e.invoiceNumber = t.required.number;
    if (!values.issuedOn) e.issuedOn = t.required.date;
    if (!values.receivedOn) e.receivedOn = t.required.date;
    if (base === null) e.base = t.required.base;
    setErrors(e);
    if (Object.keys(e).length > 0) return;
    const body = {
      invoiceNumber: values.invoiceNumber.trim(),
      issuedOn: values.issuedOn,
      receivedOn: values.receivedOn,
      base: base!,
      currency: 'CZK' as const,
    };
    const result = await run(JSON.stringify(body), (requestId) =>
      apiSend(
        'POST',
        `admin/finance/commissions/statements/${statementId}/salesperson-invoice`,
        commissionStatementSchema,
        { requestId, ...body },
      ),
    );
    if (result.ok) {
      router.refresh();
      return;
    }
    if (!result.error) return;
    const err = result.error;
    const code = err instanceof ClientApiError ? err.code : null;
    setFailure(uncertain(err) ? t.errors.uncertain : refusalText(t.errors, code, t.errors.failed));
  }

  const field = (k: Key, type: 'text' | 'date', help?: string) => (
    <input
      id={id(k)}
      type={type}
      inputMode={k === 'base' ? 'decimal' : undefined}
      autoComplete="off"
      maxLength={k === 'invoiceNumber' ? 40 : undefined}
      className={fieldClass(Boolean(errors[k]))}
      value={values[k]}
      aria-invalid={errors[k] ? true : undefined}
      aria-describedby={describedBy(id(k), Boolean(help), Boolean(errors[k]))}
      onChange={(ev) => setValues((v) => ({ ...v, [k]: ev.target.value }))}
      data-testid={`si-${k}`}
    />
  );

  return (
    <form onSubmit={submit} noValidate className="flex flex-col gap-3" data-testid="si-form">
      <div className="grid gap-3 sm:grid-cols-2">
        <FormField id={id('invoiceNumber')} label={t.number} error={errors.invoiceNumber}>
          {field('invoiceNumber', 'text')}
        </FormField>
        <FormField
          id={id('base')}
          label={t.base}
          help={t.baseHelp(amountLabel)}
          error={errors.base}
        >
          {field('base', 'text', t.baseHelp(amountLabel))}
        </FormField>
        <FormField id={id('issuedOn')} label={t.issuedOn} error={errors.issuedOn}>
          {field('issuedOn', 'date')}
        </FormField>
        <FormField id={id('receivedOn')} label={t.receivedOn} error={errors.receivedOn}>
          {field('receivedOn', 'date')}
        </FormField>
      </div>
      <p className="text-xs text-stone-500">{t.checks}</p>
      {failure && <ErrorNote>{failure}</ErrorNote>}
      <div>
        <button type="submit" className={buttonClass.primary} disabled={busy} data-testid="si-save">
          {t.submit}
        </button>
      </div>
    </form>
  );
}
