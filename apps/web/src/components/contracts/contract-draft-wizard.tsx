'use client';

import {
  contractDraftDetailSchema,
  hotelIdentityMatches,
  type ContractDraftFields,
  type ContractDraftPrefill,
  type HotelIdentity,
} from '@ayvo/types';
import { useRouter } from 'next/navigation';
import { useRef, useState } from 'react';
import { buttonClass, ErrorNote, inputClass } from '@/components/ui';
import { contractsCs as t } from '@/i18n/cs/contracts';
import { apiSend, ClientApiError } from '@/lib/client-api';
import { parseDecimalInput } from '@/lib/decimal-input';

type Values = Record<
  | 'counterpartyName'
  | 'counterpartyCompanyId'
  | 'counterpartyAddress'
  | 'representativeName'
  | 'representativeRole'
  | 'hotelName'
  | 'hotelAddress'
  | 'rooms'
  | 'price'
  | 'currency'
  | 'startOn'
  | 'billingTiming'
  | 'paymentTermsDays'
  | 'holders'
  | 'holdersOwnership'
  | 'hotelCode'
  | 'reason',
  string
>;

const label = 'flex min-w-0 flex-col gap-1 text-sm font-medium';
const fromFields = (f: ContractDraftFields): Partial<Values> => ({
  counterpartyName: f.counterpartyName,
  counterpartyCompanyId: f.counterpartyCompanyId ?? '',
  counterpartyAddress: f.counterpartyAddress ?? '',
  representativeName: f.representativeName ?? '',
  representativeRole: f.representativeRole ?? '',
  hotelName: f.hotelName,
  hotelAddress: f.hotelAddress,
  rooms: String(f.rooms),
  price: f.pricePerRoomMonth.replace('.', ','),
  currency: f.currency,
  startOn: f.startOn,
  billingTiming: f.billingTiming,
  paymentTermsDays: String(f.paymentTermsDays),
  holders: f.holders,
  holdersOwnership: f.holdersOwnership ?? '',
});

/**
 * The wizard of a contract draft (doc 045 §2): prefilled from the prospect or hotel, nothing
 * written until "Uložit návrh". Holders: the ownership choice exists only "S držáky"; switching to
 * "Bez držáků" hides and clears it (the server refuses a mismatch anyway). The check section names
 * what is missing and needs an explicit confirmation. Editing saves a new revision with a reason.
 */
