import { hotelSummarySchema } from '@ayvo/types';
import Link from 'next/link';
import { z } from 'zod';
import { RowValue } from '@/components/catalog/catalog-header';
import { HotelsHeader } from '@/components/hotels/hotels-header';
import { buttonClass, Card, EmptyState } from '@/components/ui';
import { hotelsCs as t } from '@/i18n/cs/hotels';
import { apiGet } from '@/lib/api';
import { currentUser, hasPermission } from '@/lib/session';

export const dynamic = 'force-dynamic';

/** Hotely (doc 028): every hotel with its city, country and serving site. */
export default async function HotelsPage() {
  const [me, hotels] = await Promise.all([
    currentUser(),
    apiGet('admin/hotels', z.array(hotelSummarySchema)),
  ]);
  return (
    <>
      <HotelsHeader
        active="list"
        title={t.title}
        subtitle={t.subtitle}
        actions={
          hasPermission(me, 'hotels:manage') && (
            <Link href="/hotels/new" className={buttonClass.primary}>
              {t.newHotel}
            </Link>
          )
        }
      />
      <Card>
        {hotels.length === 0 ? (
          <EmptyState>{t.empty}</EmptyState>
        ) : (
          <ul data-testid="hotels">
            {hotels.map((h) => (
              <li
                key={h.code}
                data-testid={`hotel-${h.code}`}
                className="grid grid-cols-1 gap-x-4 gap-y-1 border-t border-stone-100 py-3 text-sm first:border-t-0 md:grid-cols-[minmax(0,1.5fr)_6rem_minmax(0,1fr)_4rem_minmax(0,1fr)] md:items-center"
              >
                <Link
                  href={`/hotels/${h.code}`}
                  className="font-medium underline-offset-2 hover:underline"
                >
                  {h.name}
                </Link>
                <RowValue label={t.columns.code}>
                  <span className="font-mono">{h.code}</span>
                </RowValue>
                <RowValue label={t.columns.city}>{h.city}</RowValue>
                <RowValue label={t.columns.country}>{h.countryCode}</RowValue>
                <RowValue label={t.columns.site}>
                  {h.fulfillmentSite.name} ({h.fulfillmentSite.code})
                </RowValue>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </>
  );
}
