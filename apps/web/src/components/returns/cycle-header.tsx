import { ProductionHeader } from '@/components/production/production-header';
import { ViewSwitch } from '@/components/shell/module-header';
import { returnsCs } from '@/i18n/cs/returns';

const c = returnsCs.cycle;
const VIEWS = [
  { id: 'overview', href: '/production/cycle', label: c.view.overview },
  { id: 'returns', href: '/production/cycle/returns', label: c.view.returns },
  { id: 'after-wash', href: '/production/cycle/after-wash', label: c.view.afterWash },
] as const;

/**
 * Header of Výroba → Oběh lahví (owner 2026-11-09): the module navigation and the three views of
 * the cycle — Přehled, Příjem vratek, Po mytí — so every screen says where the user is and where
 * the next step is. All of them need returns:receive (as the API does).
 */
export function CycleHeader({
  active,
  title,
  subtitle,
  back,
  actions,
}: {
  active: (typeof VIEWS)[number]['id'];
  title: React.ReactNode;
  subtitle?: React.ReactNode;
  back?: { href: string; label: string };
  actions?: React.ReactNode;
}) {
  return (
    <>
      <ProductionHeader
        active="cycle"
        title={title}
        subtitle={subtitle}
        back={back}
        actions={actions}
      />
      <ViewSwitch label={c.views} views={VIEWS} active={active} />
    </>
  );
}
