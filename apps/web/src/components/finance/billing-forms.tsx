'use client';

import {
  BILLING_TIMINGS,
  type BillingAgreementVersion,
  type BillingCustomer,
  type BillingCustomerVersion,
  type FinanceContractHotel,
  type PriceListVersion,
} from '@ayvo/types';
import { useRouter } from 'next/navigation';
import { useRef, useState } from 'react';
import { z } from 'zod';
import { buttonClass, ErrorNote, inputClass } from '@/components/ui';
import { billingCs as t } from '@/i18n/cs/finance-billing';
import { apiSend, ClientApiError } from '@/lib/client-api';

const label = 'flex min-w-0 flex-col gap-1 text-sm font-medium';
const blankToNull = (v: string) => (v.trim() === '' ? null : v.trim());

/** One request id per attempt (a retry replays); a new one after any edit. */
function useSubmit() {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const requestId = useRef(crypto.randomUUID());
  const fresh = () => {
    requestId.current = crypto.randomUUID();
    setSaved(false);
  };
  async function send(path: string, body: Record<string, unknown>, done?: (r: unknown) => void) {
    setBusy(true);
    setError(null);
    setSaved(false);
    try {
      const r = await apiSend('POST', path, z.unknown(), { requestId: requestId.current, ...body });
      fresh();
      done?.(r);
      setSaved(true);
      router.refresh();
    } catch (err) {
      if (err instanceof ClientApiError && err.code && t.errors[err.code]) {
        setError(t.errors[err.code]!);
        if (err.code === 'CONCURRENT_CHANGE') router.refresh();
      } else setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }
  return { busy, error, saved, send, fresh };
}

function Field({
  name,
  text,
  value,
  onChange,
  required = false,
  type = 'text',
  inputMode,
}: {
  name: string;
  text: string;
  value: string;
  onChange: (v: string) => void;
  required?: boolean;
  type?: string;
  inputMode?: 'numeric' | 'decimal';
}) {
  return (
    <label className={label}>
      {text}
      <input
        name={name}
        type={type}
        required={required}
        inputMode={inputMode}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className={inputClass}
      />
    </label>
  );
}

function Submit({ busy, saved, testId }: { busy: boolean; saved: boolean; testId: string }) {
  return (
    <div className="flex flex-wrap items-center gap-3">
      <button type="submit" className={buttonClass.primary} disabled={busy} data-testid={testId}>
        {busy ? t.saving : t.save}
      </button>
      {saved && (
        <span className="text-sm text-emerald-800" role="status">
          {t.saved}
        </span>
      )}
    </div>
  );
}

const CUSTOMER_KEYS = [
  'legalName',
  'companyId',
  'vatId',
  'addressLine1',
  'addressLine2',
  'postalCode',
  'city',
  'countryCode',
  'billingEmail',
] as const;
type CustomerValues = Record<(typeof CUSTOMER_KEYS)[number], string>;
const REQUIRED_CUSTOMER = new Set([
  'legalName',
  'addressLine1',
  'postalCode',
  'city',
  'countryCode',
  'billingEmail',
]);

/** A new customer, or a new version of one edited from its current version (expectedVersion). */
export function CustomerForm({
  code,
  current,
}: {
  code?: string;
  current?: BillingCustomerVersion;
}) {
  const initial = Object.fromEntries(
    CUSTOMER_KEYS.map((k) => [k, current?.customer[k] ?? (k === 'countryCode' ? 'CZ' : '')]),
  ) as CustomerValues;
  const [values, setValues] = useState(initial);
  const [reason, setReason] = useState('');
  const { busy, error, saved, send, fresh } = useSubmit();
  const set = (k: keyof CustomerValues) => (v: string) => {
    setValues({ ...values, [k]: v });
    fresh();
  };
  return (
    <form
      className="flex flex-col gap-3"
      data-testid={code ? `customer-version-${code}` : 'customer-new'}
      onSubmit={(e) => {
        e.preventDefault();
        const customer = Object.fromEntries(
          CUSTOMER_KEYS.map((k) => [
            k,
            REQUIRED_CUSTOMER.has(k) ? values[k].trim() : blankToNull(values[k]),
          ]),
        );
        void send(
          code
            ? `admin/finance/billing/customers/${code}/versions`
            : 'admin/finance/billing/customers',
          code ? { expectedVersion: current!.version, customer, reason } : { customer },
          () => {
            if (!code) setValues(initial);
            setReason('');
          },
        );
      }}
    >
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        {CUSTOMER_KEYS.map((k) => (
          <Field
            key={k}
            name={k}
            text={t.fields[k]}
            value={values[k]}
            onChange={set(k)}
            required={REQUIRED_CUSTOMER.has(k)}
            type={k === 'billingEmail' ? 'email' : 'text'}
          />
        ))}
      </div>
      {code && (
        <Field name="reason" text={t.fields.reason} value={reason} onChange={setReason} required />
      )}
      {error && <ErrorNote>{error}</ErrorNote>}
      <Submit busy={busy} saved={saved} testId={code ? 'customer-version-save' : 'customer-save'} />
    </form>
  );
}

/** The current Prague month "YYYY-MM". */
const thisMonth = () =>
  new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Prague', year: 'numeric', month: '2-digit' })
    .format(new Date())
    .slice(0, 7);

/**
 * The terms of a hotel agreement: a new agreement for a hotel without one, or a new version of an
 * agreement edited from its newest revision (expectedRevision).
 */
export function AgreementForm({
  hotels,
  customers,
  code,
  current,
}: {
  hotels?: FinanceContractHotel[];
  customers: BillingCustomer[];
  code?: string;
  current?: BillingAgreementVersion;
}) {
  const [hotelId, setHotelId] = useState('');
  const [v, setV] = useState({
    effectiveFrom: current ? thisMonth() : thisMonth(),
    customerId: current?.customer.id ?? '',
    contractNumber: current?.contractNumber ?? '',
    billedRooms: current ? String(current.billedRooms) : '',
    ownPrice: current?.ownPricePerRoomMonth ?? '',
    currency: current?.currency ?? 'CZK',
    paymentTermsDays: current ? String(current.paymentTermsDays) : '14',
    billingTiming: current?.billingTiming ?? 'ARREARS',
    validFrom: current?.validFrom ?? `${thisMonth()}-01`,
    validTo: current?.validTo ?? '',
    reason: '',
  });
  const { busy, error, saved, send, fresh } = useSubmit();
  const set = (k: keyof typeof v) => (x: string) => {
    setV({ ...v, [k]: x });
    fresh();
  };
  return (
    <form
      className="flex flex-col gap-3"
      data-testid={code ? `agreement-version-${code}` : 'agreement-new'}
      onSubmit={(e) => {
        e.preventDefault();
        const terms = {
          effectiveFrom: v.effectiveFrom,
          customerId: v.customerId,
          contractNumber: blankToNull(v.contractNumber),
          billedRooms: Number(v.billedRooms),
          ownPricePerRoomMonth: blankToNull(v.ownPrice),
          currency: v.currency.trim().toUpperCase(),
          paymentTermsDays: Number(v.paymentTermsDays),
          billingTiming: v.billingTiming,
          validFrom: v.validFrom,
          validTo: blankToNull(v.validTo),
          reason: v.reason.trim(),
        };
        void send(
          code
            ? `admin/finance/billing/agreements/${code}/versions`
            : 'admin/finance/billing/agreements',
          code ? { expectedRevision: current!.revision, terms } : { hotelId, terms },
          () => setV({ ...v, reason: '' }),
        );
      }}
    >
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        {hotels && (
          <label className={label}>
            {t.fields.hotel}
            <select
              required
              name="hotelId"
              value={hotelId}
              onChange={(e) => {
                setHotelId(e.target.value);
                fresh();
              }}
              className={inputClass}
            >
              <option value="">–</option>
              {hotels.map((h) => (
                <option key={h.id} value={h.id}>
                  {h.name} ({h.code})
                </option>
              ))}
            </select>
          </label>
        )}
        <label className={label}>
          {t.fields.customer}
          <select
            required
            name="customerId"
            value={v.customerId}
            onChange={(e) => set('customerId')(e.target.value)}
            className={inputClass}
          >
            <option value="">–</option>
            {customers.map((c) => (
              <option key={c.id} value={c.id}>
                {c.current.customer.legalName} ({c.code})
              </option>
            ))}
          </select>
        </label>
        <Field
          name="effectiveFrom"
          text={t.fields.effectiveFrom}
          type="month"
          value={v.effectiveFrom}
          onChange={set('effectiveFrom')}
          required
        />
        <Field
          name="billedRooms"
          text={t.fields.billedRooms}
          inputMode="numeric"
          value={v.billedRooms}
          onChange={set('billedRooms')}
          required
        />
        <Field
          name="ownPrice"
          text={t.fields.ownPrice}
          inputMode="decimal"
          value={v.ownPrice}
          onChange={set('ownPrice')}
        />
        <Field
          name="currency"
          text={t.fields.currency}
          value={v.currency}
          onChange={set('currency')}
          required
        />
        <Field
          name="paymentTermsDays"
          text={t.fields.paymentTermsDays}
          inputMode="numeric"
          value={v.paymentTermsDays}
          onChange={set('paymentTermsDays')}
          required
        />
        <label className={label}>
          {t.fields.billingTiming}
          <select
            name="billingTiming"
            value={v.billingTiming}
            onChange={(e) => set('billingTiming')(e.target.value)}
            className={inputClass}
          >
            {BILLING_TIMINGS.map((x) => (
              <option key={x} value={x}>
                {t.timing[x]}
              </option>
            ))}
          </select>
        </label>
        <Field
          name="validFrom"
          text={t.fields.validFrom}
          type="date"
          value={v.validFrom}
          onChange={set('validFrom')}
          required
        />
        <Field
          name="validTo"
          text={t.fields.validTo}
          type="date"
          value={v.validTo}
          onChange={set('validTo')}
        />
        <Field
          name="contractNumber"
          text={t.fields.contractNumber}
          value={v.contractNumber}
          onChange={set('contractNumber')}
        />
        <Field
          name="reason"
          text={t.fields.reason}
          value={v.reason}
          onChange={set('reason')}
          required
        />
      </div>
      {error && <ErrorNote>{error}</ErrorNote>}
      <Submit
        busy={busy}
        saved={saved}
        testId={code ? 'agreement-version-save' : 'agreement-save'}
      />
    </form>
  );
}

/** A default price from a month; a correction of a month names the revision it was loaded from. */
export function PriceForm({ prices }: { prices: PriceListVersion[] }) {
  const [v, setV] = useState({
    currency: 'CZK',
    price: '',
    effectiveFrom: thisMonth(),
    reason: '',
  });
  const { busy, error, saved, send, fresh } = useSubmit();
  const set = (k: keyof typeof v) => (x: string) => {
    setV({ ...v, [k]: x });
    fresh();
  };
  return (
    <form
      className="flex flex-col gap-3"
      data-testid="price-new"
      onSubmit={(e) => {
        e.preventDefault();
        const currency = v.currency.trim().toUpperCase();
        const expected =
          prices
            .filter((p) => p.currency === currency && p.effectiveFrom === v.effectiveFrom)
            .reduce<number | null>(
              (m, p) => (m === null || p.revision > m ? p.revision : m),
              null,
            ) ?? null;
        void send(
          'admin/finance/billing/price-list',
          {
            expectedRevision: expected,
            currency,
            pricePerRoomMonth: v.price.trim(),
            effectiveFrom: v.effectiveFrom,
            reason: v.reason.trim(),
          },
          () => setV({ ...v, price: '', reason: '' }),
        );
      }}
    >
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-4">
        <Field
          name="currency"
          text={t.fields.currency}
          value={v.currency}
          onChange={set('currency')}
          required
        />
        <Field
          name="price"
          text={t.fields.price}
          inputMode="decimal"
          value={v.price}
          onChange={set('price')}
          required
        />
        <Field
          name="effectiveFrom"
          text={t.fields.effectiveFrom}
          type="month"
          value={v.effectiveFrom}
          onChange={set('effectiveFrom')}
          required
        />
        <Field
          name="reason"
          text={t.fields.reason}
          value={v.reason}
          onChange={set('reason')}
          required
        />
      </div>
      {error && <ErrorNote>{error}</ErrorNote>}
      <Submit busy={busy} saved={saved} testId="price-save" />
    </form>
  );
}
