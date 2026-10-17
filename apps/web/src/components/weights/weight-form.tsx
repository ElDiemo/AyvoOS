'use client';

import { useRouter } from 'next/navigation';
import { useId, useState } from 'react';
import {
  catalogErrorText,
  describedBy,
  fieldClass,
  FormField,
  SuccessNote,
  useAttempt,
} from '@/components/catalog/form-kit';
import { buttonClass, Card } from '@/components/ui';
import { weightsCs } from '@/i18n/cs/weights';
import { ClientApiError, apiSend } from '@/lib/client-api';
import { kgToG, parseDecimal } from '@/lib/measure';
import { z } from 'zod';

const t = weightsCs.form;

export type WeightFormKind =
  | { kind: 'item'; mode: 'PER_UNIT' | 'SAMPLE'; unitCode: string }
  | {
      kind: 'product';
      versions: { version: number; status: 'ACTIVE' | 'ARCHIVED' }[];
      /** The latest record per recipe version: a correction stays on the chosen version. */
      latest: Record<number, string>;
    }
  | { kind: 'tare' }
  | {
      kind: 'dimensions';
      subject: 'CRATE' | 'SHIPPING_PACKAGE';
      /** Catalogue PACKAGING items that may be the extra packaging (their own weight is used). */
      packagingItems?: { code: string; name: string }[];
    };

