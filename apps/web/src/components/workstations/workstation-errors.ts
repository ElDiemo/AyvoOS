import { workstationsCs } from '@/i18n/cs/workstations';
import { ClientApiError } from '@/lib/client-api';

/** Czech text of an API error: the stable code first, never raw server details. */
export function workstationErrorText(error: unknown): string {
  if (error instanceof ClientApiError) {
    if (error.code && workstationsCs.errors[error.code]) return workstationsCs.errors[error.code]!;
    if (error.status === 403) return workstationsCs.errors.FORBIDDEN!;
    if (error.status === 400 || error.status === 422) return workstationsCs.invalid;
    if (error.status < 500) return workstationsCs.failed;
  }
  return workstationsCs.network;
}
