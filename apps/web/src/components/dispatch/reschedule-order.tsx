'use client';

import { orderDetailSchema } from '@ayvo/types';
import { useRouter } from 'next/navigation';
import { useId, useState } from 'react';
import {
  ConfirmDialog,
  fieldClass,
  FormField,
  reasonError,
  ReasonField,
  useAttempt,
} from '@/components/catalog/form-kit';
import { buttonClass } from '@/components/ui';
import { ordersCs } from '@/i18n/cs/orders';
import { apiSend } from '@/lib/client-api';
import { orderErrorText } from './order-errors';

const t = ordersCs.detail;

/**
 * "Změnit den odeslání" (orders:manage, doc 032): explicit, with a reason; e.g. a planned order
 * prepared and sent earlier. Neither the supply plan nor other orders change.
 */
export function RescheduleOrder({
  code,
  current,
  today,
}: {
  code: string;
  current: string;
  today: string;
}) {
  const router = useRouter();
  const id = useId();
  const [open, setOpen] = useState(false);
  const [date, setDate] = useState(current);
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [dateError, setDateError] = useState<string | null>(null);
  const { busy, run } = useAttempt();

  async function confirm() {
    const invalid = reasonError(reason);
    const badDate =
      !date || date < today
        ? ordersCs.errors.SHIP_DATE_IN_PAST!
        : date === current
          ? ordersCs.errors.SAME_SHIP_DATE!
          : null;
    setError(invalid);
    setDateError(badDate);
    if (invalid || badDate) return;
    const body = { shipDate: date, reason: reason.trim() };
    const result = await run(JSON.stringify(body), (requestId) =>
      apiSend('POST', `admin/orders/${code}/reschedule`, orderDetailSchema, { requestId, ...body }),
    );
    if (result.ok) {
      setOpen(false);
      setReason('');
      router.refresh();
    } else if (result.error) setError(orderErrorText(result.error));
  }

  return (
    <>
      <button
        type="button"
        className={buttonClass.secondary}
        onClick={() => setOpen(true)}
        data-testid="reschedule-order"
      >
        {t.reschedule}
      </button>
      <ConfirmDialog
        open={open}
        title={t.rescheduleTitle}
        confirmLabel={t.rescheduleConfirm}
        busy={busy}
        onConfirm={confirm}
        onCancel={() => setOpen(false)}
        testId="reschedule-dialog"
      >
        <p>{t.rescheduleText}</p>
        <p className="mt-2 text-xs text-stone-600">{ordersCs.shipNotDelivery}</p>
        <div className="mt-3 flex flex-col gap-3">
          <FormField id={`${id}-date`} label={t.rescheduleDate} error={dateError}>
            <input
              id={`${id}-date`}
              type="date"
              min={today}
              className={fieldClass(!!dateError)}
              value={date}
              onChange={(e) => setDate(e.target.value)}
              data-testid="reschedule-date"
            />
          </FormField>
          <ReasonField id={`${id}-reason`} value={reason} onChange={setReason} error={error} />
        </div>
      </ConfirmDialog>
    </>
  );
}