export function ContractDraftWizard(
  props:
    | { mode: 'create'; prefill: ContractDraftPrefill }
    | {
        mode: 'revise';
        code: string;
        version: number;
        current: ContractDraftFields;
        /** The linked hotel's record, if any (the draft must name it, or say it knowingly). */
        linkedHotel: HotelIdentity | null;
      },
) {
  const router = useRouter();
  const pre = props.mode === 'create' ? props.prefill : null;
  const [v, setV] = useState<Values>({
    counterpartyName: pre?.fields.counterpartyName ?? '',
    counterpartyCompanyId: '',
    counterpartyAddress: '',
    representativeName: '',
    representativeRole: '',
    hotelName: pre?.fields.hotelName ?? '',
    hotelAddress: pre?.fields.hotelAddress ?? '',
    rooms: pre?.fields.rooms ? String(pre.fields.rooms) : '',
    price: '',
    currency: 'CZK',
    startOn: '',
    billingTiming: '',
    paymentTermsDays: '',
    holders: '',
    holdersOwnership: '',
    hotelCode: pre?.hotel?.code ?? '',
    reason: '',
    ...(props.mode === 'revise' ? fromFields(props.current) : {}),
  });
  const [checked, setChecked] = useState(false);
  const [ackHotel, setAckHotel] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const requestId = useRef(crypto.randomUUID());
  const set = (k: keyof Values) => (value: string) => {
    setV((old) => ({
      ...old,
      [k]: value,
      // Without holders there is no ownership: hidden and cleared, never kept silently.
      ...(k === 'holders' && value !== 'WITH' ? { holdersOwnership: '' } : {}),
    }));
    setChecked(false);
    setAckHotel(false);
    setError(null);
    requestId.current = crypto.randomUUID();
  };
  // The hotel this draft is (or will be) linked to: written in the draft as it is, or knowingly not.
  const chosenHotel: HotelIdentity | null =
    props.mode === 'revise'
      ? props.linkedHotel
      : (pre?.hotels.find((h) => h.code === v.hotelCode) ?? null);
  const hotelMismatch =
    !!chosenHotel &&
    !hotelIdentityMatches({ name: v.hotelName, address: v.hotelAddress }, chosenHotel);

  const price = parseDecimalInput(v.price);
  const missing = [
    !v.counterpartyName.trim() && t.fields.counterpartyName,
    !v.hotelName.trim() && t.fields.hotelName,
    !v.hotelAddress.trim() && t.fields.hotelAddress,
    !/^\d+$/.test(v.rooms) && t.fields.rooms,
    (price === null || Number(price) <= 0) && t.fields.price,
    !/^[A-Z]{3}$/.test(v.currency) && t.fields.currency,
    !v.startOn && t.fields.startOn,
    !v.billingTiming && t.fields.billingTiming,
    !/^\d+$/.test(v.paymentTermsDays) && t.fields.paymentTermsDays,
    !v.holders && t.fields.holders,
    v.holders === 'WITH' && !v.holdersOwnership && t.fields.holdersOwnership,
    props.mode === 'revise' && !v.reason.trim() && t.fields.reason,
    hotelMismatch && !ackHotel && t.identity.title,
  ].filter(Boolean) as string[];

  async function save() {
    if (missing.length > 0 || !checked || price === null) return;
    const fields: ContractDraftFields = {
      counterpartyName: v.counterpartyName.trim(),
      counterpartyCompanyId: v.counterpartyCompanyId.trim() || null,
      counterpartyAddress: v.counterpartyAddress.trim() || null,
      representativeName: v.representativeName.trim() || null,
      representativeRole: v.representativeRole.trim() || null,
      hotelName: v.hotelName.trim(),
      hotelAddress: v.hotelAddress.trim(),
      rooms: Number(v.rooms),
      pricePerRoomMonth: price,
      currency: v.currency,
      startOn: v.startOn,
      billingTiming: v.billingTiming as ContractDraftFields['billingTiming'],
      paymentTermsDays: Number(v.paymentTermsDays),
      holders: v.holders as ContractDraftFields['holders'],
      holdersOwnership:
        v.holders === 'WITH'
          ? (v.holdersOwnership as ContractDraftFields['holdersOwnership'])
          : null,
    };
    setBusy(true);
    setError(null);
    try {
      if (props.mode === 'create') {
        const d = await apiSend('POST', 'admin/contracts/drafts', contractDraftDetailSchema, {
          requestId: requestId.current,
          prospectCode: props.prefill.prospect?.code ?? null,
          hotelCode: v.hotelCode || null,
          fields,
          acknowledgeHotelMismatch: hotelMismatch && ackHotel,
        });
        router.push(`/sales/contracts/${d.code}?saved=1`);
      } else {
        await apiSend(
          'POST',
          `admin/contracts/drafts/${props.code}/revisions`,
          contractDraftDetailSchema,
          {
            requestId: requestId.current,
            expectedVersion: props.version,
            reason: v.reason.trim(),
            fields,
            acknowledgeHotelMismatch: hotelMismatch && ackHotel,
          },
        );
        requestId.current = crypto.randomUUID();
        router.refresh();
      }
    } catch (err) {
      const code = err instanceof ClientApiError ? err.code : null;
      setError((code && t.errors[code]) ?? (err instanceof Error ? err.message : String(err)));
      if (code === 'CONCURRENT_CHANGE') router.refresh();
    } finally {
      setBusy(false);
    }
  }

  const input = (k: keyof Values, text: string, extra: Record<string, unknown> = {}) => (
    <label className={label}>
      {text}
      <input
        name={k}
        className={inputClass}
        value={v[k]}
        onChange={(e) => set(k)(e.target.value)}
        {...extra}
      />
    </label>
  );
  const select = (k: keyof Values, text: string, options: Record<string, string>) => (
    <label className={label}>
      {text}
      <select name={k} className={inputClass} value={v[k]} onChange={(e) => set(k)(e.target.value)}>
        <option value="">{t.choose}</option>
        {Object.entries(options).map(([value, name]) => (
          <option key={value} value={value}>
            {name}
          </option>
        ))}
      </select>
    </label>
  );
  const section = (title: string, children: React.ReactNode) => (
    <fieldset className="flex min-w-0 flex-col gap-3 border-t border-stone-200 pt-4">
      <legend className="pr-2 text-sm font-semibold">{title}</legend>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">{children}</div>
    </fieldset>
  );

  return (
    <form
      className="flex flex-col gap-5"
      data-testid="contract-wizard"
      onSubmit={(e) => {
        e.preventDefault();
        void save();
      }}
    >
      {section(
        t.sections.counterparty,
        <>
          {input('counterpartyName', t.fields.counterpartyName)}
          {input('counterpartyCompanyId', t.fields.counterpartyCompanyId)}
          {input('counterpartyAddress', t.fields.counterpartyAddress)}
          {input('representativeName', t.fields.representativeName)}
          {input('representativeRole', t.fields.representativeRole)}
        </>,
      )}
      {section(
        t.sections.hotel,
        <>
          {input('hotelName', t.fields.hotelName)}
          {input('hotelAddress', t.fields.hotelAddress)}
          {pre && pre.hotels.length > 0 && (
            <label className={label}>
              {t.fields.linkHotel}
              <select
                name="hotelCode"
                className={inputClass}
                value={v.hotelCode}
                onChange={(e) => set('hotelCode')(e.target.value)}
              >
                <option value="">{t.fields.noHotel}</option>
                {pre.hotels.map((h) => (
                  <option key={h.code} value={h.code}>
                    {h.name} ({h.code})
                  </option>
                ))}
              </select>
            </label>
          )}
          {hotelMismatch && chosenHotel && (
            <div className="sm:col-span-2">
              <HotelMismatch
                draft={{ name: v.hotelName, address: v.hotelAddress }}
                hotel={chosenHotel}
                acknowledged={ackHotel}
                onAcknowledge={setAckHotel}
              />
            </div>
          )}
        </>,
      )}
      {section(
        t.sections.terms,
        <>
          {input('rooms', t.fields.rooms, { inputMode: 'numeric' })}
          {input('price', t.fields.price, { inputMode: 'decimal' })}
          {input('currency', t.fields.currency, { maxLength: 3 })}
          {input('startOn', t.fields.startOn, { type: 'date' })}
          {select('billingTiming', t.fields.billingTiming, t.timing)}
          {input('paymentTermsDays', t.fields.paymentTermsDays, { inputMode: 'numeric' })}
        </>,
      )}
      {section(
        t.sections.holders,
        <>
          {select('holders', t.fields.holders, t.holders)}
          {v.holders === 'WITH' &&
            select('holdersOwnership', t.fields.holdersOwnership, t.ownership)}
          <p className="text-xs text-stone-500 sm:col-span-2">{t.holdersHelp}</p>
        </>,
      )}
      <fieldset className="flex min-w-0 flex-col gap-3 border-t border-stone-200 pt-4">
        <legend className="pr-2 text-sm font-semibold">{t.sections.check}</legend>
        {props.mode === 'revise' && input('reason', t.fields.reason)}
        <dl
          className="grid grid-cols-1 gap-x-6 gap-y-1 text-sm sm:grid-cols-2"
          data-testid="contract-check"
        >
          <dt className="text-stone-500">{t.fields.counterpartyName}</dt>
          <dd className="wrap-anywhere">{v.counterpartyName || '—'}</dd>
          <dt className="text-stone-500">{t.fields.hotelName}</dt>
          <dd className="wrap-anywhere">{v.hotelName || '—'}</dd>
          <dt className="text-stone-500">{t.fields.price}</dt>
          <dd>{price ? `${price.replace('.', ',')} ${v.currency}` : '—'}</dd>
          <dt className="text-stone-500">{t.fields.holders}</dt>
          <dd>
            {v.holders
              ? `${t.holders[v.holders]}${v.holdersOwnership ? ` · ${t.ownership[v.holdersOwnership]}` : ''}`
              : '—'}
          </dd>
        </dl>
        <p className="text-xs text-stone-500">{t.optionalHelp}</p>
        {missing.length > 0 ? (
          <p className="text-sm text-amber-800" data-testid="contract-missing">
            {t.missing(missing.join(', '))}
          </p>
        ) : (
          <label className="flex items-start gap-2 text-sm">
            <input
              type="checkbox"
              className="mt-1"
              checked={checked}
              onChange={(e) => setChecked(e.target.checked)}
              data-testid="contract-checked"
            />
            <span>{t.checked}</span>
          </label>
        )}
      </fieldset>
      <div>
        <button
          type="submit"
          className={buttonClass.primary}
          disabled={busy || missing.length > 0 || !checked}
          data-testid="contract-save"
        >
          {busy ? t.saving : props.mode === 'create' ? t.save : t.saveRevision}
        </button>
      </div>
      {error && <ErrorNote>{error}</ErrorNote>}
    </form>
  );
}

