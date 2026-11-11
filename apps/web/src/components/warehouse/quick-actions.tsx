import type { CurrentUser, PermissionCode } from '@ayvo/types';
import { cn } from '@ayvo/ui';
import Link from 'next/link';
import { warehouseCs } from '@/i18n/cs/warehouse';
import { hasPermission } from '@/lib/session';

const q = warehouseCs.overview.quick;

/** The daily work of the warehouse, each opening its existing page; the page checks again. */
const ACTIONS: {
  id: string;
  href: string;
  permission: PermissionCode;
  label: string;
  hint: string;
}[] = [
  { id: 'returns', href: '/warehouse/returns', permission: 'returns:receive', ...q.returns },
  {
    id: 'after-wash',
    href: '/warehouse/after-wash',
    permission: 'returns:receive',
    ...q.afterWash,
  },
  { id: 'goods', href: '/warehouse/receipts/new', permission: 'inventory:receive', ...q.goods },
];

/**
 * Sklad → rychlé akce (UX handoff 2026-11-07): the three daily starts on top of the overview,
 * shown only to whom may open them (the same permission as the page and its API). Plain links in
 * reading order, so the keyboard reaches them first; nothing is read or written here.
 */
export function WarehouseQuickActions({ user }: { user: CurrentUser }) {
  const shown = ACTIONS.filter((a) => hasPermission(user, a.permission));
  if (shown.length === 0) return null;
  return (
    <nav aria-label={q.title} data-testid="quick-actions">
      <ul className="grid grid-cols-1 gap-2 sm:grid-cols-3 sm:gap-3">
        {shown.map((a, i) => (
          <li key={a.id}>
            <Link
              href={a.href}
              data-testid={`quick-${a.id}`}
              className={cn(
                'flex min-h-11 h-full flex-col justify-center gap-0.5 rounded-lg border px-4 py-3 shadow-sm transition outline-none focus-visible:ring-2 focus-visible:ring-stone-500 focus-visible:ring-offset-2 sm:min-h-24 sm:justify-start sm:gap-1',
                i === 0
                  ? 'border-transparent bg-stone-900 text-white hover:bg-stone-700'
                  : 'border-stone-200 bg-white text-stone-900 hover:bg-stone-50',
              )}
            >
              <span className="text-base font-semibold">{a.label}</span>
              <span className={cn('text-sm', i === 0 ? 'text-stone-200' : 'text-stone-600')}>
                {a.hint}
              </span>
            </Link>
          </li>
        ))}
      </ul>
    </nav>
  );
}
