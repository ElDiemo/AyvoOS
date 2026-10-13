'use client';

import {
  catalogComponentSchema,
  catalogCodeSchema,
  COMPONENT_KINDS,
  type CatalogUnit,
  type ComponentKind,
  type ProductCategory,
} from '@ayvo/types';
import { useRouter } from 'next/navigation';
import { useId, useRef, useState } from 'react';
import { buttonClass, Card } from '@/components/ui';
import { UnsavedChangesGuard } from '@/components/unsaved-changes-guard';
import { catalogCs } from '@/i18n/cs/catalog';
import { unitCs } from '@/i18n/cs/format';
import { apiSend } from '@/lib/client-api';
import {
  catalogErrorText,
  describedBy,
  ErrorSummary,
  fieldClass,
  focusFirstError,
  FormField,
  ReasonField,
  reasonError,
  useAttempt,
} from './form-kit';

const t = catalogCs.components;
const c = catalogCs.common;

/** Units a kind may use (doc 023 §4): liquids by volume, everything else in pieces. */
export const unitsFor = (kind: ComponentKind, units: readonly CatalogUnit[]) =>
  units.filter((u) => (kind === 'BULK_LIQUID' ? u.dimension === 'VOLUME' : u.code === 'pcs'));

/** Výroba → Produkty a receptury → Nová komponenta (createComponentRequestSchema). */
export function ComponentForm({
  units,
  categories,
}: {
  units: CatalogUnit[];
  categories: ProductCategory[];
}) {
  const router = useRouter();
  const id = useId();
  const form = useRef<HTMLFormElement>(null);
  const [code, setCode] = useState('');
  const [name, setName] = useState('');
  const [kind, setKind] = useState<ComponentKind>('NEW_BOTTLE');
  const [unitCode, setUnitCode] = useState('pcs');
  const [categoryCode, setCategoryCode] = useState('');
  const [lotTracked, setLotTracked] = useState(true);
  const [capacity, setCapacity] = useState('');
  const [reason, setReason] = useState('');
  const [errors, setErrors] = useState<Record<string, string | null>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const { busy, run } = useAttempt();
  const allowedUnits = unitsFor(kind, units);
  const needsCategory = kind === 'BULK_LIQUID' || kind === 'LABEL_MEDIA';
  const dirty = !!(code || name || reason || categoryCode || capacity);

  function changeKind(next: ComponentKind) {
    setKind(next);
    setUnitCode(unitsFor(next, units)[0]?.code ?? '');
    if (next === 'NEW_BOTTLE') setLotTracked(true);
    if (next !== 'PACKAGING') setCapacity('');
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    const capacityValue =
      capacity.trim() === ''
        ? null
        : /^[1-9]\d{0,5}$/.test(capacity.trim()) && Number(capacity.trim()) <= 100_000
          ? Number(capacity.trim())
          : NaN;
    const next = {
      code: catalogCodeSchema.safeParse(code.trim()).success ? null : c.codeInvalid,
      name: name.trim() ? null : c.required,
      unit: allowedUnits.some((u) => u.code === unitCode) ? null : t.unitNone,
      category: needsCategory && !categoryCode ? t.categoryRequired : null,
      capacity:
        kind === 'PACKAGING' && Number.isNaN(capacityValue)
          ? catalogCs.packageCapacityInvalid
          : null,
      reason: reasonError(reason),
    };
    setErrors(next);
    setFormError(null);
    if (Object.values(next).some(Boolean)) {
      requestAnimationFrame(() => focusFirstError(form.current));
      return;
    }
    const body = {
      code: code.trim(),
      name: name.trim(),
      kind,
      unitCode,
      lotTracked: kind === 'NEW_BOTTLE' ? true : lotTracked,
      categoryCode: categoryCode || null,
      packageCapacity: kind === 'PACKAGING' ? (capacityValue as number | null) : null,
      reason: reason.trim(),
    };
    const result = await run(JSON.stringify(body), (requestId) =>
      apiSend('POST', 'admin/catalog/components', catalogComponentSchema, { requestId, ...body }),
    );
    if (result.ok) {
      setCode('');
      setName('');
      setReason('');
      setCategoryCode('');
      setCapacity('');
      router.push(
        `/production/catalog/components?created=${encodeURIComponent(result.value.code)}`,
      );
      router.refresh();
    } else if (result.error) {
      setFormError(catalogErrorText(result.error));
    }
  }

  const f = (name: string) => `${id}-${name}`;
  return (
    <Card>
      <form
        ref={form}
        noValidate
        onSubmit={submit}
        className="flex flex-col gap-5"
        data-testid="component-form"
      >
        <UnsavedChangesGuard
          dirty={dirty && !busy}
          onDiscard={() => {
            setCode('');
            setName('');
            setReason('');
          }}
        />
        <p className="text-sm text-stone-600">{c.immutable}</p>
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
          <FormField id={f('kind')} label={t.kind} help={catalogCs.kindHelp[kind]}>
            <select
              id={f('kind')}
              value={kind}
              onChange={(e) => changeKind(e.target.value as ComponentKind)}
              aria-describedby={describedBy(f('kind'), true, false)}
              className={fieldClass(false)}
            >
              {COMPONENT_KINDS.map((k) => (
                <option key={k} value={k}>
                  {catalogCs.kinds[k]}
                </option>
              ))}
            </select>
          </FormField>
          <FormField id={f('name')} label={c.name} error={errors.name}>
            <input
              id={f('name')}
              value={name}
              maxLength={120}
              onChange={(e) => setName(e.target.value)}
              aria-invalid={!!errors.name}
              aria-describedby={describedBy(f('name'), false, !!errors.name)}
              className={fieldClass(!!errors.name)}
            />
          </FormField>
          <FormField id={f('code')} label={c.code} help={c.codeHelp} error={errors.code}>
            <input
              id={f('code')}
              value={code}
              maxLength={40}
              autoCapitalize="characters"
              spellCheck={false}
              onChange={(e) => setCode(e.target.value.toUpperCase())}
              aria-invalid={!!errors.code}
              aria-describedby={describedBy(f('code'), true, !!errors.code)}
              className={`${fieldClass(!!errors.code)} font-mono`}
            />
          </FormField>
          <FormField id={f('unit')} label={t.unit} error={errors.unit}>
            <select
              id={f('unit')}
              value={unitCode}
              onChange={(e) => setUnitCode(e.target.value)}
              aria-invalid={!!errors.unit}
              className={fieldClass(!!errors.unit)}
            >
              {allowedUnits.map((u) => (
                <option key={u.code} value={u.code}>
                  {unitCs(u.code)} – {u.name}
                </option>
              ))}
            </select>
          </FormField>
          <FormField id={f('category')} label={t.category} error={errors.category}>
            <select
              id={f('category')}
              value={categoryCode}
              onChange={(e) => setCategoryCode(e.target.value)}
              aria-invalid={!!errors.category}
              aria-describedby={describedBy(f('category'), false, !!errors.category)}
              className={fieldClass(!!errors.category)}
            >
              <option value="">{needsCategory ? catalogCs.recipe.choose : c.any}</option>
              {categories.map((cat) => (
                <option key={cat.code} value={cat.code}>
                  {cat.name}
                </option>
              ))}
            </select>
          </FormField>
          {kind === 'PACKAGING' && (
            <FormField
              id={f('capacity')}
              label={t.packageCapacity}
              help={t.packageCapacityHelp}
              error={errors.capacity}
            >
              <input
                id={f('capacity')}
                inputMode="numeric"
                value={capacity}
                onChange={(e) => setCapacity(e.target.value)}
                aria-invalid={!!errors.capacity}
                aria-describedby={describedBy(f('capacity'), true, !!errors.capacity)}
                className={fieldClass(!!errors.capacity)}
              />
            </FormField>
          )}
        </div>
        <label className="flex items-start gap-2 text-sm">
          <input
            type="checkbox"
            className="mt-0.5"
            checked={kind === 'NEW_BOTTLE' ? true : lotTracked}
            disabled={kind === 'NEW_BOTTLE'}
            onChange={(e) => setLotTracked(e.target.checked)}
          />
          <span>
            {t.lotTracked}
            {kind === 'NEW_BOTTLE' && (
              <span className="block text-xs text-stone-500">{t.lotTrackedRequired}</span>
            )}
          </span>
        </label>
        <ReasonField id={f('reason')} value={reason} onChange={setReason} error={errors.reason} />
        <ErrorSummary errors={errors} formError={formError} />
        <div className="flex flex-wrap gap-2">
          <button type="submit" disabled={busy} className={buttonClass.primary}>
            {busy ? c.saving : t.submit}
          </button>
        </div>
      </form>
    </Card>
  );
}
