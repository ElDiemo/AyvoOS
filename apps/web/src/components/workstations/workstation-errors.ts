import { workstationsCs } from '@/i18n/cs/workstations';
import { ClientApiError } from '@/lib/client-api';

/** The Czech texts one screen answers API errors with. */
export interface StationErrorTexts {
  /** Per stable code; FORBIDDEN also answers a 403 without a known code. */
  errors: Record<string, string | undefined>;
  /** A 400/422 without a known code; without it such a refusal is `failed`. */
  invalid?: string;
  /** A 404 without a known code; without it such a refusal is `failed`. */
  notFound?: string;
  /** Any other refusal (< 500). */
  failed: string;
  /** No answer or a 5xx: the result is not known. */
  network: string;
}

/**
 * Czech text of an API error: the stable code first, then the status, never raw server details
 * (docs/002 principle 14). `special` answers a code that needs its details (e.g. a crate code).
 */
export function stationErrorText(
  error: unknown,
  texts: StationErrorTexts,
  special?: (error: ClientApiError) => string | undefined,
): string {
  if (error instanceof ClientApiError) {
    const own = special?.(error);
    if (own) return own;
    if (error.code && texts.errors[error.code]) return texts.errors[error.code]!;
    if (error.status === 403 && texts.errors.FORBIDDEN) return texts.errors.FORBIDDEN;
    if (error.status === 404 && texts.notFound) return texts.notFound;
    if ((error.status === 400 || error.status === 422) && texts.invalid) return texts.invalid;
    if (error.status < 500) return texts.failed;
  }
  return texts.network;
}

/** Czech text of an API error on the workstation screens (Správa pracovišť and the station). */
export function workstationErrorText(error: unknown): string {
  return stationErrorText(error, workstationsCs);
}
