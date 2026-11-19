'use client';

import { commissionStatementSchema, type CommissionMode } from '@ayvo/types';
import { useRouter } from 'next/navigation';
import { useRef, useState } from 'react';
import { ConfirmDialog, uncertain, useAttempt } from '@/components/catalog/form-kit';
import { buttonClass, ErrorNote } from '@/components/ui';
import { commissionsCs } from '@/i18n/cs/commissions';
import { apiSend, ClientApiError } from '@/lib/client-api';
import { approvalOutcome, refusalText } from './commission-closing-format';

const t = commissionsCs.closing;

/**
 * Approves one salesperson's statement exactly as previewed (doc 069 §5d): the preview's
 * fingerprint travels with the request, so any change of the sources in between is refused
 * (STATEMENT_STALE) and nothing is written. One request id per attempt: after a lost answer the
 * same button repeats the same request and gets the stored result.
 */
export function CommissionApprove({
  month,
  monthLabel,
  mode,
  salesperson,
  currency,
  fingerprint,
  amountLabel,
  blocked,
}: {
  month: string;
  monthLabel: string;
  mode: CommissionMode;
  salesperson: { id: string; name: string };
  currency: string;
  fingerprint: string;
  amountLabel: string;
  blocked: boolean;
}) {
  const router = useRouter();
  const { busy, run } = useAttempt();
  const [open, setOpen] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  // An attempt ended without an answer: it may have been approved. Until a definite answer
  // arrives, no message may claim that nothing was approved.
  const earlierUncertain = useRef(false);
  const testId = `approve-${salesperson.id}`;

  async function approve() {
    setFailure(null);
    const body = {
      month,
      salespersonId: salesperson.id,
      currency: 'CZK' as const,
      mode,
      fingerprint,
    };
    const result = await run(JSON.stringify(body), (requestId) =>
      apiSend('POST', 'admin/finance/commissions/statements', commissionStatementSchema, {
        requestId,
        ...body,
      }),
    );
    setOpen(false);
    if (result.ok) {
      earlierUncertain.current = false;
      router.refresh();
      return;
    }
    if (!result.error) return;
    const err = result.error;
    const code = err instanceof ClientApiError ? err.code : null;
    const outcome = approvalOutcome(code, uncertain(err), earlierUncertain.current);
    if (outcome.kind === 'uncertain') earlierUncertain.current = true;
    if (outcome.kind === 'refused') earlierUncertain.current = false;
    setFailure(
      outcome.kind === 'dependencyNothingWritten'
        ? t.errors.FINANCE_DEPENDENCY_UNAVAILABLE
        : outcome.kind === 'dependencyAfterUncertain'
          ? t.errors.dependencyAfterUncertain
          : outcome.kind === 'uncertain'
            ? t.errors.uncertain
            : refusalText(t.errors, outcome.code, t.errors.failed),
    );
  }

  if (currency !== 'CZK') return null;
  return (
    <div className="flex flex-col gap-2">
      {blocked ? (
        <p className="text-sm text-amber-900" data-testid={`${testId}-blocked`}>
          {t.blocked}
        </p>
      ) : (
        <div>
          <button
            type="button"
            className={buttonClass.primary}
            onClick={() => setOpen(true)}
            disabled={busy}
            data-testid={testId}
          >
            {t.approve}
          </button>
        </div>
      )}
      {failure && <ErrorNote>{failure}</ErrorNote>}
      <ConfirmDialog
        open={open}
        title={t.approveTitle(salesperson.name, monthLabel)}
        confirmLabel={t.approveConfirm}
        busy={busy}
        onConfirm={approve}
        onCancel={() => setOpen(false)}
        testId={`${testId}-dialog`}
      >
        <p>{t.approveBody(amountLabel)}</p>
      </ConfirmDialog>
    </div>
  );
}
