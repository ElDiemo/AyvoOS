/**
 * Units of weights and dimensions (doc 025 §10, W1): stored as exact grams (decimal strings, up to
 * 3 decimals) and whole millimetres; shown in units people read (g for small masses, kg for
 * crates, mm with cm). All conversions are decimal-string arithmetic — never floating point.
 */

/** "1,85" or "1.85" → "1.85"; null for anything that is not a plain positive decimal. */
export function parseDecimal(input: string, maxDecimals: number): string | null {
  const v = input.trim().replace(/\s/g, '').replace(',', '.');
  const m = new RegExp(`^(\\d{1,9})(?:\\.(\\d{1,${maxDecimals}}))?$`).exec(v);
  if (!m) return null;
  const whole = m[1]!.replace(/^0+(?=\d)/, '');
  const frac = (m[2] ?? '').replace(/0+$/, '');
  const out = frac ? `${whole}.${frac}` : whole;
  return /^0(\.0*)?$/.test(out) ? null : out;
}

/** Exact kilograms → grams: "1.85" → "1850", "0.0125" → "12.5" (up to 6 kg decimals). */
export function kgToG(kg: string): string | null {
  const v = parseDecimal(kg, 6);
  if (!v) return null;
  const [whole, frac = ''] = v.split('.');
  const padded = frac.padEnd(6, '0');
  const g = `${whole}${padded.slice(0, 3)}`.replace(/^0+(?=\d)/, '');
  const rest = padded.slice(3).replace(/0+$/, '');
  return rest ? `${g}.${rest}` : g;
}

/** Exact grams → kilograms string: "1850" → "1.85", "450.25" → "0.45025". */
export function gToKg(g: string): string {
  const [whole, frac = ''] = g.split('.');
  const digits = whole!.padStart(4, '0');
  const kgWhole = digits.slice(0, -3).replace(/^0+(?=\d)/, '');
  const kgFrac = `${digits.slice(-3)}${frac}`.replace(/0+$/, '');
  return kgFrac ? `${kgWhole}.${kgFrac}` : kgWhole;
}

const cs = (v: string) => v.replace('.', ',');

/** A mass for people: below 1 kg in g ("372,5 g"), from 1 kg in kg ("2,595 kg"). */
export function formatMass(g: string | null): string | null {
  if (g === null) return null;
  const whole = g.split('.')[0]!;
  return whole.length >= 4 ? `${cs(gToKg(g))} kg` : `${cs(g)} g`;
}

/** Outer dimensions: "600 × 400 × 300 mm (60 × 40 × 30 cm)". */
export function formatDimensions(l: number, w: number, h: number): string {
  const cm = (mm: number) => cs(String(mm / 10));
  return `${l} × ${w} × ${h} mm (${cm(l)} × ${cm(w)} × ${cm(h)} cm)`;
}
