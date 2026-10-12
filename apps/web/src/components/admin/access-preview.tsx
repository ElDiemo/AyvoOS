import {
  PERMISSION_MODULES,
  permissionModule,
  type AccessibleSite,
  type PermissionCode,
} from '@ayvo/types';
import { identityCs } from '@/i18n/cs/identity';

const t = identityCs.admin;
const label = 'text-xs font-medium uppercase tracking-wide text-stone-500';

/**
 * "What the user may do — and where" (doc 021 §7, doc 022): permissions grouped by module and the
 * sites and warehouses they apply to. On a user's page it shows the server's evaluation; in the
 * creation form a preview of the same rules.
 */
export function AccessPreview({
  permissions,
  sites,
  global,
  testId = 'effective-access',
}: {
  permissions: readonly PermissionCode[];
  sites: readonly Pick<
    AccessibleSite,
    'id' | 'code' | 'name' | 'active' | 'warehouses' | 'allWarehouses'
  >[];
  global: boolean;
  testId?: string;
}) {
  const groups = PERMISSION_MODULES.map((module) => ({
    module,
    codes: permissions.filter((p) => permissionModule(p) === module),
  })).filter((g) => g.codes.length > 0);
  return (
    <div className="flex flex-col gap-4 text-sm" data-testid={testId}>
      <div className="flex flex-col gap-2">
        <h3 className={label}>{identityCs.roles_admin.permissions}</h3>
        {groups.length === 0 ? (
          <p className="text-stone-500">{t.effectiveNone}</p>
        ) : (
          <dl className="flex flex-col gap-2">
            {groups.map((g) => (
              <div key={g.module}>
                <dt className="font-medium">{identityCs.modules[g.module]}</dt>
                <dd>
                  <ul className="list-disc pl-5 text-stone-700">
                    {g.codes.map((code) => (
                      <li key={code} data-permission={code}>
                        {identityCs.permissions[code] ?? code}
                      </li>
                    ))}
                  </ul>
                </dd>
              </div>
            ))}
          </dl>
        )}
      </div>
      <div className="flex flex-col gap-2">
        <h3 className={label}>{t.sites}</h3>
        {global ? (
          <p data-testid="global-access">{t.globalAccess}</p>
        ) : sites.length === 0 ? (
          <p className="text-stone-500">{t.noSites}</p>
        ) : (
          <ul className="flex flex-col gap-1">
            {sites.map((s) => (
              <li key={s.id} className="wrap-anywhere" data-site={s.code}>
                <span className="font-medium">{s.name}</span>{' '}
                <span className="font-mono text-xs text-stone-500">{s.code}</span>
                {!s.active && (
                  <span className="ml-1 text-xs text-amber-800">
                    ({identityCs.shell.inactiveSite})
                  </span>
                )}
                <span className="block text-xs text-stone-600">
                  {s.allWarehouses
                    ? t.allWarehouses
                    : s.warehouses.map((w) => `${w.name} (${w.code})`).join(', ')}
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
