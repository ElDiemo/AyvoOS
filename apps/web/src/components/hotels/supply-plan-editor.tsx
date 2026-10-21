'use client';

import {
  savedSupplyPreviewSchema,
  supplyPlanResponseSchema,
  supplyPreviewSchema,
  type OrderableProduct,
  type SupplyPlan,
  type SupplyPreview,
} from '@ayvo/types';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useCallback, useId, useState } from 'react';
import {
  ConfirmDialog,
  ErrorSummary,
  fieldClass,
  FormField,
  reasonError,
  ReasonField,
  useAttempt,
} from '@/components/catalog/form-kit';
import { OriginBadge } from '@/components/dispatch/order-origin';
import { orderErrorText } from '@/components/dispatch/order-errors';
import { buttonClass, Card, EmptyState, Notice } from '@/components/ui';
import { formatDateCs } from '@/i18n/cs/format';
import { ordersCs } from '@/i18n/cs/orders';
import { supplyPlansCs as t } from '@/i18n/cs/supply-plans';
import { apiGet, apiSend, ClientApiError } from '@/lib/client-api';
import { PlanStatusBadge } from './supply-plan-summary';

type Rule = { key: number; productCode: string; crates: string; days: number[] };
const DAYS = Array.from({ length: 31 }, (_, i) => i + 1);

/**
 * Plán zásobování of one hotel (doc 032): rules (product, whole crates, days 1–31), validity, a
 * real preview of the next 30 days (writes nothing), saving a new version with a reason,
 * switching on with an explicit confirmation, pausing — and the orders already created from it,
 * which none of this changes.
 */
