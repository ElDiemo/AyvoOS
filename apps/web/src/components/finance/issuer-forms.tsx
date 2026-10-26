'use client';

import {
  issuerSettingsSchema,
  VAT_STATUSES,
  type IssuerBankAccount,
  type IssuerVersion,
} from '@ayvo/types';
import { useRouter } from 'next/navigation';
import { useRef, useState } from 'react';
import { buttonClass, ErrorNote, inputClass } from '@/components/ui';
import { issuerCs as t } from '@/i18n/cs/finance-issuer';
import { apiSend, ClientApiError } from '@/lib/client-api';

/** One request id per attempt (a retry of the same attempt replays); a new one after any edit. */
function useSubmit() {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const requestId = useRef(crypto.randomUUID());
  const fresh = () => (requestId.current = crypto.randomUUID());
  async function send(path: string, body: Record<string, unknown>, done?: () => void) {
    setBusy(true);
    setError(null);
    try {
      await apiSend('POST', path, issuerSettingsSchema, { requestId: requestId.current, ...body });
      fresh();
      done?.();
      router.refresh();
    } catch (err) {
      if (err instanceof ClientApiError && err.code === 'CONCURRENT_CHANGE') {
        setError(t.errors.CONCURRENT_CHANGE);
        router.refresh();
      } else setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }
  return { busy, error, send, fresh };
}

const label = 'flex min-w-0 flex-col gap-1 text-sm font-medium';
const blankToNull = (v: string) => (v.trim() === '' ? null : v);

function TextField({
  name,
  text,
  value,
  onChange,
  required = false,
  type = 'text',
}: {
  name: string;
  text: string;
  value: string;
  onChange: (v: string) => void;
  required?: boolean;
  type?: string;
}) {
  return (
    <label className={label}>
      {text}
      <input
        name={name}
        type={type}
        required={required}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className={inputClass}
      />
    </label>
  );
}

type IssuerValues = Record<keyof IssuerVersion['issuer'], string>;
const ISSUER_KEYS = Object.keys(t.issuer.fields).filter(
  (k) => k !== 'reason',
) as (keyof IssuerValues)[];

/** The issuer's details as a whole form edited from the current version (expectedVersion). */
export function IssuerForm({ current }: { current: IssuerVersion | null }) {
  const initial = Object.fromEntries(
    ISSUER_KEYS.map((k) => [k, current?.issuer[k] ?? (k === 'countryCode' ? 'CZ' : '')]),
  ) as IssuerValues;
  const [values, setValues] = useState(initial);
  const [reason, setReason] = useState('');
  const { busy, error, send, fresh } = useSubmit();
  const set = (k: keyof IssuerValues) => (v: string) => {
    setValues({ ...values, [k]: v });
    fresh();
  };
  const required = new Set([
    'legalName',
    'addressLine1',
    'postalCode',
    'city',
    'countryCode',
    'companyId',
    'email',
  ]);
  return (
    <form
      className="flex flex-col gap-4"
      data-testid="issuer-form"
      onSubmit={(e) => {
        e.preventDefault();
        void send(
          'admin/finance/issuer/versions',
          {
            expectedVersion: current?.version ?? 0,
            issuer: {
              ...Object.fromEntries(ISSUER_KEYS.map((k) => [k, blankToNull(values[k])])),
            },
            reason,
          },
          () => setReason(''),
        );
      }}
    >
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        {ISSUER_KEYS.filter((k) => k !== 'vatStatus').map((k) => (
          <TextField
            key={k}
            name={k}
            text={t.issuer.fields[k]}
            value={values[k]}
            onChange={set(k)}
            required={required.has(k)}
            type={k === 'email' ? 'email' : 'text'}
          />
        ))}
        <label className={label}>
          {t.issuer.fields.vatStatus}
          <select
            name="vatStatus"
            required
            value={values.vatStatus}
            onChange={(e) => set('vatStatus')(e.target.value)}
            className={inputClass}
          >
            <option value="">{t.issuer.vatStatus.unset}</option>
            {VAT_STATUSES.map((s) => (
              <option key={s} value={s}>
                {t.issuer.vatStatus[s]}
              </option>
            ))}
          </select>
        </label>
      </div>
      <TextField
        name="reason"
        text={t.issuer.fields.reason}
        value={reason}
        onChange={setReason}
        required
      />
      {error && <ErrorNote>{error}</ErrorNote>}
      <div>
        <button type="submit" disabled={busy} className={buttonClass.primary}>
          {t.issuer.save}
        </button>
      </div>
    </form>
  );
}

type AccountValues = Record<keyof IssuerBankAccount['current']['account'], string>;
const ACCOUNT_KEYS = [
  'label',
  'currency',
  'accountPrefix',
  'accountNumber',
  'bankCode',
  'iban',
  'bic',
] as const;

/** A new account, or a new version (also RETIRED) of an existing one, edited from its version. */
export function AccountForm({
  account,
  onDone,
}: {
  account?: IssuerBankAccount;
  onDone?: () => void;
}) {
  const initial = Object.fromEntries(
    ACCOUNT_KEYS.map((k) => [k, account?.current.account[k] ?? (k === 'currency' ? 'CZK' : '')]),
  ) as AccountValues;
  const [values, setValues] = useState(initial);
  const [status, setStatus] = useState(account?.current.status ?? 'ACTIVE');
  const [reason, setReason] = useState('');
  const { busy, error, send, fresh } = useSubmit();
  const set = (k: keyof AccountValues) => (v: string) => {
    setValues({ ...values, [k]: v });
    fresh();
  };
  const payload = Object.fromEntries(ACCOUNT_KEYS.map((k) => [k, blankToNull(values[k])]));
  return (
    <form
      className="flex flex-col gap-4"
      data-testid={account ? `account-form-${account.code}` : 'account-form-new'}
      onSubmit={(e) => {
        e.preventDefault();
        void send(
          account
            ? `admin/finance/issuer/bank-accounts/${account.code}/versions`
            : 'admin/finance/issuer/bank-accounts',
          account
            ? { expectedVersion: account.current.version, status, account: payload, reason }
            : { account: payload, reason },
          () => {
            setReason('');
            onDone?.();
          },
        );
      }}
    >
      <p className="text-xs text-stone-500">{t.accounts.domesticHelp}</p>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        {ACCOUNT_KEYS.map((k) => (
          <TextField
            key={k}
            name={k}
            text={t.accounts.fields[k]}
            value={values[k]}
            onChange={set(k)}
            required={k === 'label' || k === 'currency' || k === 'iban'}
          />
        ))}
        {account && (
          <label className={label}>
            {t.accounts.fields.status}
            <select
              name="status"
              value={status}
              onChange={(e) => {
                setStatus(e.target.value as typeof status);
                fresh();
              }}
              className={inputClass}
            >
              <option value="ACTIVE">{t.accounts.status.ACTIVE}</option>
              <option value="RETIRED">{t.accounts.status.RETIRED}</option>
            </select>
          </label>
        )}
      </div>
      <TextField
        name="reason"
        text={t.accounts.fields.reason}
        value={reason}
        onChange={setReason}
        required
      />
      {error && <ErrorNote>{error}</ErrorNote>}
      <div>
        <button type="submit" disabled={busy} className={buttonClass.primary}>
          {t.accounts.save}
        </button>
      </div>
    </form>
  );
}

/** Choose the default account of a currency (from its active accounts), with the seen revision. */
export function DefaultAccountForm({
  currency,
  accounts,
  currentCode,
  revision,
}: {
  currency: string;
  accounts: IssuerBankAccount[];
  currentCode: string | null;
  revision: number | null;
}) {
  const options = accounts.filter(
    (a) => a.current.status === 'ACTIVE' && a.current.account.currency === currency,
  );
  const [picked, setCode] = useState(currentCode);
  // Accounts added after this form was shown are offered too; never an empty choice.
  const code = options.some((o) => o.code === picked) ? picked! : (options[0]?.code ?? '');
  const [reason, setReason] = useState('');
  const { busy, error, send, fresh } = useSubmit();
  if (options.length === 0) return null;
  return (
    <form
      className="flex flex-col gap-2 sm:flex-row sm:items-end"
      data-testid={`default-form-${currency}`}
      onSubmit={(e) => {
        e.preventDefault();
        void send(
          'admin/finance/issuer/default-accounts',
          { currency, accountCode: code, expectedRevision: revision, reason },
          () => setReason(''),
        );
      }}
    >
      <label className={label}>
        {currency}
        <select
          name="accountCode"
          value={code}
          onChange={(e) => {
            setCode(e.target.value);
            fresh();
          }}
          className={inputClass}
        >
          {options.map((a) => (
            <option key={a.code} value={a.code}>
              {a.code} · {a.current.account.label}
            </option>
          ))}
        </select>
      </label>
      <TextField
        name="reason"
        text={t.defaults.reason}
        value={reason}
        onChange={setReason}
        required
      />
      <button type="submit" disabled={busy} className={buttonClass.secondary}>
        {t.defaults.choose}
      </button>
      {error && <ErrorNote>{error}</ErrorNote>}
    </form>
  );
}
