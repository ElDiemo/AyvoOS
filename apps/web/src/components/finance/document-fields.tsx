'use client';

import { FINANCE_DOCUMENT_KINDS, type FinanceSupplier } from '@ayvo/types';
import { inputClass } from '@/components/ui';
import { financeCs as t } from '@/i18n/cs/finance';

export interface DocumentFieldValues {
  supplierId: string;
  kind: string;
  documentNumber: string;
  issuedOn: string;
  taxPointOn: string;
  dueOn: string;
  totalAmount: string;
  currency: string;
  description: string;
  handoverMonth: string;
}

export const emptyFields: DocumentFieldValues = {
  supplierId: '',
  kind: 'INVOICE',
  documentNumber: '',
  issuedOn: '',
  taxPointOn: '',
  dueOn: '',
  totalAmount: '',
  currency: 'CZK',
  description: '',
  handoverMonth: '',
};

/**
 * The metadata inputs, shared by receiving and correcting a document. Only the kind is needed to
 * save; what the export needs (supplier, number, issue date, handover month) may be completed later.
 */
export function DocumentFields({
  values,
  onChange,
  suppliers,
}: {
  values: DocumentFieldValues;
  onChange: (next: DocumentFieldValues) => void;
  suppliers: readonly FinanceSupplier[];
}) {
  const set = (key: keyof DocumentFieldValues) => (e: { target: { value: string } }) =>
    onChange({ ...values, [key]: e.target.value });
  const label = 'flex min-w-0 flex-col gap-1 text-sm font-medium';
  return (
    <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
      <label className={label}>
        {t.fields.supplier}
        <select className={inputClass} value={values.supplierId} onChange={set('supplierId')}>
          <option value="">{t.receive.chooseSupplier}</option>
          {suppliers.map((s) => (
            <option key={s.id} value={s.id}>
              {s.name}
            </option>
          ))}
        </select>
      </label>
      <label className={label}>
        {t.fields.kind}
        <select className={inputClass} value={values.kind} onChange={set('kind')}>
          {FINANCE_DOCUMENT_KINDS.map((k) => (
            <option key={k} value={k}>
              {t.kinds[k]}
            </option>
          ))}
        </select>
      </label>
      <label className={label}>
        {t.fields.documentNumber}
        <input
          maxLength={100}
          className={inputClass}
          value={values.documentNumber}
          onChange={set('documentNumber')}
        />
      </label>
      <label className={label}>
        {t.fields.issuedOn}
        <input
          type="date"
          className={inputClass}
          value={values.issuedOn}
          onChange={set('issuedOn')}
        />
      </label>
      <label className={label}>
        {t.fields.taxPointOn}
        <input
          type="date"
          className={inputClass}
          value={values.taxPointOn}
          onChange={set('taxPointOn')}
        />
      </label>
      <label className={label}>
        {t.fields.dueOn}
        <input type="date" className={inputClass} value={values.dueOn} onChange={set('dueOn')} />
      </label>
      <label className={label}>
        {t.fields.totalAmount}
        <input
          inputMode="decimal"
          className={inputClass}
          value={values.totalAmount}
          onChange={set('totalAmount')}
          aria-describedby="finance-amount-help"
        />
        <span id="finance-amount-help" className="text-xs font-normal text-stone-500">
          {t.receive.amountHelp}
        </span>
      </label>
      <label className={label}>
        {t.fields.currency}
        <input
          maxLength={3}
          className={`${inputClass} uppercase`}
          value={values.currency}
          onChange={set('currency')}
        />
      </label>
      <label className={label}>
        {t.fields.handoverMonth}
        <input
          type="month"
          className={inputClass}
          value={values.handoverMonth}
          onChange={set('handoverMonth')}
          aria-describedby="finance-month-help"
        />
        <span id="finance-month-help" className="text-xs font-normal text-stone-500">
          {t.receive.monthHelp}
        </span>
      </label>
      <label className={label}>
        {t.fields.description}
        <input
          maxLength={500}
          className={inputClass}
          value={values.description}
          onChange={set('description')}
        />
      </label>
    </div>
  );
}

/** The values as the API expects them: amount and currency only together. */
export function toPayload(v: DocumentFieldValues) {
  const amount = v.totalAmount.trim().replace(',', '.');
  return {
    supplierId: v.supplierId || null,
    kind: v.kind,
    documentNumber: v.documentNumber.trim() || null,
    issuedOn: v.issuedOn || null,
    taxPointOn: v.taxPointOn || null,
    dueOn: v.dueOn || null,
    totalAmount: amount || null,
    currency: amount ? v.currency.trim().toUpperCase() || null : null,
    description: v.description.trim() || null,
    handoverMonth: v.handoverMonth || null,
  };
}
