import { SectionTabs } from '@/components/section-tabs';
import { PageHeader } from '@/components/ui';
import { warehouseCs as t } from '@/i18n/cs/warehouse';

const TABS = [
  { id: 'labels', href: '/warehouse/labels', label: t.tabs.labels },
  { id: 'new-receipt', href: '/warehouse/receipts/new', label: t.tabs.newReceipt },
  { id: 'receipts', href: '/warehouse/receipts', label: t.tabs.receipts },
  { id: 'stock', href: '/warehouse/stock', label: t.tabs.stock },
  { id: 'movements', href: '/warehouse/movements', label: t.tabs.movements },
  { id: 'suppliers', href: '/warehouse/suppliers', label: t.tabs.suppliers },
] as const;

export type WarehouseTab = (typeof TABS)[number]['id'];

/** Header of the Czech warehouse section (doc 018 §10): title and the operator workflows. */
export function WarehouseHeader({
  active,
  title,
  subtitle,
  back,
}: {
  active: WarehouseTab;
  title: string;
  subtitle?: React.ReactNode;
  back?: { href: string; label: string };
}) {
  return (
    <>
      <PageHeader title={title} subtitle={subtitle} back={back} />
      <SectionTabs label={t.section} tabs={TABS} active={active} />
    </>
  );
}
