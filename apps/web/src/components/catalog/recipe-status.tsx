import type { RecipeStatus } from '@ayvo/types';
import { cn } from '@ayvo/ui';
import { catalogCs } from '@/i18n/cs/catalog';

const TONE: Record<RecipeStatus, string> = {
  DRAFT: 'bg-amber-100 text-amber-900',
  ACTIVE: 'bg-emerald-100 text-emerald-900',
  ARCHIVED: 'bg-stone-200 text-stone-700',
};

/** Koncept / Aktivní / Archivovaná — colour for meaning only. */
export function RecipeStatusBadge({ status }: { status: RecipeStatus }) {
  return (
    <span
      className={cn('rounded-full px-2 py-0.5 text-xs font-medium', TONE[status])}
      data-status={status}
    >
      {catalogCs.status[status]}
    </span>
  );
}
