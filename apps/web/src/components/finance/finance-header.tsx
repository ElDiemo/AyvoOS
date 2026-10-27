import { ModuleHeader } from '@/components/shell/module-header';
import type { FinancePageId } from '@/lib/navigation';

/**
 * Finance pages (UI-01): the module's own navigation — Doklady, Export pro účetní, Bankovní
 * pohyby, Naše firma a účty, each shown only with its permission — above the page title, like
 * Obchod or Hotely. Every page and the API still check the permission themselves.
 */
export function FinanceHeader(props: {
  active: FinancePageId;
  title: React.ReactNode;
  subtitle?: React.ReactNode;
  back?: { href: string; label: string };
  actions?: React.ReactNode;
}) {
  return <ModuleHeader module="finance" {...props} />;
}
