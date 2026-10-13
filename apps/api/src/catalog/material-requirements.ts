import type { MaterialRequirements, RecipeComponent } from '@ayvo/types';
import { formatQuantity, quantity } from '../common/quantity.js';

/** Largest magnitude a NUMERIC(19,3) quantity can hold; beyond it a total is not representable. */
const QUANTITY_LIMIT = quantity('1e16');

/** A total that would not fit an exact stock quantity (NUMERIC(19,3)). */
export class RequirementTooLargeError extends RangeError {}

export interface RequirementInput {
  /** The recipe's lines: quantities per ONE finished bottle (exact decimal strings). */
  components: readonly RecipeComponent[];
  crateType: { code: string; name: string; capacity: number };
  bottles: number;
}

/**
 * Material needed for `bottles` finished bottles of one recipe version (doc 023 §5). Pure and
 * exact: every component quantity is multiplied as a decimal (never a float), and crates are
 * counted by the crate type's capacity, rounded UP — 41 bottles in crates of 40 need 2 crates,
 * the second holding 1 bottle. Reads and writes nothing: no stock is reserved or consumed.
 */
export function materialRequirements(
  input: RequirementInput,
): Pick<MaterialRequirements, 'bottles' | 'components' | 'crates'> {
  const { bottles, crateType } = input;
  if (!Number.isSafeInteger(bottles) || bottles < 1) {
    throw new RangeError('bottles must be a positive integer');
  }
  if (!Number.isSafeInteger(crateType.capacity) || crateType.capacity < 1) {
    throw new RangeError('crate capacity must be a positive integer');
  }
  const full = Math.floor(bottles / crateType.capacity);
  const partialCrateBottles = bottles % crateType.capacity;
  return {
    bottles,
    components: input.components.map((c) => {
      // decimal.js keeps 20 significant digits: any total below 10^16 with at most 3 decimals is
      // exact, and a rounded total can never fall below the limit, so this check is sound.
      const total = quantity(c.quantity).mul(bottles);
      if (total.abs().gte(QUANTITY_LIMIT)) {
        throw new RequirementTooLargeError(`total of ${c.itemCode} exceeds an exact quantity`);
      }
      return { ...c, totalQuantity: formatQuantity(total) };
    }),
    crates: {
      crateType: { code: crateType.code, name: crateType.name, capacity: crateType.capacity },
      count: full + (partialCrateBottles > 0 ? 1 : 0),
      full,
      partialCrateBottles,
    },
  };
}
