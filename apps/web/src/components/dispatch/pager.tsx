import Link from 'next/link';
import { buttonClass } from '@/components/ui';
import { ordersCs as t } from '@/i18n/cs/orders';

/** Previous / next pages of a list; every record stays reachable (doc 028, no silent limit). */
export function Pager({
  page,
  pageSize,
  total,
  href,
}: {
  page: number;
  pageSize: number;
  total: number;
  href: (page: number) => string;
}) {
  const pages = Math.max(1, Math.ceil(total / pageSize));
  if (pages <= 1) return null;
  return (
    <nav
      className="mt-4 flex items-center justify-between text-sm"
      aria-label={t.page(page, pages)}
      data-testid="pager"
    >
      {page > 1 ? (
        <Link href={href(page - 1)} className={buttonClass.secondary}>
          {t.previous}
        </Link>
      ) : (
        <span />
      )}
      <span className="text-stone-600">{t.page(page, pages)}</span>
      {page < pages ? (
        <Link href={href(page + 1)} className={buttonClass.secondary} data-testid="pager-next">
          {t.next}
        </Link>
      ) : (
        <span />
      )}
    </nav>
  );
}
