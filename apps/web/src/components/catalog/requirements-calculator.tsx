'use client';

import { materialRequirementsSchema, type MaterialRequirements } from '@ayvo/types';
import { useId, useState } from 'react';
import { buttonClass, Card } from '@/components/ui';
import { catalogCs } from '@/i18n/cs/catalog';
import { formatQuantityCs, unitCs } from '@/i18n/cs/format';
import { parseBottles } from '@/lib/catalog-forms';
import { apiGet } from '@/lib/client-api';
import { catalogErrorText, describedBy, fieldClass, FormField } from './form-kit';

const t = catalogCs.calc;

/**
 * Výpočet materiálu (doc 023 §5): the API computes the exact totals; this only shows them
 * (decimal strings, never re-computed with floats). Planning only — nothing is reserved.
 */
export function RequirementsCalculator({
  productCode,
  version,
  complete,
  historic,
}: {
  productCode: string;
  version: number;
  complete: boolean;
  historic: boolean;
}) {
  const id = useId();
  const [input, setInput] = useState('40');
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<MaterialRequirements | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    const bottles = parseBottles(input);
    if (bottles === null) {
      setError(t.invalid);
      return;
    }
    setError(null);
    setBusy(true);
    try {
      setResult(
        await apiGet(
          `admin/catalog/products/${encodeURIComponent(productCode)}/recipes/${version}/requirements?bottles=${bottles}`,
          materialRequirementsSchema,
        ),
      );
    } catch (err) {
      setResult(null);
      setError(catalogErrorText(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card title={t.title} testId="calculator">
      <div className="flex flex-col gap-4">
        <p className="rounded-md bg-stone-50 p-3 text-sm text-stone-700">{t.note}</p>
        {!complete ? (
          <p className="text-sm text-amber-900" data-testid="calc-incomplete">
            {t.incomplete}
          </p>
        ) : (
          <form noValidate onSubmit={submit} className="flex flex-wrap items-end gap-3">
            <div className="w-48">
              <FormField id={`${id}-bottles`} label={t.bottles} error={error}>
                <input
                  id={`${id}-bottles`}
                  inputMode="numeric"
                  value={input}
                  onChange={(e) => setInput(e.target.value)}
                  aria-invalid={!!error}
                  aria-describedby={describedBy(`${id}-bottles`, false, !!error)}
                  className={fieldClass(!!error)}
                />
              </FormField>
            </div>
            <button type="submit" disabled={busy} className={buttonClass.primary}>
              {t.run}
            </button>
            {historic && <p className="text-xs text-stone-500">{t.historic}</p>}
          </form>
        )}
        {result && (
          <div className="flex flex-col gap-3" data-testid="calc-result" aria-live="polite">
            <ul className="flex flex-col" aria-label={t.title}>
              {result.components.map((c) => (
                <li
                  key={c.itemCode}
                  className="grid grid-cols-[minmax(0,1fr)_auto] items-baseline gap-x-3 gap-y-0.5 border-t border-stone-100 py-2 text-sm first:border-t-0"
                  data-kind={c.kind}
                >
                  <span className="min-w-0 wrap-anywhere">
                    <span className="font-medium">
                      {catalogCs.recipe.rows[c.kind as keyof typeof catalogCs.recipe.rows]}
                    </span>{' '}
                    <span className="text-stone-600">{c.itemName}</span>
                  </span>
                  <span
                    className="text-right font-semibold whitespace-nowrap tabular-nums"
                    data-testid={`total-${c.kind}`}
                  >
                    {formatQuantityCs(c.totalQuantity)} {unitCs(c.unit.code)}
                  </span>
                  <span className="text-xs text-stone-500">
                    {t.perBottle}: {formatQuantityCs(c.quantity)} {unitCs(c.unit.code)}
                  </span>
                </li>
              ))}
            </ul>
            <div
              className="rounded-md border border-stone-200 p-3 text-sm"
              data-testid="calc-crates"
            >
              <p className="font-medium">
                {t.crates}:{' '}
                {t.crateLine(
                  result.crates.count,
                  result.crates.crateType.capacity,
                  result.crates.crateType.name,
                )}
              </p>
              <p>{t.full(result.crates.full)}</p>
              <p>
                {result.crates.partialCrateBottles > 0
                  ? t.partial(result.crates.partialCrateBottles)
                  : t.allFull}
              </p>
              {result.crates.partialCrateBottles > 0 && (
                <p className="mt-2 text-amber-900" data-testid="partial-warning">
                  {t.partialWarning}
                </p>
              )}
            </div>
          </div>
        )}
      </div>
    </Card>
  );
}
