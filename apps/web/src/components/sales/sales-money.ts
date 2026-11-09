/** Exact money of Obchod's indicative price: hundredths as BigInt, never a float. */

/** "320.00" → 32000n. */
export function cents(amount: string): bigint {
  const [whole, frac = ''] = amount.split('.');
  return BigInt(whole!) * 100n + BigInt((frac + '00').slice(0, 2));
}

/** 1234567n hundredths → "12 345,67" (Czech grouping, exact). */
export function formatCents(v: bigint): string {
  const whole = (v / 100n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
  return `${whole},${(v % 100n).toString().padStart(2, '0')}`;
}
