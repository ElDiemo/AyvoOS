'use client';

import { orderDetailSchema, type HotelSummary, type OrderableProduct } from '@ayvo/types';
import { useRouter } from 'next/navigation';
import { useId, useRef, useState } from 'react';
import {
  describedBy,
  ErrorSummary,
  fieldClass,
  FormField,
  useAttempt,
  useFocusFirstError,
} from '@/components/catalog/form-kit';
import { buttonClass, Card } from '@/components/ui';
import { ordersCs } from '@/i18n/cs/orders';
import { apiSend } from '@/lib/client-api';
import { orderErrorText } from './order-errors';

const t = ordersCs.form;

/** Today in the browser's local calendar (the server checks the site's time zone again). */
function localToday(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

export function OrderForm({
  hotels,
  products,
  initialHotel,
}: {
  hotels: HotelSummary[];
  products: OrderableProduct[];
  initialHotel: string;
}) {
  const router = useRouter();
  const id = useId();
  const form = useRef<HTMLFormElement>(null);
  const focusError = useFocusFirstError(form);
  const [hotel, setHotel] = useState(initialHotel);
  const [date, setDate] = useState(localToday());
  const [crates, setCrates] = useState<Record<string, string>>({});
  const [errors, setErrors] = useState<Record<string, string | null>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const { busy, run } = useAttempt();
  const count = (code: string) => {
    const n = Number(crates[code] ?? '');
    return Number.isInteger(n) && n > 0 ? n : 0;
  };
  const lines = products.filter((p) => count(p.code) > 0);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    const invalid = products.some((p) => {
      const raw = (crates[p.code] ?? '').trim();
      return raw !== '' && !/^\d{1,3}$/.test(raw);
    });
    const next = {
      hotel: hotel ? null : t.required,
      date: !date ? t.required : date < localToday() ? t.dateInvalid : null,
      lines: invalid || lines.length === 0 ? t.noLines : null,
    };
    setErrors(next);
    setFormError(null);
    if (Object.values(next).some(Boolean)) return focusError();
    const body = {
      hotelCode: hotel,
      requestedShipDate: date,
      lines: lines.map((p) => ({ productCode: p.code, crates: count(p.code) })),
    };
    const result = await run(JSON.stringify(body), (requestId) =>
      apiSend('POST', 'admin/orders', orderDetailSchema, { requestId, ...body }),
    );
    if (result.ok) router.push(`/dispatch/orders/${result.value.code}`);
    else if (result.error) setFormError(orderErrorText(result.error));
  }

  return (
    <Card>
      <form
        ref={form}
        noValidate
        onSubmit={submit}
        className="flex flex-col gap-5"
        data-testid="order-form"
      >
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
          <FormField id={`${id}-hotel`} label={t.hotel} help={t.hotelHelp} error={errors.hotel}>
            <select
              id={`${id}-hotel`}
              name="hotel"
              value={hotel}
              onChange={(e) => setHotel(e.target.value)}
              aria-invalid={!!errors.hotel}
              aria-describedby={describedBy(`${id}-hotel`, true, !!errors.hotel)}
              className={fieldClass(!!errors.hotel)}
            >
              <option value="">{t.choose}</option>
              {hotels.map((h) => (
                <option key={h.code} value={h.code}>
                  {h.name} – {h.city}
                </option>
              ))}
            </select>
          </FormField>
          <FormField id={`${id}-date`} label={t.shipDate} error={errors.date}>
            <input
              id={`${id}-date`}
              name="requestedShipDate"
              type="date"
              value={date}
              min={localToday()}
              onChange={(e) => setDate(e.target.value)}
              aria-invalid={!!errors.date}
              aria-describedby={describedBy(`${id}-date`, false, !!errors.date)}
              className={fieldClass(!!errors.date)}
            />
          </FormField>
        </div>
        <fieldset
          className="flex flex-col gap-2"
          aria-describedby={errors.lines ? `${id}-lines-error` : undefined}
        >
          <legend className="mb-1 text-xs font-medium uppercase tracking-wide text-stone-500">
            {t.products}
          </legend>
          {products.map((p) => (
            <div
              key={p.code}
              data-testid={`order-line-${p.code}`}
              className="grid grid-cols-[minmax(0,1fr)_6rem] items-center gap-3 rounded-md border border-stone-200 px-3 py-2 sm:grid-cols-[minmax(0,1fr)_6rem_8rem]"
            >
              <label htmlFor={`${id}-p-${p.code}`} className="min-w-0 text-sm">
                <span className="font-medium">{p.name}</span>
                <span className="block text-xs text-stone-500">
                  {t.capacity(p.crateType.name, p.capacity)}
                </span>
              </label>
              <input
                id={`${id}-p-${p.code}`}
                inputMode="numeric"
                aria-label={`${t.crates}: ${p.name}`}
                value={crates[p.code] ?? ''}
                placeholder="0"
                onChange={(e) =>
                  setCrates({ ...crates, [p.code]: e.target.value.replace(/[^\d]/g, '') })
                }
                className={`${fieldClass(!!errors.lines)} text-right tabular-nums`}
              />
              <span className="col-span-2 text-right text-sm tabular-nums text-stone-600 sm:col-span-1">
                {t.bottles(count(p.code) * p.capacity)}
              </span>
            </div>
          ))}
          {errors.lines && (
            <p
              id={`${id}-lines-error`}
              className="text-xs font-medium text-red-700"
              data-field-error
            >
              {errors.lines}
            </p>
          )}
        </fieldset>
        <ErrorSummary errors={errors} formError={formError} />
        <div>
          <button
            type="submit"
            disabled={busy || hotels.length === 0 || products.length === 0}
            className={buttonClass.primary}
          >
            {t.submit}
          </button>
        </div>
      </form>
    </Card>
  );
}
