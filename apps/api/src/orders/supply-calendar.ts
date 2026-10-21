/**
 * The calendar of a supply plan (doc 032) — pure date arithmetic on local calendar days
 * (YYYY-MM-DD) of the serving site. No clock and no time zone here: the caller decides "today"
 * in the site's time zone, so daylight saving changes cannot shift a day.
 */

export interface CalendarRule {
  productCode: string;
  crates: number;
  days: number[];
}

/** One planned ship day: the rules of that day merged — the same product is one line. */
export interface PlannedDay {
  shipDate: string;
  lines: { productCode: string; crates: number }[];
}

const parse = (iso: string): [number, number, number] => {
  const [y, m, d] = iso.split('-').map(Number) as [number, number, number];
  return [y, m, d];
};
const format = (y: number, m: number, d: number) =>
  `${String(y).padStart(4, '0')}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;

/** Days of a month (1–12), leap years included (Gregorian). */
export function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

/** The calendar day `n` days after `iso` (n may be negative). */
export function addDays(iso: string, n: number): string {
  const [y, m, d] = parse(iso);
  const t = new Date(Date.UTC(y, m - 1, d + n));
  return format(t.getUTCFullYear(), t.getUTCMonth() + 1, t.getUTCDate());
}

/**
 * The planned ship days from `from` to `to` (inclusive), limited to the plan's validity. A rule's
 * day that a month lacks (e.g. 31 in November) is not planned that month — never moved — and is
 * reported in `skipped` once per rule, day and month of the window.
 */
export function plannedDays(
  rules: CalendarRule[],
  window: { from: string; to: string },
  validity: { validFrom: string; validTo: string | null },
): {
  days: PlannedDay[];
  skipped: { productCode: string; day: number; month: string }[];
} {
  const from = window.from > validity.validFrom ? window.from : validity.validFrom;
  const to =
    validity.validTo !== null && validity.validTo < window.to ? validity.validTo : window.to;
  const days: PlannedDay[] = [];
  const skipped: { productCode: string; day: number; month: string }[] = [];
  if (from > to) return { days, skipped };
  // Months touched by the window: a day missing in such a month is reported if the month's
  // part inside the window would have contained it (i.e. the window covers the month's end).
  const [fy, fm] = parse(from);
  const [ty, tm] = parse(to);
  for (let y = fy, m = fm; y < ty || (y === ty && m <= tm); m === 12 ? ((m = 1), y++) : m++) {
    const last = daysInMonth(y, m);
    const monthStart = format(y, m, 1);
    const monthEnd = format(y, m, last);
    const lo = monthStart > from ? monthStart : from;
    const hi = monthEnd < to ? monthEnd : to;
    for (const r of rules) {
      for (const day of r.days) {
        if (day > last) {
          // Missing this month: skipped, if the window reaches the end of that month.
          if (hi === monthEnd)
            skipped.push({
              productCode: r.productCode,
              day,
              month: `${y}-${String(m).padStart(2, '0')}`,
            });
          continue;
        }
        const date = format(y, m, day);
        if (date < lo || date > hi) continue;
        let planned = days.find((d) => d.shipDate === date);
        if (!planned) {
          planned = { shipDate: date, lines: [] };
          days.push(planned);
        }
        const line = planned.lines.find((l) => l.productCode === r.productCode);
        if (line) line.crates += r.crates;
        else planned.lines.push({ productCode: r.productCode, crates: r.crates });
      }
    }
  }
  days.sort((a, b) => (a.shipDate < b.shipDate ? -1 : 1));
  return { days, skipped };
}

/** The nearest planned ship day on or after `from` within `maxDays` (null: none). */
export function nextPlannedDay(
  rules: CalendarRule[],
  from: string,
  validity: { validFrom: string; validTo: string | null },
  maxDays = 400,
): string | null {
  const { days } = plannedDays(rules, { from, to: addDays(from, maxDays) }, validity);
  return days[0]?.shipDate ?? null;
}
