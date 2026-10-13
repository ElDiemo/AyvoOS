'use client';

import {
  REQUIRED_RECIPE_KINDS,
  recipeVersionSchema,
  type CatalogComponent,
  type CrateType,
  type RecipeComponentKind,
  type RecipeVersion,
} from '@ayvo/types';
import { useRouter } from 'next/navigation';
import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { buttonClass, Card } from '@/components/ui';
import { UnsavedChangesGuard } from '@/components/unsaved-changes-guard';
import { catalogCs } from '@/i18n/cs/catalog';
import { unitCs } from '@/i18n/cs/format';
import { shellCs } from '@/i18n/cs/shell';
import {
  draftChanges,
  draftFromRecipe,
  draftPayload,
  eligibleCrateTypes,
  eligibleItems,
  stageOf,
  type RecipeDraft,
} from '@/lib/catalog-forms';
import { apiSend } from '@/lib/client-api';
import {
  catalogErrorText,
  ErrorSummary,
  fieldClass,
  focusFirstError,
  labelClass,
  ReasonField,
  reasonError,
  SuccessNote,
  useAttempt,
} from './form-kit';

const t = catalogCs.recipe;

/**
 * Editor of a DRAFT recipe version (doc 023 §4, issue #17): four rows for one finished bottle
 * (Lahev, Etiketa, Kapalina, Pumpička) and the crate type. Saving appends a revision (PUT); the
 * draft may be incomplete, never invalid. Unsaved changes are marked and guarded.
 */
