'use client';

import {
  productLabelApprovalSchema,
  type LabelTemplateVersionRef,
  type ProductLabelApproval,
} from '@ayvo/types';
import { useRouter } from 'next/navigation';
import { useId, useState } from 'react';
import { buttonClass, Card, EmptyState, inputClass } from '@/components/ui';
import { formatDateTimeCs } from '@/i18n/cs/format';
import { labelingCs } from '@/i18n/cs/labeling';
import { ClientApiError, apiSend } from '@/lib/client-api';
import {
  catalogErrorText,
  ConfirmDialog,
  ReasonField,
  reasonError,
  SuccessNote,
  useAttempt,
} from './form-kit';

const t = labelingCs.approvals;

function errorText(error: unknown): string {
  if (error instanceof ClientApiError && error.code && t.errors[error.code]) {
    return t.errors[error.code]!;
  }
  return catalogErrorText(error);
}

/**
 * Schválené designy etiket of a product (owner B1): an exact label template version approved for
 * this product only; revoking stops new labelling, history stays. Approve/revoke need
 * catalog:product_manage (the API enforces it); `candidates` are the latest versions of the
 * active templates the user may read.
 */
export function ProductLabelApprovals({
  productCode,
  approvals,
  candidates,
  canManage,
  timeZone,
}: {
  productCode: string;
  approvals: ProductLabelApproval[];
  candidates: LabelTemplateVersionRef[];
  canManage: boolean;
  timeZone: string;
}) {
  const router = useRouter();
  const id = useId();
  const [design, setDesign] = useState('');
  const [reason, setReason] = useState('');
  const [reasonErr, setReasonErr] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const [revoking, setRevoking] = useState<ProductLabelApproval | null>(null);
  const [revokeReason, setRevokeReason] = useState('');
  const [revokeErr, setRevokeErr] = useState<string | null>(null);
  const { busy, run } = useAttempt();
  const base = `admin/catalog/products/${encodeURIComponent(productCode)}/label-approvals`;
  const open = approvals.filter((a) => !a.revokedAt).map((a) => a.design.versionId);

  async function approve(e: React.FormEvent) {
    e.preventDefault();
    const r = reasonError(reason);
    setReasonErr(r);
    setDone(false);
    if (r || !design) return;
    const body = { labelTemplateVersionId: design, reason: reason.trim() };
    const result = await run(`approve:${JSON.stringify(body)}`, (requestId) =>
      apiSend('POST', base, productLabelApprovalSchema, { requestId, ...body }),
    );
    if (result.ok) {
      setDesign('');
      setReason('');
      setError(null);
      setDone(true);
      router.refresh();
    } else if (result.error) setError(errorText(result.error));
  }

  async function revoke() {
    const r = reasonError(revokeReason);
    setRevokeErr(r);
    if (r || !revoking) return;
    const body = { reason: revokeReason.trim() };
    const result = await run(`revoke:${revoking.id}:${body.reason}`, (requestId) =>
      apiSend('POST', `${base}/${revoking.id}/revoke`, productLabelApprovalSchema, {
        requestId,
        ...body,
      }),
    );
    setRevoking(null);
    if (result.ok) {
      setError(null);
      router.refresh();
    } else if (result.error) setError(errorText(result.error));
  }

  return (
    <Card title={t.title} testId="label-approvals" id="designs" className="scroll-mt-24">
      <div className="flex flex-col gap-4">
        <p className="text-xs text-stone-500">{t.help}</p>
        {approvals.length === 0 ? (
          <EmptyState>{t.empty}</EmptyState>
        ) : (
          <ul className="flex flex-col divide-y divide-stone-100 text-sm">
            {approvals.map((a) => (
              <li key={a.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
                <span className="min-w-0">
                  <span className={a.revokedAt ? 'text-stone-500 line-through' : 'font-medium'}>
                    {a.design.label}
                  </span>
                  <span className="block text-xs text-stone-500">
                    {t.approvedBy(a.approvedBy, formatDateTimeCs(a.approvedAt, timeZone))}
                    {a.revokedAt &&
                      ` · ${t.revokedBy(a.revokedBy!, formatDateTimeCs(a.revokedAt, timeZone))}`}
                  </span>
                </span>
                {canManage && !a.revokedAt && (
                  <button
                    type="button"
                    className={buttonClass.danger}
                    onClick={() => {
                      setRevokeReason('');
                      setRevokeErr(null);
                      setRevoking(a);
                    }}
                  >
                    {t.revoke}
                  </button>
                )}
              </li>
            ))}
          </ul>
        )}
        {canManage && candidates.length > 0 && (
          <form
            noValidate
            onSubmit={approve}
            className="flex flex-col gap-3"
            data-testid="approve-design"
          >
            <label className="flex flex-col gap-1 text-sm" htmlFor={`${id}-design`}>
              {t.design}
              <select
                id={`${id}-design`}
                value={design}
                onChange={(e) => setDesign(e.target.value)}
                className={inputClass}
              >
                <option value="">{labelingCs.context.choose}</option>
                {candidates
                  .filter((c) => !open.includes(c.versionId))
                  .map((c) => (
                    <option key={c.versionId} value={c.versionId}>
                      {c.label}
                    </option>
                  ))}
              </select>
            </label>
            <ReasonField
              id={`${id}-reason`}
              value={reason}
              onChange={setReason}
              error={reasonErr}
              label={t.reason}
            />
            <div>
              <button type="submit" disabled={busy || !design} className={buttonClass.primary}>
                {t.approve}
              </button>
            </div>
          </form>
        )}
        {done && <SuccessNote>{t.approved}</SuccessNote>}
        {error && (
          <p role="alert" className="text-sm text-red-800">
            {error}
          </p>
        )}
      </div>
      <ConfirmDialog
        open={revoking !== null}
        title={revoking ? t.revokeTitle(revoking.design.label) : ''}
        confirmLabel={t.revoke}
        danger
        busy={busy}
        onConfirm={() => void revoke()}
        onCancel={() => setRevoking(null)}
        testId="revoke-design"
      >
        <p>{t.revokeText}</p>
        <ReasonField
          id={`${id}-revoke`}
          value={revokeReason}
          onChange={setRevokeReason}
          error={revokeErr}
          label={t.reason}
        />
      </ConfirmDialog>
    </Card>
  );
}
