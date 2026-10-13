'use client';

import type { CurrentUser } from '@ayvo/types';
import { cn } from '@ayvo/ui';
import { useState } from 'react';
import { identityCs } from '@/i18n/cs/identity';
import { apiSend } from '@/lib/client-api';
import { confirmLeave } from '@/lib/leave-guard';
import { z } from 'zod';

const t = identityCs.shell;

/**
 * Chooses the site this session works at (doc 022). Always visible in the shell. The server
 * validates the choice; afterwards the page reloads completely and browser-held station state is
 * cleared, so nothing of the previous site stays on screen. Unsaved form changes are confirmed
 * first (the reload would lose them).
 */
export async function selectSite(siteId: string, next?: string): Promise<boolean> {
  // A form with unsaved changes asks first (issue #11, UI-01); "continue editing" keeps the site.
  if (!(await confirmLeave())) return false;
  await apiSend('POST', 'auth/active-site', z.object({ activeSiteId: z.uuid() }), { siteId });
  try {
    sessionStorage.clear();
  } catch {
    // storage unavailable: nothing to clear
  }
  window.location.assign(next ?? window.location.pathname + window.location.search);
  return true;
}

export function SiteSwitcher({ user, className }: { user: CurrentUser; className?: string }) {
  const [busy, setBusy] = useState(false);
  const active = user.sites.find((s) => s.id === user.activeSiteId) ?? null;
  if (user.sites.length === 0) return null;
  if (user.sites.length === 1) {
    return (
      <span
        className={cn('max-w-40 truncate rounded-md bg-stone-100 px-2 py-1 text-sm', className)}
        title={`${t.site}: ${user.sites[0]!.name}`}
        data-testid="active-site"
      >
        {user.sites[0]!.code}
      </span>
    );
  }
  return (
    <label className={cn('flex min-w-0 items-center gap-2 text-sm', className)}>
      <span className="sr-only">{t.switchSite}</span>
      <select
        data-testid="site-switcher"
        aria-label={t.switchSite}
        disabled={busy}
        value={active?.id ?? ''}
        onChange={async (e) => {
          if (!e.target.value) return;
          setBusy(true);
          try {
            await selectSite(e.target.value);
          } finally {
            setBusy(false);
          }
        }}
        className={cn(
          'max-w-44 truncate rounded-md border px-2 py-1 font-medium',
          active ? 'border-stone-300 bg-stone-100' : 'border-amber-400 bg-amber-50 text-amber-900',
        )}
      >
        {!active && <option value="">{t.chooseSite}</option>}
        {user.sites.map((s) => (
          <option key={s.id} value={s.id}>
            {s.code} · {s.name}
            {s.active ? '' : ` (${t.inactiveSite})`}
          </option>
        ))}
      </select>
    </label>
  );
}