/** Both identities side by side; saving needs an explicit acknowledgement (review CD121-1). */
export function HotelMismatch({
  draft,
  hotel,
  acknowledged,
  onAcknowledge,
}: {
  draft: HotelIdentity;
  hotel: HotelIdentity;
  acknowledged: boolean;
  onAcknowledge: (v: boolean) => void;
}) {
  return (
    <div
      className="flex flex-col gap-2 rounded-md border border-amber-300 bg-amber-50 p-3 text-sm text-amber-950"
      data-testid="hotel-mismatch"
    >
      <p className="font-semibold">{t.identity.title}</p>
      <dl className="grid grid-cols-1 gap-x-4 gap-y-1 sm:grid-cols-[auto_1fr]">
        <dt className="text-amber-800">{t.identity.draft}</dt>
        <dd className="wrap-anywhere">
          {draft.name || '—'}, {draft.address || '—'}
        </dd>
        <dt className="text-amber-800">{t.identity.hotel}</dt>
        <dd className="wrap-anywhere">
          {hotel.name}, {hotel.address}
        </dd>
      </dl>
      <label className="flex items-start gap-2">
        <input
          type="checkbox"
          className="mt-1"
          checked={acknowledged}
          onChange={(e) => onAcknowledge(e.target.checked)}
          data-testid="hotel-mismatch-ack"
        />
        <span>{t.identity.acknowledge}</span>
      </label>
    </div>
  );
}
