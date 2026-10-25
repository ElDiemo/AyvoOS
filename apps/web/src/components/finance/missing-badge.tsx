import type { FinanceExportRequiredField } from '@ayvo/types';
import { financeCs as t } from '@/i18n/cs/finance';

/** "K doplnění" with what the export still needs (nothing when complete). */
export function MissingBadge({ missing }: { missing: readonly FinanceExportRequiredField[] }) {
  if (missing.length === 0) return null;
  const list = missing.map((m) => t.missing.fields[m]).join(', ');
  return (
    <span
      className="ml-1 inline-block rounded bg-amber-100 px-1.5 py-0.5 text-xs font-medium text-amber-900"
      title={t.missing.note(list)}
      data-testid="finance-missing"
    >
      {t.missing.label}
    </span>
  );
}
