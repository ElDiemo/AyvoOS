'use client';

import { cs } from '@/i18n/cs';

export function LogoutButton() {
  return (
    <button
      type="button"
      className="rounded-md px-3 py-2 text-sm font-medium text-stone-700 hover:bg-stone-200"
      onClick={async () => {
        await fetch('/auth/logout', { method: 'POST' }).catch(() => undefined);
        // eslint-disable-next-line @next/next/no-location-assign-relative-destination -- a full load drops all client state after the session ended
        window.location.assign('/login');
      }}
    >
      {cs.nav.logout}
    </button>
  );
}
