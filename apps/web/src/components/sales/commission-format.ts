import type { HotelTermsBinding } from '@ayvo/types';
import { commissionsCs } from '@/i18n/cs/commissions';

/** 'YYYY-MM' → '6/2027'. */
export const monthCs = (month: string) => {
  const [y, m] = month.split('-');
  return `${Number(m)}/${y}`;
};

/** A rate '20.00' → '20,00'. */
export const rateCs = (rate: string) => rate.replace('.', ',');

/** The bound rates in one line, or null when the caller may not read them. */
export function termsLine(b: HotelTermsBinding): string | null {
  if (b.initialRate === null || b.maintenanceRate === null || b.initialMonths === null) return null;
  return commissionsCs.terms(rateCs(b.initialRate), b.initialMonths, rateCs(b.maintenanceRate));
}
