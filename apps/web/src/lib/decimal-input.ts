/**
 * What a person types as an amount ("1 500,50", "1500.5") as the exact decimal string the API takes
 * ("1500.50"). Text only, never a number with a floating point. Anything unclear, such as "1.500" or
 * "1,5,0", or more than `decimals` places, is null: refused, never guessed or rounded.
 */
export function parseDecimalInput(input: string, decimals = 2): string | null {
  const text = input.replace(/[\s ]/g, '');
  const m = /^(\d+)(?:[.,](\d+))?$/.exec(text);
  if (!m) return null;
  const fraction = m[2] ?? '';
  if (fraction.length > decimals) return null;
  return `${m[1]!.replace(/^0+(?=\d)/, '')}.${fraction.padEnd(decimals, '0')}`;
}