export function RecipeEditor({
  recipe,
  components,
  crateTypes,
  onDirtyChange,
}: {
  recipe: RecipeVersion;
  components: CatalogComponent[];
  crateTypes: CrateType[];
  onDirtyChange?: (dirty: boolean) => void;
}) {
  const router = useRouter();
  const id = useId();
  const form = useRef<HTMLFormElement>(null);
  const category = recipe.product.category.code;
  const initial = useMemo(() => draftFromRecipe(recipe), [recipe]);
  const [draft, setDraft] = useState<RecipeDraft>(initial);
  const [reason, setReason] = useState('');
  const [errors, setErrors] = useState<Record<string, string | null>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const { busy, run } = useAttempt();
  const labels = { rows: t.rows, crate: t.crate, empty: t.empty };
  const changes = draftChanges(initial, draft, components, crateTypes, labels);
  const dirty = changes.length > 0;
  const crates = eligibleCrateTypes(crateTypes, category);
  useEffect(() => onDirtyChange?.(dirty), [dirty, onDirtyChange]);

  // Items already used by this version stay selectable even if archived (so nothing silently changes).
  const options = (kind: RecipeComponentKind) => {
    const list = eligibleItems(components, kind, category);
    const current = components.find((c) => c.code === initial.rows[kind].itemCode);
    return current && !list.includes(current) ? [current, ...list] : list;
  };

  const setRow = (
    kind: RecipeComponentKind,
    patch: Partial<RecipeDraft['rows'][RecipeComponentKind]>,
  ) => {
    setSaved(false);
    setDraft((d) => ({ ...d, rows: { ...d.rows, [kind]: { ...d.rows[kind], ...patch } } }));
  };

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setSaved(false);
    const { payload, invalid } = draftPayload(draft, components);
    const next: Record<string, string | null> = { reason: dirty ? reasonError(reason) : null };
    for (const kind of REQUIRED_RECIPE_KINDS) {
      next[kind] = invalid.includes(kind) ? catalogCs.products.quantityInvalid : null;
    }
    setErrors(next);
    setFormError(dirty ? null : t.noChanges);
    if (!dirty) return;
    if (Object.values(next).some(Boolean)) {
      requestAnimationFrame(() => focusFirstError(form.current));
      return;
    }
    const body = { ...payload, reason: reason.trim() };
    const result = await run(JSON.stringify(body), (requestId) =>
      apiSend(
        'PUT',
        `admin/catalog/products/${encodeURIComponent(recipe.product.code)}/recipes/${recipe.version}`,
        recipeVersionSchema,
        { requestId, ...body },
      ),
    );
    if (result.ok) {
      setReason('');
      setDraft(draftFromRecipe(result.value));
      setSaved(true);
      router.refresh();
    } else if (result.error) setFormError(catalogErrorText(result.error));
  }

  const f = (n: string) => `${id}-${n}`;
  return (
    <Card title={t.perBottle}>
      <form
        ref={form}
        noValidate
        onSubmit={save}
        className="flex flex-col gap-5"
        data-testid="recipe-editor"
      >
        <UnsavedChangesGuard
          dirty={dirty}
          onDiscard={() => {
            setDraft(initial);
            setReason('');
          }}
        />
        {dirty && (
          <p
            className="self-start rounded-md bg-amber-100 px-2 py-0.5 text-xs font-medium text-amber-900"
            data-testid="unsaved-badge"
          >
            {shellCs.unsaved.badge}
          </p>
        )}
        <p className="text-sm text-stone-600">{t.draftHelp}</p>
        <div className="flex flex-col gap-4">
          {REQUIRED_RECIPE_KINDS.map((kind) => {
            const row = draft.rows[kind];
            const item = components.find((c) => c.code === row.itemCode);
            const list = options(kind);
            return (
              <fieldset
                key={kind}
                className="grid grid-cols-1 gap-3 rounded-md border border-stone-200 p-3 sm:grid-cols-[minmax(0,1fr)_9rem_4rem]"
                data-row={kind}
              >
                <legend className="px-1 text-sm font-semibold">
                  {t.rows[kind]}{' '}
                  <span className="text-xs font-normal text-stone-500">
                    · {t.stage[stageOf(kind)]}
                  </span>
                </legend>
                <label className="flex min-w-0 flex-col gap-1">
                  <span className={labelClass}>{t.item}</span>
                  <select
                    value={row.itemCode}
                    onChange={(e) =>
                      setRow(kind, {
                        itemCode: e.target.value,
                        quantity: kind === 'NEW_BOTTLE' ? '1' : row.quantity,
                      })
                    }
                    className={fieldClass(false)}
                    aria-label={`${t.rows[kind]} – ${t.item}`}
                  >
                    <option value="">{t.choose}</option>
                    {list.map((c) => (
                      <option key={c.code} value={c.code}>
                        {c.name} ({c.code}){c.archived ? ` – ${catalogCs.components.archived}` : ''}
                      </option>
                    ))}
                  </select>
                  {list.length === 0 && (
                    <span className="text-xs text-amber-800">{t.nothingToChoose}</span>
                  )}
                </label>
                <label className="flex min-w-0 flex-col gap-1">
                  <span className={labelClass}>{t.quantity}</span>
                  {kind === 'NEW_BOTTLE' ? (
                    <>
                      <input
                        value="1"
                        disabled
                        className={fieldClass(false)}
                        aria-label={`${t.rows[kind]} – ${t.quantity}`}
                      />
                      <span className="text-xs text-stone-500">{t.bottleFixed}</span>
                    </>
                  ) : (
                    <input
                      inputMode="decimal"
                      value={row.quantity}
                      disabled={!row.itemCode}
                      onChange={(e) => setRow(kind, { quantity: e.target.value })}
                      aria-invalid={!!errors[kind]}
                      aria-label={`${t.rows[kind]} – ${t.quantity}`}
                      className={fieldClass(!!errors[kind])}
                    />
                  )}
                  {errors[kind] && (
                    <span className="text-xs font-medium text-red-700">{errors[kind]}</span>
                  )}
                </label>
                <div className="flex min-w-0 flex-col gap-1">
                  <span className={labelClass}>{t.unit}</span>
                  <span className="py-2 text-sm" data-testid={`unit-${kind}`}>
                    {item ? unitCs(item.unit.code) : '—'}
                  </span>
                </div>
              </fieldset>
            );
          })}
          <label className="flex min-w-0 flex-col gap-1">
            <span className={labelClass}>{t.crate}</span>
            <select
              value={draft.crateTypeCode}
              onChange={(e) => {
                setSaved(false);
                setDraft((d) => ({ ...d, crateTypeCode: e.target.value }));
              }}
              className={fieldClass(false)}
            >
              <option value="">{t.crateNone}</option>
              {crates.map((c) => (
                <option key={c.code} value={c.code}>
                  {c.name} ({c.code}) – {catalogCs.crateTypes.capacity.toLowerCase()} {c.capacity}
                </option>
              ))}
            </select>
            {crates.length === 0 && (
              <span className="text-xs text-amber-800">{t.crateNothing}</span>
            )}
          </label>
        </div>
        <p className="rounded-md bg-stone-50 p-3 text-xs text-stone-600">{t.stageNote}</p>

        <section
          className="flex flex-col gap-2 rounded-md bg-stone-50 p-3 text-sm"
          aria-labelledby={f('summary')}
          data-testid="recipe-summary"
        >
          <h3 id={f('summary')} className={labelClass}>
            {t.summary}
          </h3>
          {changes.length === 0 ? (
            <p className="text-stone-500">{t.noChanges}</p>
          ) : (
            <ul className="list-disc pl-5">
              {changes.map((c) => (
                <li key={c} className="wrap-anywhere">
                  {c}
                </li>
              ))}
            </ul>
          )}
        </section>
        <ReasonField
          id={f('reason')}
          value={reason}
          onChange={setReason}
          error={errors.reason}
          label={catalogCs.common.reason}
        />
        <ErrorSummary errors={errors} formError={formError} />
        {saved && <SuccessNote>{t.saved}</SuccessNote>}
        <p className="text-xs text-stone-500">{t.concurrencyNote}</p>
        <div className="flex flex-wrap gap-2">
          <button type="submit" disabled={busy} className={buttonClass.primary}>
            {busy ? catalogCs.common.saving : t.save}
          </button>
          {dirty && (
            <button
              type="button"
              className={buttonClass.secondary}
              onClick={() => {
                setDraft(initial);
                setReason('');
                setErrors({});
                setFormError(null);
              }}
            >
              {shellCs.unsaved.discard}
            </button>
          )}
        </div>
      </form>
    </Card>
  );
}
