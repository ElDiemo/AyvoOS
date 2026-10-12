import { Card, Notice, PageHeader } from '@/components/ui';
import { SelectSiteButton } from '@/components/shell/select-site-button';
import { identityCs } from '@/i18n/cs/identity';
import { currentUser } from '@/lib/session';

export const dynamic = 'force-dynamic';
const t = identityCs.selectSite;

const safeNext = (next: string | undefined) =>
  next && next.startsWith('/') && !next.startsWith('//') && !next.includes('\\') ? next : '/';

/** Choose the active site (several sites, none chosen, or the chosen one has no warehouse). */
export default async function SelectSitePage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string; reason?: string }>;
}) {
  const { next, reason } = await searchParams;
  const user = await currentUser();
  return (
    <>
      <PageHeader title={t.title} subtitle={t.text} />
      <div className="flex max-w-2xl flex-col gap-4">
        {reason === 'no-warehouse' && <Notice tone="warning">{t.noWarehouse}</Notice>}
        {reason === 'no-production' && <Notice tone="warning">{t.noProduction}</Notice>}
        {user.sites.length === 0 ? (
          <Notice tone="info">{t.none}</Notice>
        ) : (
          <ul className="flex flex-col gap-3" data-testid="site-choices">
            {user.sites.map((s) => (
              <li key={s.id}>
                <Card>
                  <div className="flex flex-wrap items-center justify-between gap-3">
                    <div className="min-w-0">
                      <p className="font-medium wrap-anywhere">{s.name}</p>
                      <p className="font-mono text-xs text-stone-500">
                        {s.code} · {s.countryCode} · {s.timeZone}
                        {!s.active && ` · ${t.inactive}`}
                      </p>
                    </div>
                    {s.id === user.activeSiteId ? (
                      <span className="text-sm text-stone-500">{t.current}</span>
                    ) : (
                      <SelectSiteButton siteId={s.id} next={safeNext(next)} label={t.choose} />
                    )}
                  </div>
                </Card>
              </li>
            ))}
          </ul>
        )}
      </div>
    </>
  );
}
