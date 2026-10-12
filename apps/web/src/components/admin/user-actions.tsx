'use client';

import { adminUserDetailSchema, type AdminUserDetail } from '@ayvo/types';
import { useRouter } from 'next/navigation';
import { useId, useRef, useState } from 'react';
import { buttonClass, Card, ErrorNote, inputClass } from '@/components/ui';
import { identityCs } from '@/i18n/cs/identity';
import { apiSend, ClientApiError } from '@/lib/client-api';
import { errorText } from './create-user-form';

const t = identityCs.admin;
const label = 'text-xs font-medium uppercase tracking-wide text-stone-500';

/**
 * Account actions apart from access (doc 021 §7): invitation and deactivation/reactivation —
 * deactivation is a separate, dangerous operation. One reason field for these actions, checked
 * when an action is attempted; what prevents an action is written next to the buttons.
 */
export function UserActions({ user, isSelf }: { user: AdminUserDetail; isSelf: boolean }) {
  const router = useRouter();
  const ids = useId();
  const reasonRef = useRef<HTMLInputElement>(null);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [attempt, setAttempt] = useState<{ path: string; requestId: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [hint, setHint] = useState<string | null>(null);

  const reasonMissing = () => {
    if (reason.trim().length >= 3) return false;
    setHint(t.accountReasonRequired);
    reasonRef.current?.focus();
    return true;
  };

  async function run(path: string, body: Record<string, unknown>): Promise<unknown> {
    setHint(null);
    setBusy(true);
    setError(null);
    try {
      await apiSend('POST', `admin/identity/users/${user.id}/${path}`, adminUserDetailSchema, {
        ...body,
        reason,
      });
      setReason('');
      router.refresh();
      return null;
    } catch (err) {
      setError(errorText(err));
      return err;
    } finally {
      setBusy(false);
    }
  }

  /**
   * Invitation actions are idempotent per request id. One user attempt keeps its request id —
   * repeating it after a network error or an unanswered provider call continues the same action
   * on the server — until it ends with success or a definite result.
   */
  async function invite(path: string) {
    if (reasonMissing()) return;
    const requestId = attempt?.path === path ? attempt.requestId : crypto.randomUUID();
    setAttempt({ path, requestId });
    const error = await run(path, { requestId });
    const retryable =
      error !== null &&
      (!(error instanceof ClientApiError) ||
        error.code === 'INVITATION_PROVIDER_UNAVAILABLE' ||
        error.code === 'INVITATION_IN_PROGRESS');
    if (!retryable) setAttempt(null);
  }

  const status = (path: 'deactivate' | 'reactivate') => {
    if (!reasonMissing()) void run(path, {});
  };

  return (
    <Card title={t.account}>
      <div className="flex flex-col gap-5" data-testid="user-actions">
        <label className="flex flex-col gap-1">
          <span className={label}>{t.accountReason}</span>
          <input
            ref={reasonRef}
            value={reason}
            onChange={(e) => {
              setReason(e.target.value);
              setHint(null);
            }}
            placeholder={t.reasonPlaceholder}
            aria-describedby={`${ids}-hint`}
            className={inputClass}
          />
        </label>
        {error && <ErrorNote>{error}</ErrorNote>}
        <p
          id={`${ids}-hint`}
          role="status"
          className="text-sm text-stone-600 empty:hidden"
          data-testid="account-hint"
        >
          {hint}
        </p>

        {!user.linked && user.status === 'ACTIVE' && (
          <section className="flex flex-col gap-2" data-testid="invitation-actions">
            <h3 className={label}>{t.invitation}</h3>
            <div className="flex flex-wrap gap-2">
              {(!user.invitation ||
                ['EXPIRED', 'REVOKED', 'FAILED'].includes(user.invitation.state)) && (
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => void invite('invitations/resend')}
                  className={`${buttonClass.secondary} whitespace-nowrap`}
                >
                  {user.invitation ? t.resendInvitation : t.sendInvitation}
                </button>
              )}
              {user.invitation && ['PENDING', 'SENDING'].includes(user.invitation.state) && (
                <>
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => void invite('invitations/resend')}
                    className={`${buttonClass.secondary} whitespace-nowrap`}
                  >
                    {t.resendInvitation}
                  </button>
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => void invite('invitations/revoke')}
                    className={`${buttonClass.danger} whitespace-nowrap`}
                  >
                    {t.revokeInvitation}
                  </button>
                </>
              )}
            </div>
          </section>
        )}

        <section className="flex flex-col gap-2">
          <h3 className={label}>{t.status}</h3>
          {user.status !== 'ACTIVE' ? (
            <button
              type="button"
              disabled={busy}
              onClick={() => status('reactivate')}
              className={`${buttonClass.secondary} self-start whitespace-nowrap`}
            >
              {t.reactivate}
            </button>
          ) : isSelf ? (
            <p className="text-sm text-stone-600">{t.cannotDeactivateSelf}</p>
          ) : (
            <>
              <p className="text-xs text-stone-500">{t.deactivateHelp}</p>
              <button
                type="button"
                disabled={busy}
                onClick={() => status('deactivate')}
                className={`${buttonClass.danger} self-start whitespace-nowrap`}
              >
                {t.deactivate}
              </button>
            </>
          )}
        </section>
      </div>
    </Card>
  );
}
