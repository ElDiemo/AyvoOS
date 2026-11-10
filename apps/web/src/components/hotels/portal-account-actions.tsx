'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { z } from 'zod';
import { buttonClass, ErrorNote, inputClass } from '@/components/ui';
import { hotelUsersCs as t } from '@/i18n/cs/hotel-users';
import { apiSend, ClientApiError } from '@/lib/client-api';

/** A confirmed action with a required reason (the same rule as for internal users). */
function ReasonAction({
  label,
  confirm,
  help,
  path,
  testId,
}: {
  label: string;
  confirm: string;
  help?: string;
  path: string;
  testId: string;
}) {
  const router = useRouter();
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <details>
      <summary className="cursor-pointer text-sm font-medium" data-testid={testId}>
        {label}
      </summary>
      <form
        className="mt-2 flex max-w-md flex-col gap-2"
        onSubmit={async (e) => {
          e.preventDefault();
          if (busy) return;
          setBusy(true);
          setError(null);
          try {
            await apiSend('POST', path, z.unknown(), { reason });
            setReason('');
            router.refresh();
          } catch (err) {
            setError(
              err instanceof ClientApiError && err.code && t.errors[err.code]
                ? t.errors[err.code]!
                : err instanceof Error
                  ? err.message
                  : String(err),
            );
          } finally {
            setBusy(false);
          }
        }}
      >
        {help && <p className="text-xs text-stone-500">{help}</p>}
        <label className="flex flex-col gap-1 text-sm">
          <span>{t.actions.reason}</span>
          <input
            name="reason"
            required
            minLength={3}
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            className={inputClass}
          />
        </label>
        {error && <ErrorNote>{error}</ErrorNote>}
        <button
          type="submit"
          disabled={busy}
          className={buttonClass.secondary}
          data-testid={`${testId}-confirm`}
        >
          {confirm}
        </button>
      </form>
    </details>
  );
}

/** Deactivation (ends the account's sessions now) or reactivation of a hotel portal account. */
export function AccountStatusAction({ accountId, active }: { accountId: string; active: boolean }) {
  // Distinct keys: after the change the other action starts closed and empty (a reused <details>
  // would stay open).
  return active ? (
    <ReasonAction
      key="deactivate"
      label={t.actions.deactivate}
      confirm={t.actions.confirm}
      help={t.actions.deactivateHelp}
      path={`admin/identity/portal-accounts/${accountId}/deactivate`}
      testId="portal-account-deactivate"
    />
  ) : (
    <ReasonAction
      key="reactivate"
      label={t.actions.reactivate}
      confirm={t.actions.confirm}
      path={`admin/identity/portal-accounts/${accountId}/reactivate`}
      testId="portal-account-reactivate"
    />
  );
}

/** Revocation of one grant through the core's existing route (no Finance check needed). */
export function RevokeGrant({ grantId }: { grantId: string }) {
  return (
    <ReasonAction
      label={t.actions.revoke}
      confirm={t.actions.confirmRevoke}
      path={`admin/identity/portal-grants/${grantId}/revoke`}
      testId={`portal-grant-revoke-${grantId}`}
    />
  );
}
