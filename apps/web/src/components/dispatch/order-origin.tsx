import { ordersCs as t } from '@/i18n/cs/orders';

/** "Ručně vytvořená" / "Z plánu zásobování" (doc 032) — the same workflow either way. */
export function OriginBadge({ origin }: { origin: string }) {
  return (
    <span
      className={
        origin === 'SUPPLY_PLAN'
          ? 'rounded border border-violet-300 bg-violet-50 px-1.5 py-0.5 text-[11px] font-medium text-violet-900'
          : 'text-[11px] text-stone-500'
      }
      data-testid="order-origin"
      data-origin={origin}
    >
      {t.origin[origin]}
    </span>
  );
}
