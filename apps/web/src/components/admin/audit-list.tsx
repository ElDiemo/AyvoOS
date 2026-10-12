import type { AuditEvent } from '@ayvo/types';
import { formatDateTimeCs } from '@/i18n/cs/format';
import { identityCs } from '@/i18n/cs/identity';

const t = identityCs.admin;

/** The append-only audit of a user, role or site: what, who, when, where and why. */
export function AuditList({ events, testId }: { events: readonly AuditEvent[]; testId: string }) {
  if (events.length === 0) return <p className="text-sm text-stone-500">{t.noAudit}</p>;
  return (
    <ol className="flex flex-col divide-y divide-stone-100 text-sm" data-testid={testId}>
      {events.map((a) => (
        <li key={a.id} className="py-2">
          <span className="font-medium">{t.auditTypes[a.type] ?? a.type}</span>
          {typeof a.details.role === 'string' && ` · ${a.details.role}`}
          {typeof a.details.site === 'string' && ` · ${a.details.site}`}
          {typeof a.details.warehouse === 'string' && ` · ${a.details.warehouse}`}
          <span className="block text-xs wrap-anywhere text-stone-500">
            {formatDateTimeCs(a.occurredAt)}
            {a.actor ? ` · ${a.actor}` : ''}
            {a.site && typeof a.details.site !== 'string' ? ` · ${a.site}` : ''}
            {a.reason ? ` · ${a.reason}` : ''}
          </span>
        </li>
      ))}
    </ol>
  );
}