function today(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/**
 * Zapsat měření (catalog:weights_record): one measured value with its date and method; a
 * correction refers to the latest record and keeps it in the history. Nothing is pre-filled
 * with a value — an unmeasured value stays unknown.
 */
export function WeightForm({
  path,
  form,
  title,
  currentId,
  testId,
}: {
  /** API path, e.g. "admin/catalog/crate-types/CRT-1/tare". */
  path: string;
  form: WeightFormKind;
  title: string;
  /** The latest record (for a correction), or null. */
  currentId: string | null;
  testId: string;
}) {
  const router = useRouter();
  const id = useId();
  const f = (n: string) => `${id}-${n}`;
  const initial = (): Record<string, string> => ({
    measuredOn: today(),
    extra: 'NONE',
    extraItem: '',
    version:
      form.kind === 'product'
        ? String(
            form.versions.find((x) => x.status === 'ACTIVE')?.version ??
              form.versions[0]?.version ??
              '',
          )
        : '',
  });
  const [v, setV] = useState<Record<string, string>>(initial);
  const [inTare, setInTare] = useState(false);
  const correctable =
    form.kind === 'product' ? (form.latest[Number(v.version)] ?? null) : currentId;
  const [correct, setCorrect] = useState(false);
  const [errors, setErrors] = useState<Record<string, string | null>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const { busy, run } = useAttempt();
  // Functional update: several fields filled in quick succession never overwrite each other.
  const set = (k: string) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => {
    const value = e.target.value;
    setV((prev) => ({ ...prev, [k]: value }));
  };

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    const next: Record<string, string | null> = {};
    const req = (k: string) => {
      if (!(v[k] ?? '').trim()) next[k] = t.required;
    };
    req('measuredOn');
    req('method');
    if (correct) req('correctionReason');
    const body: Record<string, unknown> = {
      measuredOn: v.measuredOn,
      method: (v.method ?? '').trim(),
      correctionOf: correct ? correctable : null,
      correctionReason: correct ? (v.correctionReason ?? '').trim() : null,
    };
    const grams = (k: string, kg = false) => {
      const raw = v[k] ?? '';
      const g = kg ? kgToG(raw) : parseDecimal(raw, 3);
      if (!g) next[k] = t.invalidMass;
      return g;
    };
    if (form.kind === 'item') {
      body.massG = grams('mass');
      body.sampleVolume = form.mode === 'SAMPLE' ? grams('sampleVolume') : null;
    } else if (form.kind === 'product') {
      const version = Number(v.version);
      if (!Number.isInteger(version) || version < 1) next.version = t.required;
      body.recipeVersion = version;
      body.massG = grams('mass');
      const n = Number(v.bottles);
      if (!Number.isInteger(n) || n < 1) next.bottles = t.required;
      body.bottlesWeighed = n;
    } else if (form.kind === 'tare') {
      body.massG = grams('mass', true);
      req('configuration');
      body.configuration = (v.configuration ?? '').trim();
    } else {
      body.subject = form.subject;
      for (const k of ['length', 'width', 'height']) {
        const n = Number(v[k]);
        if (!Number.isInteger(n) || n < 1 || n > 10000) next[k] = t.invalidMm;
        body[`${k}Mm`] = n;
      }
      const pkg = form.subject === 'SHIPPING_PACKAGE';
      const extra = pkg ? (v.extra ?? 'NONE') : null;
      body.extraPackaging = extra;
      const real = extra !== null && extra !== 'NONE';
      if (real) req('extraDescription');
      body.extraDescription = real ? (v.extraDescription ?? '').trim() : null;
      const item = real && v.extraItem ? v.extraItem : null;
      body.extraItemCode = item;
      // A catalogue packaging item brings its own weight: no second mass for it.
      body.extraMassG = real && !item && (v.extraMass ?? '').trim() ? grams('extraMass') : null;
      body.extraInTare = real ? inTare : null;
    }
    setErrors(next);
    setFormError(null);
    setDone(false);
    if (Object.values(next).some(Boolean)) return;
    const result = await run(JSON.stringify(body), (requestId) =>
      apiSend('POST', path, z.unknown(), { requestId, ...body }),
    );
    if (result.ok) {
      setDone(true);
      setV(initial());
      setInTare(false);
      setCorrect(false);
      router.refresh();
    } else if (result.error) {
      const code = result.error instanceof ClientApiError ? result.error.code : null;
      setFormError((code && weightsCs.errors[code]) || catalogErrorText(result.error));
    }
  }

  const input = (
    k: string,
    label: string,
    opts: { inputMode?: 'decimal' | 'numeric'; type?: string } = {},
  ) => (
    <FormField id={f(k)} label={label} error={errors[k]}>
      <input
        id={f(k)}
        type={opts.type ?? 'text'}
        inputMode={opts.inputMode}
        value={v[k] ?? ''}
        onChange={set(k)}
        aria-invalid={!!errors[k]}
        aria-describedby={describedBy(f(k), false, !!errors[k])}
        className={fieldClass(!!errors[k])}
      />
    </FormField>
  );
  const pkg = form.kind === 'dimensions' && form.subject === 'SHIPPING_PACKAGE';
  const realExtra = pkg && v.extra !== 'NONE';
  return (
    <Card title={title} testId={testId}>
      <form noValidate onSubmit={submit} className="flex flex-col gap-3">
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          {form.kind === 'item' &&
            (form.mode === 'SAMPLE' ? (
              <>
                {input('mass', t.sampleMass, { inputMode: 'decimal' })}
                {input('sampleVolume', t.sampleVolume(form.unitCode), { inputMode: 'decimal' })}
              </>
            ) : (
              input('mass', t.massG, { inputMode: 'decimal' })
            ))}
          {form.kind === 'product' && (
            <>
              <FormField id={f('version')} label={t.recipeVersion} error={errors.version}>
                <select
                  id={f('version')}
                  value={v.version}
                  onChange={set('version')}
                  className={fieldClass(!!errors.version)}
                >
                  {form.versions.map((x) => (
                    <option key={x.version} value={x.version}>
                      {t.recipeVersionOption(x.version, x.status === 'ACTIVE')}
                    </option>
                  ))}
                </select>
              </FormField>
              <FormField
                id={f('mass')}
                label={t.bottleMass}
                help={t.bottleMassHelp}
                error={errors.mass}
              >
                <input
                  id={f('mass')}
                  inputMode="decimal"
                  value={v.mass ?? ''}
                  onChange={set('mass')}
                  aria-invalid={!!errors.mass}
                  aria-describedby={describedBy(f('mass'), true, !!errors.mass)}
                  className={fieldClass(!!errors.mass)}
                />
              </FormField>
              {input('bottles', t.bottles, { inputMode: 'numeric' })}
            </>
          )}
          {form.kind === 'tare' && (
            <>
              {input('mass', t.massKg, { inputMode: 'decimal' })}
              {input('configuration', t.configuration)}
            </>
          )}
          {form.kind === 'dimensions' && (
            <>
              {input('length', t.length, { inputMode: 'numeric' })}
              {input('width', t.width, { inputMode: 'numeric' })}
              {input('height', t.height, { inputMode: 'numeric' })}
            </>
          )}
          {pkg && (
            <FormField id={f('extra')} label={t.extra}>
              <select
                id={f('extra')}
                value={v.extra}
                onChange={set('extra')}
                className={fieldClass(false)}
              >
                {Object.entries(weightsCs.crateType.packaging).map(([k, label]) => (
                  <option key={k} value={k}>
                    {label}
                  </option>
                ))}
              </select>
            </FormField>
          )}
          {realExtra && (
            <>
              {input('extraDescription', t.extraDescription)}
              {form.kind === 'dimensions' && (form.packagingItems ?? []).length > 0 && (
                <FormField id={f('extraItem')} label={t.extraItem} help={t.extraItemHelp}>
                  <select
                    id={f('extraItem')}
                    value={v.extraItem}
                    onChange={set('extraItem')}
                    aria-describedby={describedBy(f('extraItem'), true, false)}
                    className={fieldClass(false)}
                  >
                    <option value="">{t.extraItemNone}</option>
                    {(form.packagingItems ?? []).map((i) => (
                      <option key={i.code} value={i.code}>
                        {i.name} ({i.code})
                      </option>
                    ))}
                  </select>
                </FormField>
              )}
              {!v.extraItem && input('extraMass', t.extraMassG, { inputMode: 'decimal' })}
              <label className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={inTare}
                  onChange={(e) => setInTare(e.target.checked)}
                />
                {t.extraInTare}
              </label>
            </>
          )}
          {input('measuredOn', t.measuredOn, { type: 'date' })}
          {input('method', t.method)}
        </div>
        {correctable && (
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={correct}
              onChange={(e) => setCorrect(e.target.checked)}
            />
            {t.correction}
          </label>
        )}
        {correct && input('correctionReason', t.correctionReason)}
        {formError && (
          <p role="alert" className="text-sm text-red-700">
            {formError}
          </p>
        )}
        {done && <SuccessNote>{t.saved}</SuccessNote>}
        <div>
          <button type="submit" disabled={busy} className={buttonClass.primary}>
            {t.save}
          </button>
        </div>
      </form>
    </Card>
  );
}
