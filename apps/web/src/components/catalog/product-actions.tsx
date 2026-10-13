'use client';

import { productSchema, recipeVersionSchema, type Product } from '@ayvo/types';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useId, useState } from 'react';
import { buttonClass, Card } from '@/components/ui';
import { catalogCs } from '@/i18n/cs/catalog';
import { apiSend, ClientApiError } from '@/lib/client-api';
import {
  catalogErrorText,
  ConfirmDialog,
  describedBy,
  ErrorSummary,
  fieldClass,
  FormField,
  ReasonField,
  reasonError,
  SuccessNote,
  useAttempt,
} from './form-kit';

const t = catalogCs.products;
const c = catalogCs.common;

/** Oprava názvu (existing API; code, category and history unchanged). */
export function RenameProduct({ product }: { product: Product }) {
  const router = useRouter();
  const id = useId();
  const [name, setName] = useState(product.name);
  const [reason, setReason] = useState('');
  const [errors, setErrors] = useState<Record<string, string | null>>({});
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const { busy, run } = useAttempt();

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    const next = { name: name.trim() ? null : c.required, reason: reasonError(reason) };
    setErrors(next);
    setError(null);
    setDone(false);
    if (Object.values(next).some(Boolean)) return;
    const body = { name: name.trim(), reason: reason.trim() };
    const result = await run(JSON.stringify(body), (requestId) =>
      apiSend(
        'POST',
        `admin/catalog/products/${encodeURIComponent(product.code)}/rename`,
        productSchema,
        {
          requestId,
          ...body,
        },
      ),
    );
    if (result.ok) {
      setReason('');
      setDone(true);
      router.refresh();
    } else if (result.error) setError(catalogErrorText(result.error));
  }

  return (
    <Card title={t.renameTitle}>
      <form
        noValidate
        onSubmit={submit}
        className="flex flex-col gap-4"
        data-testid="rename-product"
      >
        <p className="text-xs text-stone-500">{t.renameHelp}</p>
        <FormField id={`${id}-name`} label={c.name} error={errors.name}>
          <input
            id={`${id}-name`}
            value={name}
            maxLength={200}
            onChange={(e) => setName(e.target.value)}
            aria-invalid={!!errors.name}
            aria-describedby={describedBy(`${id}-name`, false, !!errors.name)}
            className={fieldClass(!!errors.name)}
          />
        </FormField>
        <ReasonField
          id={`${id}-reason`}
          value={reason}
          onChange={setReason}
          error={errors.reason}
        />
        <ErrorSummary errors={errors} formError={error} />
        {done && <SuccessNote>{t.renamed}</SuccessNote>}
        <div>
          <button type="submit" disabled={busy} className={buttonClass.secondary}>
            {busy ? c.saving : t.rename}
          </button>
        </div>
      </form>
    </Card>
  );
}

/** Archivace produktu: explained refusal while a recipe version is active (never automatic). */
export function ArchiveProduct({ product }: { product: Product }) {
  const router = useRouter();
  const id = useId();
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState('');
  const [reasonErr, setReasonErr] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [blockedBy, setBlockedBy] = useState<number | null>(null);
  const { busy, run } = useAttempt();

  async function confirm() {
    const r = reasonError(reason);
    setReasonErr(r);
    if (r) return;
    const body = { reason: reason.trim() };
    const result = await run(JSON.stringify(body), (requestId) =>
      apiSend(
        'POST',
        `admin/catalog/products/${encodeURIComponent(product.code)}/archive`,
        productSchema,
        {
          requestId,
          ...body,
        },
      ),
    );
    if (result.ok) {
      setOpen(false);
      router.refresh();
    } else if (result.error) {
      setOpen(false);
      if (
        result.error instanceof ClientApiError &&
        result.error.code === 'PRODUCT_HAS_ACTIVE_RECIPE'
      ) {
        // Always say so — the page may predate the activation (then without a version link).
        setBlockedBy(product.activeVersion ?? 0);
        setError(null);
        router.refresh();
      } else setError(catalogErrorText(result.error));
    }
  }

  return (
    <div className="flex flex-col gap-2" data-testid="archive-product">
      <button
        type="button"
        className={`${buttonClass.danger} self-start`}
        onClick={() => {
          setReason('');
          setReasonErr(null);
          setOpen(true);
        }}
      >
        {t.archive}
      </button>
      {blockedBy !== null && (
        <p role="alert" className="text-sm text-amber-900" data-testid="archive-blocked">
          {blockedBy > 0 ? t.hasActive(blockedBy) : t.hasActiveUnknown}{' '}
          {blockedBy > 0 && (
            <Link
              className="underline"
              href={`/production/catalog/products/${encodeURIComponent(product.code)}/recipes/${blockedBy}`}
            >
              {t.openActive}
            </Link>
          )}
        </p>
      )}
      {error && (
        <p role="alert" className="text-sm text-red-800">
          {error}
        </p>
      )}
      <ConfirmDialog
        open={open}
        title={t.archiveTitle}
        confirmLabel={t.archiveConfirm}
        danger
        busy={busy}
        onConfirm={() => void confirm()}
        onCancel={() => setOpen(false)}
        testId="archive-product-dialog"
      >
        <p>{t.archiveText(product.name)}</p>
        <ReasonField id={`${id}-reason`} value={reason} onChange={setReason} error={reasonErr} />
      </ConfirmDialog>
    </div>
  );
}

/** Nový prázdný koncept, or "Nová verze z této" (copy of `basedOn`). */
export function NewDraftButton({
  productCode,
  basedOn,
  label,
  title,
  help,
  disabled = false,
}: {
  productCode: string;
  basedOn: number | null;
  label: string;
  title: string;
  help: string;
  /** e.g. while the draft on screen has unsaved changes (the copy would not include them). */
  disabled?: boolean;
}) {
  const router = useRouter();
  const id = useId();
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState('');
  const [reasonErr, setReasonErr] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const { busy, run } = useAttempt();

  async function confirm() {
    const r = reasonError(reason);
    setReasonErr(r);
    if (r) return;
    const body =
      basedOn === null
        ? { reason: reason.trim(), crateTypeCode: null, components: [] }
        : { reason: reason.trim(), basedOnVersion: basedOn };
    const result = await run(JSON.stringify(body), (requestId) =>
      apiSend(
        'POST',
        `admin/catalog/products/${encodeURIComponent(productCode)}/recipes`,
        recipeVersionSchema,
        {
          requestId,
          ...body,
        },
      ),
    );
    if (result.ok) {
      setOpen(false);
      setReason('');
      router.push(
        `/production/catalog/products/${encodeURIComponent(productCode)}/recipes/${result.value.version}`,
      );
    } else if (result.error) {
      setOpen(false);
      setError(catalogErrorText(result.error));
    }
  }

  return (
    <div className="flex flex-col gap-2">
      <button
        type="button"
        className={`${buttonClass.secondary} self-start`}
        disabled={disabled}
        onClick={() => {
          setReason('');
          setReasonErr(null);
          setOpen(true);
        }}
      >
        {label}
      </button>
      {error && (
        <p role="alert" className="text-sm text-red-800">
          {error}
        </p>
      )}
      <ConfirmDialog
        open={open}
        title={title}
        confirmLabel={t.create}
        busy={busy}
        onConfirm={() => void confirm()}
        onCancel={() => setOpen(false)}
        testId="new-draft-dialog"
      >
        <p>{help}</p>
        <ReasonField id={`${id}-reason`} value={reason} onChange={setReason} error={reasonErr} />
      </ConfirmDialog>
    </div>
  );
}
