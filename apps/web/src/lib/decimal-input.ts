/**
 * What a person types as an amount ("1 500,50", "1500.5") as the exact decimal string the API takes
 * ("1500.50"). Text only, never a number with a floating point. Spaces only as groups of thousands.
 * Anything unclear, such as "1.500", "1,5,0" or "1 2", or more than `decimals` places, is null:
 * refused, never guessed or rounded.
 */
export function parseDecimalInput(input: string, decimals = 2): string | null {
  const text = input.trim().replace(/[\u00a0\u202f]/g, ' ');
  const m = /^([1-9]\d{0,2}(?: \d{3})+|\d+)(?:[.,](\d+))?$/.exec(text);
  if (!m) return null;
  const fraction = m[2] ?? '';
  if (fraction.length > decimals) return null;
  return `${m[1]!.replace(/ /g, '').replace(/^0+(?=\d)/, '')}.${fraction.padEnd(decimals, '0')}`;
}