export function SupplyPlanEditor({
  hotel,
  plan,
  products,
  today,
  canManage,
}: {
  hotel: string;
  plan: SupplyPlan | null;
  products: OrderableProduct[];
  today: string;
  canManage: boolean;
}) {
  const router = useRouter();
  const id = useId();
  // Orderable products, plus those of saved rules that are no longer orderable (e.g. their recipe
  // ended): kept visible so their blocker shows, never silently dropped.
  const options = [
    ...products.map((p) => ({ code: p.code, name: p.name })),
    ...(plan?.rules ?? [])
      .filter((r) => !products.some((p) => p.code === r.productCode))
      .map((r) => ({ code: r.productCode, name: r.productName })),
  ].filter((o, i, all) => all.findIndex((x) => x.code === o.code) === i);
  const [validFrom, setValidFrom] = useState(plan?.validFrom ?? today);
  const [validTo, setValidTo] = useState(plan?.validTo ?? '');
  const [rules, setRules] = useState<Rule[]>(
    plan && plan.rules.length > 0
      ? plan.rules.map((r, i) => ({
          key: i,
          productCode: r.productCode,
          crates: String(r.crates),
          days: r.days,
        }))
      : [{ key: 0, productCode: '', crates: '1', days: [] }],
  );
  const [errors, setErrors] = useState<Record<string, string | null>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [preview, setPreview] = useState<SupplyPreview | null>(null);
  /** The form content the shown preview was computed from (a later edit makes it stale). */
  const [previewOf, setPreviewOf] = useState<string | null>(null);
  /** What switching on confirms: the SAVED plan's version and its preview (PLAN40-R1/R2). */
  const [confirming, setConfirming] = useState<{ version: number; preview: SupplyPreview } | null>(
    null,
  );
  const [activateError, setActivateError] = useState<string | null>(null);
  const [dialog, setDialog] = useState<'save' | 'activate' | 'pause' | null>(null);
  const [reason, setReason] = useState('');
  const [reasonErr, setReasonErr] = useState<string | null>(null);
  const [checked, setChecked] = useState(false);
  const previewing = useAttempt();
  const sending = useAttempt();

  const body = useCallback(
    () => ({
      validFrom,
      validTo: validTo || null,
      rules: rules.map((r) => ({
        productCode: r.productCode,
        crates: Number(r.crates),
        days: r.days,
      })),
    }),
    [validFrom, validTo, rules],
  );

  /** The saved plan in the form's shape; the form differs from it → unsaved changes. */
  const savedBody = plan
    ? JSON.stringify({
        validFrom: plan.validFrom,
        validTo: plan.validTo,
        rules: plan.rules.map((r) => ({
          productCode: r.productCode,
          crates: r.crates,
          days: r.days,
        })),
      })
    : null;
  const current = JSON.stringify(body());
  const unsaved = savedBody !== null && current !== savedBody;
  const stale = preview !== null && previewOf !== current;

  function validate(): boolean {
    const next: Record<string, string | null> = {
      validFrom: validFrom ? null : t.form.required,
      validTo: validTo && validTo < validFrom ? t.form.validToBefore : null,
    };
    rules.forEach((r) => {
      next[`product-${r.key}`] = r.productCode ? null : t.form.required;
      next[`crates-${r.key}`] =
        /^\d{1,3}$/.test(r.crates) && Number(r.crates) >= 1 ? null : t.form.cratesInvalid;
      next[`days-${r.key}`] = r.days.length > 0 ? null : t.form.daysRequired;
    });
    setErrors(next);
    return !Object.values(next).some(Boolean);
  }

  async function showPreview() {
    if (!validate()) return;
    setFormError(null);
    const b = body();
    const result = await previewing.run(JSON.stringify(b), () =>
      apiSend('POST', `admin/orders/hotel/${hotel}/supply-plan/preview`, supplyPreviewSchema, b),
    );
    if (result.ok) {
      setPreview(result.value);
      setPreviewOf(JSON.stringify(b));
    } else if (result.error) setFormError(orderErrorText(result.error));
  }

  /**
   * Switching on confirms the SAVED plan only (doc 032 §2, PLAN40-R1): with unsaved changes it is
   * refused until they are saved with a reason (never saved or discarded silently); the dialog
   * opens only after the saved plan's preview loaded, and carries its version (PLAN40-R2).
   */
  async function askActivate() {
    setActivateError(null);
    setConfirming(null);
    if (unsaved) {
      setActivateError(t.activateUnsaved);
      return;
    }
    const result = await previewing.run(`saved-${savedBody}`, () =>
      apiGet(`admin/orders/hotel/${hotel}/supply-plan/preview`, savedSupplyPreviewSchema),
    );
    if (!result.ok) {
      setActivateError(result.error ? orderErrorText(result.error) : t.activatePreviewFailed);
      return;
    }
    setConfirming(result.value);
    setPreview(result.value.preview);
    setPreviewOf(savedBody);
    setChecked(false);
    setReasonErr(null);
    setDialog('activate');
  }

  async function send() {
    if (dialog !== 'activate') {
      const invalid = reasonError(reason);
      setReasonErr(invalid);
      if (invalid) return;
    } else if (!checked || !confirming) return;
    const path = dialog === 'save' ? '' : dialog === 'activate' ? '/activate' : '/pause';
    const payload =
      dialog === 'save'
        ? { ...body(), reason: reason.trim() }
        : dialog === 'activate'
          ? { confirm: true as const, version: confirming!.version }
          : { reason: reason.trim() };
    const result = await sending.run(JSON.stringify({ path, payload }), (requestId) =>
      apiSend('POST', `admin/orders/hotel/${hotel}/supply-plan${path}`, supplyPlanResponseSchema, {
        requestId,
        ...payload,
      }),
    );
    if (result.ok) {
      setDialog(null);
      setReason('');
      setChecked(false);
      setConfirming(null);
      router.refresh();
    } else if (result.error) {
      setReasonErr(orderErrorText(result.error));
      // Changed by someone else meanwhile: this confirmation is void; a new preview is needed.
      if (
        result.error instanceof ClientApiError &&
        result.error.code === 'SUPPLY_PLAN_VERSION_CHANGED'
      ) {
        setConfirming(null);
        router.refresh();
      }
    }
  }

  const setRule = (key: number, patch: Partial<Rule>) => {
    setActivateError(null);
    setRules(rules.map((r) => (r.key === key ? { ...r, ...patch } : r)));
  };
  const productName = (code: string) => options.find((p) => p.code === code)?.name ?? code;
  const ordersCount = plan?.orders.length ?? 0;

  return (
    <div className="flex flex-col gap-6">
      {plan && (
        <Card title={t.title} testId="plan-state">
          <div className="flex flex-col gap-3 text-sm">
            <p className="flex flex-wrap items-center gap-2">
              <PlanStatusBadge status={plan.status} />
              <span className="text-stone-600">{t.statusHelp[plan.status]}</span>
            </p>
            {canManage && (
              <div className="flex flex-wrap gap-2">
                {plan.status !== 'ACTIVE' ? (
                  <button
                    type="button"
                    className={buttonClass.primary}
                    onClick={() => void askActivate()}
                    disabled={previewing.busy}
                    data-testid="plan-activate"
                  >
                    {plan.status === 'PAUSED' ? t.resume : t.activate}
                  </button>
                ) : (
                  <button
                    type="button"
                    className={buttonClass.secondary}
                    onClick={() => setDialog('pause')}
                    data-testid="plan-pause"
                  >
                    {t.pause}
                  </button>
                )}
              </div>
            )}
            {canManage && plan.status !== 'ACTIVE' && unsaved && !activateError && (
              <p className="text-xs text-amber-900" data-testid="plan-unsaved">
                {t.unsavedHint}
              </p>
            )}
            {activateError && (
              <p
                role="alert"
                className="font-medium text-red-700"
                data-testid="plan-activate-error"
              >
                {activateError}
              </p>
            )}
            {ordersCount > 0 && (
              <Notice tone="info">
                <span data-testid="plan-orders-warning">
                  {t.existingOrdersWarning(ordersCount)}
                </span>{' '}
                <a href="#plan-orders" className="underline underline-offset-2">
                  {t.ordersTitle}
                </a>
              </Notice>
            )}
          </div>
        </Card>
      )}
      {canManage && (
        <Card title={plan ? t.edit : t.create} testId="plan-editor">
          <form
            noValidate
            onSubmit={(e) => {
              e.preventDefault();
              void showPreview();
            }}
            className="flex flex-col gap-5 text-sm"
          >
            <p className="text-stone-600">{t.intro}</p>
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <FormField id={`${id}-from`} label={t.form.validFrom} error={errors.validFrom}>
                <input
                  id={`${id}-from`}
                  type="date"
                  className={fieldClass(!!errors.validFrom)}
                  value={validFrom}
                  onChange={(e) => setValidFrom(e.target.value)}
                  data-testid="plan-valid-from"
                />
              </FormField>
              <FormField
                id={`${id}-to`}
                label={t.form.validTo}
                help={t.form.validToHelp}
                error={errors.validTo}
              >
                <input
                  id={`${id}-to`}
                  type="date"
                  className={fieldClass(!!errors.validTo)}
                  value={validTo}
                  onChange={(e) => setValidTo(e.target.value)}
                  data-testid="plan-valid-to"
                />
              </FormField>
            </div>
            {rules.map((r, i) => (
              <fieldset
                key={r.key}
                className="flex min-w-0 flex-col gap-3 rounded-md border border-stone-200 p-3"
                data-testid={`plan-rule-${i + 1}`}
              >
                <legend className="px-1 text-xs font-medium uppercase tracking-wide text-stone-500">
                  {t.rule(i + 1)}
                </legend>
                <div className="grid grid-cols-1 gap-3 sm:grid-cols-[minmax(0,1fr)_8rem]">
                  <FormField
                    id={`${id}-p-${r.key}`}
                    label={t.form.product}
                    error={errors[`product-${r.key}`]}
                  >
                    <select
                      id={`${id}-p-${r.key}`}
                      className={fieldClass(!!errors[`product-${r.key}`])}
                      value={r.productCode}
                      onChange={(e) => setRule(r.key, { productCode: e.target.value })}
                      data-testid={`plan-rule-${i + 1}-product`}
                    >
                      <option value="">{t.form.choose}</option>
                      {options.map((p) => (
                        <option key={p.code} value={p.code}>
                          {p.name}
                        </option>
                      ))}
                    </select>
                  </FormField>
                  <FormField
                    id={`${id}-c-${r.key}`}
                    label={t.form.crates}
                    error={errors[`crates-${r.key}`]}
                  >
                    <input
                      id={`${id}-c-${r.key}`}
                      inputMode="numeric"
                      className={`${fieldClass(!!errors[`crates-${r.key}`])} text-right tabular-nums`}
                      value={r.crates}
                      onChange={(e) =>
                        setRule(r.key, { crates: e.target.value.replace(/[^\d]/g, '') })
                      }
                      data-testid={`plan-rule-${i + 1}-crates`}
                    />
                  </FormField>
                </div>
                <div className="flex flex-col gap-1">
                  <span
                    className="text-xs font-medium uppercase tracking-wide text-stone-500"
                    id={`${id}-d-${r.key}`}
                  >
                    {t.form.days}
                  </span>
                  <div
                    role="group"
                    aria-labelledby={`${id}-d-${r.key}`}
                    className="grid grid-cols-7 gap-1 sm:grid-cols-[repeat(16,minmax(0,1fr))]"
                  >
                    {DAYS.map((d) => {
                      const on = r.days.includes(d);
                      return (
                        <button
                          key={d}
                          type="button"
                          aria-pressed={on}
                          onClick={() =>
                            setRule(r.key, {
                              days: on
                                ? r.days.filter((x) => x !== d)
                                : [...r.days, d].sort((a, b) => a - b),
                            })
                          }
                          className={`h-9 min-w-0 rounded border text-xs tabular-nums ${
                            on
                              ? 'border-stone-900 bg-stone-900 font-semibold text-white'
                              : d > 28
                                ? 'border-dashed border-stone-300 bg-white text-stone-700'
                                : 'border-stone-300 bg-white text-stone-700'
                          }`}
                          data-testid={`plan-rule-${i + 1}-day-${d}`}
                        >
                          {d}
                        </button>
                      );
                    })}
                  </div>
                  <p className="text-xs text-stone-500">{t.form.daysHelp}</p>
                  {errors[`days-${r.key}`] && (
                    <p className="text-xs font-medium text-red-700" data-field-error>
                      {errors[`days-${r.key}`]}
                    </p>
                  )}
                </div>
                {rules.length > 1 && (
                  <div>
                    <button
                      type="button"
                      className="text-xs underline underline-offset-2"
                      onClick={() => setRules(rules.filter((x) => x.key !== r.key))}
                    >
                      {t.form.removeRule}
                    </button>
                  </div>
                )}
              </fieldset>
            ))}
            {products.length === 0 && <Notice tone="warning">{t.form.noProducts}</Notice>}
            <ErrorSummary errors={errors} formError={formError} />
            <div className="flex flex-wrap gap-2">
              <button
                type="button"
                className={buttonClass.secondary}
                onClick={() =>
                  setRules([
                    ...rules,
                    {
                      key: Math.max(...rules.map((x) => x.key)) + 1,
                      productCode: '',
                      crates: '1',
                      days: [],
                    },
                  ])
                }
                data-testid="plan-add-rule"
              >
                {t.form.addRule}
              </button>
              <button
                type="submit"
                className={buttonClass.secondary}
                disabled={previewing.busy}
                data-testid="plan-preview"
              >
                {t.form.preview}
              </button>
              <button
                type="button"
                className={buttonClass.primary}
                onClick={() => validate() && setDialog('save')}
                data-testid="plan-save"
              >
                {t.form.save}
              </button>
            </div>
          </form>
        </Card>
      )}
      {preview && <PreviewView preview={preview} productName={productName} stale={stale} />}
      {plan && (
        <Card title={t.ordersTitle} testId="plan-orders" id="plan-orders">
          {plan.orders.length === 0 ? (
            <EmptyState>{t.noOrders}</EmptyState>
          ) : (
            <ul className="flex flex-col divide-y divide-stone-100 text-sm">
              {plan.orders.map((o) => (
                <li
                  key={o.code}
                  className="flex flex-wrap items-center gap-x-3 gap-y-1 py-2"
                  data-testid={`plan-order-${o.code}`}
                >
                  <Link
                    href={`/dispatch/orders/${o.code}`}
                    className="font-mono font-medium underline-offset-2 hover:underline"
                  >
                    {o.code}
                  </Link>
                  <OriginBadge origin={o.origin} />
                  <span className="rounded border border-stone-300 bg-stone-50 px-1.5 py-0.5 text-xs">
                    {ordersCs.status[o.status] ?? o.status}
                  </span>
                  <span>{formatDateCs(o.requestedShipDate)}</span>
                  {o.plannedShipDate !== o.requestedShipDate && (
                    <span className="text-xs text-stone-500">
                      ({t.moved(formatDateCs(o.plannedShipDate))})
                    </span>
                  )}
                </li>
              ))}
            </ul>
          )}
        </Card>
      )}
      <ConfirmDialog
        open={dialog !== null}
        title={
          dialog === 'save'
            ? t.form.saveTitle
            : dialog === 'activate'
              ? t.activateTitle
              : t.pauseTitle
        }
        confirmLabel={
          dialog === 'save'
            ? t.form.save
            : dialog === 'activate'
              ? t.activateConfirm
              : t.pauseConfirm
        }
        busy={sending.busy}
        confirmDisabled={dialog === 'activate' && (!checked || !confirming)}
        onConfirm={send}
        onCancel={() => setDialog(null)}
        testId="plan-dialog"
      >
        <p>
          {dialog === 'save'
            ? t.form.saveText
            : dialog === 'activate'
              ? t.activateText
              : t.pauseText}
        </p>
        {dialog === 'activate' && confirming && (
          <div className="mt-3 rounded-md border border-stone-200 bg-stone-50 p-3 text-sm">
            <p className="font-semibold" data-testid="plan-confirm-version">
              {t.confirmVersion(confirming.version)}
            </p>
            <p className="mt-1">{t.preview.what(confirming.preview.summary.orders)}</p>
            {confirming.preview.summary.products.length > 0 && (
              <ul className="mt-1 list-disc pl-5" data-testid="plan-confirm-what">
                {confirming.preview.summary.products.map((x) => (
                  <li key={x.productCode}>
                    {t.preview.whatLine(x.productName, x.crates, x.bottles)}
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}
        {dialog === 'save' && ordersCount > 0 && (
          <p className="mt-2 text-sm text-amber-900">{t.existingOrdersWarning(ordersCount)}</p>
        )}
        {dialog === 'activate' ? (
          <label className="mt-3 flex items-start gap-2 text-sm">
            <input
              type="checkbox"
              className="mt-0.5 h-5 w-5"
              checked={checked}
              onChange={(e) => setChecked(e.target.checked)}
              data-testid="plan-activate-check"
            />
            <span>{t.activateCheck}</span>
          </label>
        ) : (
          <ReasonField id={`${id}-reason`} value={reason} onChange={setReason} error={reasonErr} />
        )}
        {dialog === 'activate' && reasonErr && (
          <p role="alert" className="mt-2 text-sm font-medium text-red-700">
            {reasonErr}
          </p>
        )}
      </ConfirmDialog>
    </div>
  );
}

function PreviewView({
  preview: p,
  productName,
  stale,
}: {
  preview: SupplyPreview;
  productName: (code: string) => string;
  /** The form changed since: the preview no longer shows what it contains. */
  stale: boolean;
}) {
  const blockerText = (b: SupplyPreview['days'][number]['blockers'][number]) =>
    t.blockers[b.code]!(
      b.code === 'ORDER_REFUSED' ? b.detail : b.product ? productName(b.product) : null,
    );
  return (
    <Card title={t.preview.title} testId="plan-preview-result">
      <div className="flex flex-col gap-4 text-sm">
        {stale && (
          <Notice tone="warning">
            <span data-testid="plan-preview-stale">{t.preview.stale}</span>
          </Notice>
        )}
        <p className="text-stone-600">
          {t.preview.intro(formatDateCs(p.from), formatDateCs(p.to), p.timeZone)}
        </p>
        <div
          className={`rounded-md border border-stone-200 bg-stone-50 p-3 ${stale ? 'opacity-50' : ''}`}
          data-testid="plan-what"
        >
          <p className="font-semibold">{t.preview.whatTitle}</p>
          <p className="mt-1">{t.preview.what(p.summary.orders)}</p>
          {p.summary.products.length > 0 && (
            <ul className="mt-1 list-disc pl-5">
              {p.summary.products.map((x) => (
                <li key={x.productCode}>
                  {t.preview.whatLine(x.productName, x.crates, x.bottles)}
                </li>
              ))}
            </ul>
          )}
          <p className="mt-2 text-xs text-stone-600">{t.preview.horizon(p.horizonDays)}</p>
          {p.summary.blocked > 0 && (
            <p className="mt-1 text-xs font-medium text-amber-900">
              {t.preview.blockedCount(p.summary.blocked)}
            </p>
          )}
        </div>
        {p.days.length === 0 ? (
          <EmptyState>{t.preview.empty}</EmptyState>
        ) : (
          <ul className="flex flex-col divide-y divide-stone-100" data-testid="plan-preview-days">
            {p.days.map((d) => (
              <li
                key={d.shipDate}
                className="flex flex-col gap-1 py-3"
                data-testid={`plan-day-${d.shipDate}`}
              >
                <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
                  <span className="font-medium">{formatDateCs(d.shipDate)}</span>
                  <span className="text-xs text-stone-600">
                    {d.blockers.length > 0
                      ? t.preview.blockedState
                      : d.occurrence?.order
                        ? t.preview.created(d.occurrence.order.code)
                        : d.inHorizon
                          ? t.preview.willCreate
                          : t.preview.later}
                  </span>
                </div>
                <ul className="flex flex-col gap-0.5">
                  {d.lines.map((l) => (
                    <li key={l.productCode} className="tabular-nums">
                      {l.productName}: {l.crates} × {l.crateType ?? '–'} ·{' '}
                      {l.bottles !== null ? `${l.bottles} lahví` : t.preview.unknownCapacity}
                    </li>
                  ))}
                </ul>
                {d.blockers.map((b, i) => (
                  <p key={i} className="text-xs font-medium text-amber-900">
                    {blockerText(b)}
                  </p>
                ))}
                {d.existingOrders.length > 0 && (
                  <p className="text-xs text-sky-900" data-testid="plan-day-overlap">
                    {t.preview.overlap(d.existingOrders.map((o) => o.code).join(', '))}
                  </p>
                )}
              </li>
            ))}
          </ul>
        )}
        {p.skipped.length > 0 && (
          <div data-testid="plan-skipped">
            <p className="text-xs font-medium uppercase tracking-wide text-stone-500">
              {t.preview.skipped}
            </p>
            <ul className="mt-1 list-disc pl-5 text-xs text-stone-700">
              {p.skipped.map((s, i) => {
                const [y, m] = s.month.split('-');
                return (
                  <li key={i}>
                    {t.preview.skippedLine(productName(s.productCode), s.day, `${Number(m)}/${y}`)}
                  </li>
                );
              })}
            </ul>
          </div>
        )}
      </div>
    </Card>
  );
}
