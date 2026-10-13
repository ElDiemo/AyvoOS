'use client';

import { recipeVersionSchema, type RecipeVersion } from '@ayvo/types';
import { useRouter } from 'next/navigation';
import { useId, useState } from 'react';
import { buttonClass } from '@/components/ui';
import { catalogCs } from '@/i18n/cs/catalog';
import { apiSend, ClientApiError } from '@/lib/client-api';
import {
  catalogErrorText,
  ConfirmDialog,
  ReasonField,
  reasonError,
  SuccessNote,
  useAttempt,
} from './form-kit';
import { NewDraftButton } from './product-actions';

const t = catalogCs.recipe;

/**
 * Lifecycle of one recipe version: "Nová verze z této", "Aktivovat" (complete, saved drafts;
 * confirms which active version it replaces and sends that as expectedActiveVersion), "Archivovat".
 * ACTIVE_VERSION_CHANGED is explained — never retried with a new expectation.
 */
export function RecipeActions({
  recipe,
  activeVersion,
  canManage,
  canApprove,
  productActive,
  dirty,
}: {
  recipe: RecipeVersion;
  /** The product's active version when this page was loaded (the expectation sent on activation). */
  activeVersion: number | null;
  canManage: boolean;
  canApprove: boolean;
  productActive: boolean;
  dirty: boolean;
}) {
  const router = useRouter();
  const id = useId();
  const [dialog, setDialog] = useState<'activate' | 'archive' | null>(null);
  const [reason, setReason] = useState('');
  const [reasonErr, setReasonErr] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [changed, setChanged] = useState(false);
  const [done, setDone] = useState<string | null>(null);
  const { busy, run } = useAttempt();
  const base = `admin/catalog/products/${encodeURIComponent(recipe.product.code)}/recipes/${recipe.version}`;
  const isDraft = recipe.status === 'DRAFT';
  const complete = recipe.missing.length === 0;

  async function confirm() {
    const r = reasonError(reason);
    setReasonErr(r);
    if (r || !dialog) return;
    const body =
      dialog === 'activate'
        ? { reason: reason.trim(), expectedActiveVersion: activeVersion }
        : { reason: reason.trim() };
    const action = dialog;
    const result = await run(`${action}:${JSON.stringify(body)}`, (requestId) =>
      apiSend('POST', `${base}/${action}`, recipeVersionSchema, { requestId, ...body }),
    );
    setDialog(null);
    if (result.ok) {
      setReason('');
      setError(null);
      setDone(action === 'activate' ? t.activated : t.archived);
      router.refresh();
    } else if (result.error) {
      if (
        result.error instanceof ClientApiError &&
        result.error.code === 'ACTIVE_VERSION_CHANGED'
      ) {
        setChanged(true);
        setError(null);
      } else setError(catalogErrorText(result.error));
    }
  }

  const activateBlocked = !isDraft
    ? null
    : dirty
      ? t.unsavedFirst
      : !complete
        ? t.activateDisabled
        : null;
  return (
    <div className="flex flex-col gap-3" data-testid="recipe-actions">
      <div className="flex flex-wrap items-start gap-2">
        {canApprove && productActive && isDraft && (
          <button
            type="button"
            className={buttonClass.primary}
            disabled={!!activateBlocked}
            aria-describedby={activateBlocked ? `${id}-blocked` : undefined}
            onClick={() => {
              setChanged(false);
              setDialog('activate');
            }}
          >
            {t.activate}
          </button>
        )}
        {canManage && productActive && (
          <NewDraftButton
            productCode={recipe.product.code}
            basedOn={recipe.version}
            label={t.copy}
            title={t.copyTitle}
            help={t.copyHelp(recipe.version)}
          />
        )}
        {canApprove && recipe.status !== 'ARCHIVED' && (
          <button type="button" className={buttonClass.danger} onClick={() => setDialog('archive')}>
            {t.archive}
          </button>
        )}
      </div>
      {activateBlocked && canApprove && productActive && (
        <p id={`${id}-blocked`} className="text-sm text-stone-600" data-testid="activate-blocked">
          {activateBlocked}
        </p>
      )}
      {changed && (
        <div
          role="alert"
          className="flex flex-col gap-2 rounded-md border border-amber-300 bg-amber-50 p-3 text-sm text-amber-950"
          data-testid="active-changed"
        >
          <p className="font-medium">{t.changedTitle}</p>
          <p>{t.changedText}</p>
          <button
            type="button"
            className={`${buttonClass.secondary} self-start`}
            onClick={() => {
              setChanged(false);
              router.refresh();
            }}
          >
            {t.reload}
          </button>
        </div>
      )}
      {error && (
        <p role="alert" className="text-sm text-red-800">
          {error}
        </p>
      )}
      {done && <SuccessNote>{done}</SuccessNote>}
      <ConfirmDialog
        open={dialog !== null}
        title={dialog === 'activate' ? t.activateTitle : t.archiveTitle}
        confirmLabel={dialog === 'activate' ? t.activate : t.archive}
        danger={dialog === 'archive'}
        busy={busy}
        onConfirm={() => void confirm()}
        onCancel={() => setDialog(null)}
        testId="recipe-dialog"
      >
        <p data-testid="recipe-dialog-text">
          {dialog === 'activate'
            ? t.activateText(recipe.product.name, recipe.version, activeVersion)
            : t.archiveText(recipe.version, recipe.status === 'ACTIVE')}
        </p>
        <ReasonField id={`${id}-reason`} value={reason} onChange={setReason} error={reasonErr} />
      </ConfirmDialog>
    </div>
  );
}
