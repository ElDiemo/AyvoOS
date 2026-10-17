'use client';

import { orderDetailSchema } from '@ayvo/types';
import { useRouter } from 'next/navigation';
import { useId, useState } from 'react';
import { ConfirmDialog, reasonError, ReasonField, useAttempt } from '@/components/catalog/form-kit';
import { buttonClass } from '@/components/ui';
import { ordersCs } from '@/i18n/cs/orders';
import { apiSend } from '@/lib/client-api';
import { orderErrorText } from './order-errors';

const t = ordersCs.detail;

/** Stornovat objednávku (orders:manage, reason): its crates are released, history kept. */
export function CancelOrder({ code }: { code: string }) {
  const router = useRouter();
  const id = useId();
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);
  const { busy, run } = useAttempt();

  async function confirm() {
    const invalid = reasonError(reason);
    setError(invalid);
    if (invalid) return;
    const body = { reason: reason.trim() };
    const result = await run(JSON.stringify(body), (requestId) =>
      apiSend('POST', `admin/orders/${code}/cancel`, orderDetailSchema, { requestId, ...body }),
    );
    if (result.ok) {
      setOpen(false);
      router.refresh();
    } else if (result.error) setError(orderErrorText(result.error));
  }

  return (
    <>
      <button type="button" className={buttonClass.secondary} onClick={() => setOpen(true)}>
        {t.cancel}
      </button>
      <ConfirmDialog
        open={open}
        title={t.cancelTitle}
        confirmLabel={t.cancelConfirm}
        danger
        busy={busy}
        onConfirm={confirm}
        onCancel={() => setOpen(false)}
        testId="cancel-order"
      >
        <p>{t.cancelText}</p>
        <ReasonField id={`${id}-reason`} value={reason} onChange={setReason} error={error} />
      </ConfirmDialog>
    </>
  );
}
