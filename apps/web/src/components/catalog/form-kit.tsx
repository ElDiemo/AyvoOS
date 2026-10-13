'use client';

import { cn } from '@ayvo/ui';
import { useEffect, useRef, useState } from 'react';
import { buttonClass, inputClass } from '@/components/ui';
import { catalogCs } from '@/i18n/cs/catalog';
import { attemptId } from '@/lib/catalog-forms';
import { ClientApiError } from '@/lib/client-api';

const t = catalogCs.common;
export const labelClass = 'text-xs font-medium uppercase tracking-wide text-stone-500';

/** Czech text of an API error: the stable code first, never raw server details. */
export function catalogErrorText(error: unknown): string {
  if (error instanceof ClientApiError) {
    if (error.code && catalogCs.errors[error.code]) return catalogCs.errors[error.code]!;
    if (error.status === 403) return catalogCs.errors.FORBIDDEN!;
    // Never raw server text (Zod paths, English messages) in the Czech UI.
    if (error.status === 400 || error.status === 422) return t.invalidData;
    if (error.status === 404) return t.notFound;
    if (uncertain(error)) return t.networkRetry;
    return t.failed;
  }
  return t.networkRetry;
}

/**
 * No definite answer: a network error, or a 5xx (e.g. a gateway timeout after the commit). The
 * attempt keeps its request id, so a retry continues the same operation instead of repeating it.
 */
export function uncertain(error: unknown): boolean {
  return !(error instanceof ClientApiError) || error.status >= 500;
}

/** A labelled input with help text and an inline error (aria-invalid + aria-describedby). */
export function FormField({
  id,
  label,
  help,
  error,
  children,
}: {
  id: string;
  label: string;
  help?: string;
  error?: string | null;
  children: React.ReactNode;
}) {
  return (
    <div className="flex min-w-0 flex-col gap-1">
      <label htmlFor={id} className={labelClass}>
        {label}
      </label>
      {children}
      {help && (
        <p id={`${id}-help`} className="text-xs text-stone-500">
          {help}
        </p>
      )}
      {error && (
        <p id={`${id}-error`} className="text-xs font-medium text-red-700" data-field-error>
          {error}
        </p>
      )}
    </div>
  );
}

export const describedBy = (id: string, help: boolean, error: boolean) =>
  [help && `${id}-help`, error && `${id}-error`].filter(Boolean).join(' ') || undefined;

export function fieldClass(error: boolean) {
  return cn(inputClass, error && 'border-red-500 focus:border-red-600 focus:ring-red-100');
}

/** Summary of the field errors; focus moves to the first invalid field. */
export function ErrorSummary({
  errors,
  formError,
}: {
  errors: Record<string, string | null | undefined>;
  formError?: string | null;
}) {
  const list = Object.values(errors).filter(Boolean) as string[];
  if (!list.length && !formError) return null;
  return (
    <div
      role="alert"
      className="rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-900"
      data-testid="form-errors"
    >
      {list.length > 0 && <p className="font-medium">{t.fixErrors(list.length)}</p>}
      {formError && <p className="wrap-anywhere">{formError}</p>}
    </div>
  );
}

export function focusFirstError(form: HTMLElement | null) {
  const first = form?.querySelector<HTMLElement>('[aria-invalid="true"]');
  first?.focus();
}

/**
 * Moves focus to the first invalid field right after the errors are rendered — in an effect, not
 * in a requestAnimationFrame callback, which a browser may run much later (e.g. while the user is
 * already typing in another field, so the text would land in the wrong field).
 */
export function useFocusFirstError(form: React.RefObject<HTMLFormElement | null>) {
  const [request, setRequest] = useState(0);
  useEffect(() => {
    if (request > 0) focusFirstError(form.current);
  }, [request, form]);
  return () => setRequest((n) => n + 1);
}

/** The mandatory reason of every catalogue change (audited on the server). */
export function ReasonField({
  id,
  value,
  onChange,
  error,
  label = t.reason,
}: {
  id: string;
  value: string;
  onChange: (v: string) => void;
  error?: string | null;
  label?: string;
}) {
  return (
    <FormField id={id} label={label} error={error}>
      <input
        id={id}
        value={value}
        maxLength={500}
        onChange={(e) => onChange(e.target.value)}
        placeholder={t.reasonPlaceholder}
        aria-invalid={!!error}
        aria-describedby={describedBy(id, false, !!error)}
        className={fieldClass(!!error)}
      />
    </FormField>
  );
}

export const reasonError = (reason: string) =>
  reason.trim().length >= 3 ? null : t.reasonRequired;

/**
 * One user attempt = one request id (issue #17): kept while the request is unchanged and the last
 * try ended without a definite answer (network error) — a retry or double click continues the
 * same server operation; a definite answer or changed data starts a new attempt.
 */
export function useAttempt() {
  const attempt = useRef<{ key: string; id: string } | null>(null);
  const [busy, setBusy] = useState(false);
  async function run<R>(
    key: string,
    send: (requestId: string) => Promise<R>,
  ): Promise<{ ok: true; value: R } | { ok: false; error: unknown }> {
    if (busy) return { ok: false, error: null };
    attempt.current = attemptId(attempt.current, key, () => crypto.randomUUID());
    setBusy(true);
    try {
      const value = await send(attempt.current.id);
      attempt.current = null;
      return { ok: true, value };
    } catch (error) {
      if (!uncertain(error)) attempt.current = null; // definite answer
      return { ok: false, error };
    } finally {
      setBusy(false);
    }
  }
  return { busy, run };
}

/** A modal confirmation (native <dialog>: focus trap, Escape closes). */
export function ConfirmDialog({
  open,
  title,
  children,
  confirmLabel,
  danger = false,
  busy = false,
  onConfirm,
  onCancel,
  testId,
}: {
  open: boolean;
  title: string;
  children: React.ReactNode;
  confirmLabel: string;
  danger?: boolean;
  busy?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
  testId?: string;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) d.showModal();
    if (!open && d.open) d.close();
  }, [open]);
  return (
    <dialog
      ref={ref}
      aria-labelledby={testId ? `${testId}-title` : undefined}
      data-testid={testId}
      className="m-auto w-[min(32rem,calc(100vw-2rem))] rounded-lg p-5 shadow-xl backdrop:bg-stone-900/40"
      onCancel={(e) => {
        e.preventDefault();
        onCancel();
      }}
    >
      <h2 id={testId ? `${testId}-title` : undefined} className="text-base font-semibold">
        {title}
      </h2>
      <div className="mt-3 flex flex-col gap-3 text-sm text-stone-700">{children}</div>
      <div className="mt-5 flex flex-wrap justify-end gap-2">
        <button type="button" className={buttonClass.secondary} onClick={onCancel} disabled={busy}>
          {t.cancel}
        </button>
        <button
          type="button"
          className={danger ? buttonClass.danger : buttonClass.primary}
          onClick={onConfirm}
          disabled={busy}
        >
          {busy ? t.saving : confirmLabel}
        </button>
      </div>
    </dialog>
  );
}

/** A polite success message (screen readers announce it). */
export function SuccessNote({ children }: { children: React.ReactNode }) {
  return (
    <p
      role="status"
      className="rounded-md bg-emerald-50 px-3 py-2 text-sm text-emerald-900"
      data-testid="success"
    >
      {children}
    </p>
  );
}
