import { carrierConnectionAdminSchema } from '@ayvo/types';
import { z } from 'zod';
import { AdminHeader } from '@/components/admin/admin-header';
import { CarrierConnections } from '@/components/admin/carrier-connections';
import { carriersCs } from '@/i18n/cs/carriers';
import { apiGet } from '@/lib/api';

export const dynamic = 'force-dynamic';
const t = carriersCs.connections;

/** Správa systému → Dopravci (ADR 0027): connections and write-only credentials, ADMIN only. */
export default async function CarrierConnectionsPage() {
  const connections = await apiGet(
    'admin/carrier-connections',
    z.array(carrierConnectionAdminSchema),
  );
  return (
    <>
      <AdminHeader active="carriers" title={t.title} subtitle={t.subtitle} />
      <CarrierConnections initial={connections} />
    </>
  );
}
