import { cratesCs } from '@/i18n/cs/crates';
import { ClientApiError } from '@/lib/client-api';
import { uncertain } from '@/components/catalog/form-kit';

/** Czech text of an API error: the stable code first, never raw server details. */
export function crateErrorText(error: unknown): string {
  if (error instanceof ClientApiError) {
    if (error.code && cratesCs.errors[error.code]) return cratesCs.errors[error.code]!;
    if (error.status === 403) return cratesCs.errors.FORBIDDEN!;
    if (error.status === 404) return cratesCs.errors.CRATE_NOT_FOUND!;
    if (error.status === 400 || error.status === 422) return cratesCs.invalidData;
    if (uncertain(error)) return cratesCs.networkRetry;
    return cratesCs.failed;
  }
  return cratesCs.networkRetry;
}

/** A whole number of millimetres within the label bounds, else null. */
export function parseMm(value: string, min: number, max: number): number | null {
  const v = value.trim();
  if (!/^\d{1,3}$/.test(v)) return null;
  const n = Number(v);
  return n >= min && n <= max ? n : null;
}
