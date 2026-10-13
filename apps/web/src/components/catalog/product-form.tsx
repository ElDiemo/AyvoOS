'use client';

import {
  productCodeSchema,
  productSchema,
  type CatalogUnit,
  type ProductCategory,
} from '@ayvo/types';
import { useRouter } from 'next/navigation';
import { useId, useRef, useState } from 'react';
import { buttonClass, Card } from '@/components/ui';
import { UnsavedChangesGuard } from '@/components/unsaved-changes-guard';
import { catalogCs } from '@/i18n/cs/catalog';
import { unitCs } from '@/i18n/cs/format';
import { normalizeDecimal } from '@/lib/catalog-forms';
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

const t = catalogCs.products;
const c = catalogCs.common;

/** Nový produkt (createProductRequestSchema). The nominal content is product data only. */
export function ProductForm({
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
  const [categoryCode, setCategoryCode] = useState('');
  const [nominal, setNominal] = useState('');
  const [unitCode, setUnitCode] = useState(
    units.find((u) => u.code === 'ml')?.code ?? units[0]?.code ?? '',
  );
  const [reason, setReason] = useState('');
  const [errors, setErrors] = useState<Record<string, string | null>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const { busy, run } = useAttempt();
  const dirty = !!(code || name || nominal || reason || categoryCode);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    const quantity = normalizeDecimal(nominal);
    const next = {
      code: productCodeSchema.safeParse(code.trim()).success ? null : t.codeInvalid,
      name: name.trim() ? null : c.required,
      category: categoryCode ? null : c.required,
      nominal: quantity ? null : t.quantityInvalid,
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
      categoryCode,
      nominalQuantity: quantity!,
      nominalUnitCode: unitCode,
      reason: reason.trim(),
    };
    const result = await run(JSON.stringify(body), (requestId) =>
      apiSend('POST', 'admin/catalog/products', productSchema, { requestId, ...body }),
    );
    if (result.ok) {
      setCode('');
      setName('');
      setNominal('');
      setReason('');
      setCategoryCode('');
      router.push(
        `/production/catalog/products/${encodeURIComponent(result.value.code)}?created=1`,
      );
    } else if (result.error) {
      setFormError(catalogErrorText(result.error));
    }
  }

  const f = (n: string) => `${id}-${n}`;
  return (
    <Card>
      <form
        ref={form}
        noValidate
        onSubmit={submit}
        className="flex flex-col gap-5"
        data-testid="product-form"
      >
        <UnsavedChangesGuard dirty={dirty && !busy} onDiscard={() => setReason('')} />
        <p className="text-sm text-stone-600">{t.immutable}</p>
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
          <FormField id={f('name')} label={c.name} error={errors.name}>
            <input
              id={f('name')}
              value={name}
              maxLength={200}
              onChange={(e) => setName(e.target.value)}
              aria-invalid={!!errors.name}
              aria-describedby={describedBy(f('name'), false, !!errors.name)}
              className={fieldClass(!!errors.name)}
            />
          </FormField>
          <FormField id={f('code')} label={c.code} help={t.codeHelp} error={errors.code}>
            <input
              id={f('code')}
              value={code}
              maxLength={24}
              spellCheck={false}
              onChange={(e) => setCode(e.target.value.toUpperCase())}
              aria-invalid={!!errors.code}
              aria-describedby={describedBy(f('code'), true, !!errors.code)}
              className={`${fieldClass(!!errors.code)} font-mono`}
            />
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
              <option value="">{catalogCs.recipe.choose}</option>
              {categories.map((cat) => (
                <option key={cat.code} value={cat.code}>
                  {cat.name}
                </option>
              ))}
            </select>
          </FormField>
          <div className="grid grid-cols-[minmax(0,1fr)_7rem] gap-2">
            <FormField
              id={f('nominal')}
              label={t.nominal}
              help={t.nominalHelp}
              error={errors.nominal}
            >
              <input
                id={f('nominal')}
                inputMode="decimal"
                value={nominal}
                onChange={(e) => setNominal(e.target.value)}
                aria-invalid={!!errors.nominal}
                aria-describedby={describedBy(f('nominal'), true, !!errors.nominal)}
                className={fieldClass(!!errors.nominal)}
              />
            </FormField>
            <FormField id={f('unit')} label={t.nominalUnit}>
              <select
                id={f('unit')}
                value={unitCode}
                onChange={(e) => setUnitCode(e.target.value)}
                className={fieldClass(false)}
              >
                {units.map((u) => (
                  <option key={u.code} value={u.code}>
                    {unitCs(u.code)}
                  </option>
                ))}
              </select>
            </FormField>
          </div>
        </div>
        <ReasonField id={f('reason')} value={reason} onChange={setReason} error={errors.reason} />
        <ErrorSummary errors={errors} formError={formError} />
        <div>
          <button type="submit" disabled={busy} className={buttonClass.primary}>
            {busy ? c.saving : t.submit}
          </button>
        </div>
      </form>
    </Card>
  );
}
