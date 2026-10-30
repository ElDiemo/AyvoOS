import { ModuleNav, ViewSwitch } from '@/components/shell/module-header';
import { PageHeader } from '@/components/ui';
import { shellCs } from '@/i18n/cs/shell';
import { visibleModules, type FinancePageId, type FinanceViewId } from '@/lib/navigation';
import { currentUser } from '@/lib/session';

/**
 * Finance pages (doc 042): the module's own navigation — Přehled, Faktury hotelům, Přijaté
 * doklady, Banka a platby, Pro účetní, the settings apart — above the page title. Faktury hotelům
 * and Banka a platby show their views (Faktury · Smlouvy, Pohyby z banky · Platby a
 * přiřazení) as tabs, each only with its permission. Every page and the API still check the
 * permission themselves.
 */
export async function FinanceHeader({
  active,
  view,
  ...props
}: {
  active: FinancePageId;
  /** The view of a page with views (`active` = invoices or bank). */
  view?: FinanceViewId;
  title: React.ReactNode;
  subtitle?: React.ReactNode;
  back?: { href: string; label: string };
  actions?: React.ReactNode;
}) {
  const page = visibleModules((await currentUser()).permissions)
    .find((m) => m.id === 'finance')
    ?.pages.find((p) => p.id === active);
  const views = view ? (page?.views ?? []) : [];
  return (
    <>
      <ModuleNav module="finance" active={active} />
      {views.length > 1 && (
        <ViewSwitch label={shellCs.modules.finance.viewsLabel} views={views} active={view!} />
      )}
      <PageHeader {...props} />
    </>
  );
}
