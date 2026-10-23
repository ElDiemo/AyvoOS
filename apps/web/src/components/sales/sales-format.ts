import { SALES_TIME_ZONE, type ProspectStage } from '@ayvo/types';
import { formatDateCs, formatDateTimeCs } from '../../i18n/cs/format';
import { salesCs as t } from '../../i18n/cs/sales';
import { ClientApiError } from '../../lib/client-api';

/** A timestamp of Obchod, always in the sales time zone (doc 034 §6) — never the device's. */
export const salesDateTime = (iso: string | null | undefined) =>
  formatDateTimeCs(iso, SALES_TIME_ZONE);

/** "dnes", "zítra", a date, or "po termínu (…)" — against the server's today in that zone. */
export function dueLabel(
  dueOn: string,
  today: string,
): { text: string; tone: 'overdue' | 'today' | 'later' } {
  if (dueOn < today) return { text: t.due.overdue(formatDateCs(dueOn)), tone: 'overdue' };
  if (dueOn === today) return { text: t.due.today, tone: 'today' };
  const tomorrow = new Date(`${today}T00:00:00Z`);
  tomorrow.setUTCDate(tomorrow.getUTCDate() + 1);
  if (dueOn === tomorrow.toISOString().slice(0, 10)) return { text: t.due.tomorrow, tone: 'later' };
  return { text: formatDateCs(dueOn), tone: 'later' };
}

export const dueClass = {
  overdue: 'font-medium text-red-700',
  today: 'font-medium text-amber-800',
  later: 'text-stone-700',
} as const;

export const stageClass: Record<ProspectStage, string> = {
  NEW: 'bg-stone-100 text-stone-700',
  CONTACTED: 'bg-sky-50 text-sky-800',
  NEGOTIATION: 'bg-indigo-50 text-indigo-800',
  OFFER: 'bg-amber-50 text-amber-900',
  WON: 'bg-emerald-50 text-emerald-800',
  LOST: 'bg-stone-200 text-stone-600',
};

/** Now as a wall-clock time of the sales zone ("YYYY-MM-DDTHH:mm") for a datetime-local field. */
export function salesNowLocal(now = new Date()): string {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-GB', {
      timeZone: SALES_TIME_ZONE,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    })
      .formatToParts(now)
      .map((p) => [p.type, p.value]),
  );
  return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}`;
}

/** An instant from the API as the wall-clock time of the sales zone (to edit it). */
export const salesLocalOf = (iso: string) => salesNowLocal(new Date(iso));

/** Czech text of an API error: the stable code first, never raw server details. */
export function salesErrorText(error: unknown): string {
  if (error instanceof ClientApiError) {
    if (error.code && t.errors[error.code]) return t.errors[error.code]!;
    if (error.status === 403) return t.errors.FORBIDDEN!;
    if (error.status === 404) return t.notFound;
    if (error.status === 400 || error.status === 422) return t.invalid;
    if (error.status >= 500) return t.network;
    return t.failed;
  }
  return t.network;
}

/** A refusal because somebody changed the record meanwhile: reload, keep the input. */
export const isStale = (error: unknown) =>
  error instanceof ClientApiError &&
  [
    'PROSPECT_CHANGED',
    'CONTACT_CHANGED',
    'TASK_CHANGED',
    'TASK_CLOSED',
    'ACTIVITY_ALREADY_CORRECTED',
    'PROSPECT_ARCHIVED',
    'PROSPECT_HAS_OPEN_TASKS',
  ].includes(error.code ?? '');
