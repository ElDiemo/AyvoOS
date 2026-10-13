import {
  REQUIRED_RECIPE_KINDS,
  RECIPE_STAGE_OF_KIND,
  type CatalogComponent,
  type CrateType,
  type RecipeComponentKind,
  type RecipeVersion,
} from '@ayvo/types';
import { formatQuantityCs, unitCs } from '../i18n/cs/format';

/**
 * Pure logic of the catalogue forms (issue #17): exact decimal input, which items a recipe row may
 * use, the request a draft becomes and its Czech change summary. Quantities stay decimal strings
 * from input to the wire — never parseFloat/Number (API totals are the source of truth).
 */

const DECIMAL = /^(0|[1-9]\d{0,15})(\.\d{1,3})?$/;

/**
 * Czech input → exact decimal string, or null. Accepts "330", "0,5", "1 000,25" (spaces and
 * non-breaking spaces as thousands separators); refuses zero, negatives, exponents and more
 * than three decimals instead of rounding.
 */
export function normalizeDecimal(input: string): string | null {
  const value = input
    .trim()
    .replace(/[\s  ]/g, '')
    .replace(',', '.');
  if (!DECIMAL.test(value)) return null;
  if (/^0(\.0+)?$/.test(value)) return null;
  return value;
}

/** Canonical form for comparisons ("330.0" = "330", "0.50" = "0.5"), as the API formats it. */
export function canonicalDecimal(value: string): string {
  return value.includes('.') ? value.replace(/0+$/, '').replace(/\.$/, '') : value;
}

/** Decimal string → Czech input text ("0.5" → "0,5"). */
export function decimalToInput(value: string): string {
  return value.replace('.', ',');
}

export const MAX_BOTTLES = 1_000_000;

/** Number of finished bottles for the calculation: a whole number 1 … 1 000 000, or null. */
export function parseBottles(input: string): number | null {
  const value = input.trim().replace(/[\s  ]/g, '');
  if (!/^[1-9]\d{0,6}$/.test(value)) return null;
  const n = Number(value); // a validated integer string, well below 2^53
  return n <= MAX_BOTTLES ? n : null;
}

/** Items a recipe row of `kind` may use for a product of `category`: right kind, not archived,
 *  made for that category (liquid and label must name it; others may be for every category). */
export function eligibleItems(
  components: readonly CatalogComponent[],
  kind: RecipeComponentKind,
  category: string,
): CatalogComponent[] {
  const needsCategory = kind === 'BULK_LIQUID' || kind === 'LABEL_MEDIA';
  return components.filter(
    (c) =>
      c.kind === kind &&
      !c.archived &&
      (needsCategory ? c.category?.code === category : !c.category || c.category.code === category),
  );
}

export function eligibleCrateTypes(
  crateTypes: readonly CrateType[],
  category: string,
): CrateType[] {
  return crateTypes.filter((t) => t.categories.some((c) => c.code === category));
}

export interface DraftRow {
  itemCode: string;
  /** Czech input text; ignored for the bottle body (always exactly 1). */
  quantity: string;
}

export interface RecipeDraft {
  crateTypeCode: string;
  rows: Record<RecipeComponentKind, DraftRow>;
}

export function draftFromRecipe(recipe: RecipeVersion): RecipeDraft {
  const rows = Object.fromEntries(
    REQUIRED_RECIPE_KINDS.map((kind) => {
      const line = recipe.components.find((c) => c.kind === kind);
      return [
        kind,
        { itemCode: line?.itemCode ?? '', quantity: line ? decimalToInput(line.quantity) : '' },
      ];
    }),
  ) as Record<RecipeComponentKind, DraftRow>;
  return { crateTypeCode: recipe.crateType?.code ?? '', rows };
}

export interface DraftPayload {
  crateTypeCode: string | null;
  components: { itemCode: string; quantity: string; unitCode: string }[];
}

/** The PUT body of a draft, or the rows whose quantity is invalid (nothing is guessed). */
export function draftPayload(
  draft: RecipeDraft,
  components: readonly CatalogComponent[],
): { payload: DraftPayload; invalid: RecipeComponentKind[] } {
  const invalid: RecipeComponentKind[] = [];
  const lines: DraftPayload['components'] = [];
  for (const kind of REQUIRED_RECIPE_KINDS) {
    const row = draft.rows[kind];
    if (!row.itemCode) continue;
    const item = components.find((c) => c.code === row.itemCode);
    const quantity = kind === 'NEW_BOTTLE' ? '1' : normalizeDecimal(row.quantity);
    if (!item || !quantity) {
      invalid.push(kind);
      continue;
    }
    lines.push({ itemCode: item.code, quantity, unitCode: item.unit.code });
  }
  return { payload: { crateTypeCode: draft.crateTypeCode || null, components: lines }, invalid };
}

/** Comparable form of a draft: "item@quantity" per kind, plus the crate type. */
function comparable(draft: RecipeDraft) {
  return {
    crate: draft.crateTypeCode,
    rows: Object.fromEntries(
      REQUIRED_RECIPE_KINDS.map((k) => {
        const r = draft.rows[k];
        const n = normalizeDecimal(r.quantity);
        const q = k === 'NEW_BOTTLE' ? '1' : n ? canonicalDecimal(n) : r.quantity.trim();
        return [k, r.itemCode ? `${r.itemCode}@${q}` : ''];
      }),
    ) as Record<RecipeComponentKind, string>,
  };
}

/** Czech lines "Kapalina: Mýdlo 330 ml → Mýdlo 300 ml" for every changed row (empty = no change). */
export function draftChanges(
  initial: RecipeDraft,
  draft: RecipeDraft,
  components: readonly CatalogComponent[],
  crateTypes: readonly CrateType[],
  labels: { rows: Record<RecipeComponentKind, string>; crate: string; empty: string },
): string[] {
  const a = comparable(initial);
  const b = comparable(draft);
  const describe = (kind: RecipeComponentKind, d: RecipeDraft) => {
    const row = d.rows[kind];
    if (!row.itemCode) return labels.empty;
    const item = components.find((c) => c.code === row.itemCode);
    const q = kind === 'NEW_BOTTLE' ? '1' : normalizeDecimal(row.quantity);
    return `${item?.name ?? row.itemCode} ${q ? formatQuantityCs(q) : row.quantity} ${unitCs(item?.unit.code ?? '')}`.trim();
  };
  const crateName = (code: string) =>
    code ? (crateTypes.find((t) => t.code === code)?.name ?? code) : labels.empty;
  const out: string[] = [];
  for (const kind of REQUIRED_RECIPE_KINDS) {
    if (a.rows[kind] !== b.rows[kind]) {
      out.push(`${labels.rows[kind]}: ${describe(kind, initial)} → ${describe(kind, draft)}`);
    }
  }
  if (a.crate !== b.crate)
    out.push(`${labels.crate}: ${crateName(a.crate)} → ${crateName(b.crate)}`);
  return out;
}

export const stageOf = (kind: RecipeComponentKind) => RECIPE_STAGE_OF_KIND[kind];

/**
 * One user attempt keeps its request id while the request stays the same — so a retry after a
 * network error or a double click continues the same operation on the server (idempotent per
 * request id). Changed data or a definite answer starts a new attempt.
 */
export function attemptId(
  previous: { key: string; id: string } | null,
  key: string,
  newId: () => string,
): { key: string; id: string } {
  return previous && previous.key === key ? previous : { key, id: newId() };
}
