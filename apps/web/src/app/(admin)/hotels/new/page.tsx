import { fulfillmentSiteOptionSchema } from '@ayvo/types';
import { z } from 'zod';
import { HotelForm } from '@/components/hotels/hotel-form';
import { HotelsHeader } from '@/components/hotels/hotels-header';
import { Notice } from '@/components/ui';
import { hotelsCs as t } from '@/i18n/cs/hotels';
import { apiGet } from '@/lib/api';
import { requirePermission } from '@/lib/session';

export const dynamic = 'force-dynamic';

export default async function NewHotelPage() {
  await requirePermission('hotels:manage');
  const sites = await apiGet(
    'admin/hotels/fulfillment-sites',
    z.array(fulfillmentSiteOptionSchema),
  );
  return (
    <>
      <HotelsHeader
        active="new"
        title={t.form.title}
        subtitle={t.form.subtitle}
        back={{ href: '/hotels', label: t.title }}
      />
      {sites.length === 0 && <Notice tone="warning">{t.form.noSites}</Notice>}
      <HotelForm sites={sites} />
    </>
  );
}
